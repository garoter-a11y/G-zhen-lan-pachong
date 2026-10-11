/**
 * discover-core — pure parsers/scorers for site asset discovery.
 *
 * No network, no filesystem: every function is pure so it can be unit-tested
 * against local fixtures. The CLI wrapper (discover.mjs) does the actual I/O.
 *
 * Borrowed architecture (ARTEX postmortem 2026-10-12): an asset graph answers
 * "what exists on the target"; discovery here is READ-ONLY public information
 * (sitemaps, page links, JS routes, DNS, TCP connect). No login attempts, no
 * exploit traffic — offensive self-testing lives in the separate defense module.
 * @module discover-core
 */

/** Shared desktop UA for every outbound request in discover/hunt. */
export const DISCOVER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ── URL helpers ───────────────────────────────────────

export function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u;
  } catch { return null; }
}

export function registeredDomain(hostname) {
  // Naive eTLD+1 without a public-suffix list: last 2 labels. Good enough for
  // grouping *.example.com; known multi-part suffixes (.com.cn/.co.uk) collapse
  // to 3 labels.
  const h = (hostname || "").toLowerCase().replace(/\.$/, "");
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const multi = /\.(com|net|org|gov|edu|ac|co)\.(cn|uk|jp|kr|au|hk|tw)$/i.test(h);
  return parts.slice(multi ? -3 : -2).join(".");
}

/**
 * Extract same-registered-domain links from an HTML string (deduped, anchors
 * and non-http(s) schemes dropped). Cross-host links are intentionally excluded:
 * subdomain discovery uses extractSubdomains on raw text instead.
 * @returns {URL[]}
 */
export function extractLinks(html, baseUrl) {
  const internal = new Map();
  if (!html || typeof html !== "string") return [];
  const root = registeredDomain(new URL(baseUrl).hostname);
  const re = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const u = normalizeUrl(m[1], baseUrl);
    if (!u) continue;
    if (registeredDomain(u.hostname) === root && !internal.has(u.href)) internal.set(u.href, u);
  }
  return [...internal.values()];
}

/** Extract <script src> bundle URLs from HTML. */
export function extractJsBundles(html, baseUrl) {
  const out = new Map();
  if (!html || typeof html !== "string") return [];
  const re = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+\.js(?:\?[^"']*)?)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const u = normalizeUrl(m[1], baseUrl);
    if (u && !out.has(u.href)) out.set(u.href, u);
  }
  return [...out.values()];
}

/**
 * Pull route-like string literals out of a JS bundle.
 * Matches "/path/seg" and 'path/seg' literals that look like app routes
 * (starts with / or contains a path separator; has at least one letter).
 */
export function extractRoutesFromJs(code) {
  const routes = new Set();
  if (!code || typeof code !== "string") return [];
  const re = /["'`]((?:\/[a-z0-9_\-]+){1,6}(?:\/|\.html?)?)["'`]/gi;
  let m;
  while ((m = re.exec(code))) {
    const r = m[1];
    // skip static assets / source maps / node_modules noise
    if (/\.(png|jpe?g|gif|svg|webp|css|woff2?|ttf|map|mp[34]|json)$/i.test(r)) continue;
    if (r.includes("node_modules") || r.startsWith("/static/") || r.startsWith("/assets/")) continue;
    routes.add(r);
  }
  return [...routes].sort();
}

// ── sitemap / robots ──────────────────────────────────

/**
 * Parse sitemap XML. Handles urlset (page URLs) and sitemapindex (nested maps).
 * Classification follows the CONTAINER only: every <loc> in a sitemapindex is a
 * child sitemap, every <loc> in a urlset is a page — a page URL that happens to
 * contain "sitemap.xml" must not be mistaken for a nested map.
 * @returns {{urls:string[], childSitemaps:string[], isIndex:boolean}}
 */
export function parseSitemap(xml) {
  const urls = new Set();
  const childSitemaps = new Set();
  if (!xml || typeof xml !== "string" || xml.charCodeAt(0) === 0xfffd) {
    return { urls: [], childSitemaps: [], isIndex: false };
  }
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const raw = m[1].trim();
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      (isIndex ? childSitemaps : urls).add(u.href);
    } catch { /* skip junk */ }
  }
  return { urls: [...urls], childSitemaps: [...childSitemaps], isIndex };
}

/**
 * Parse robots.txt.
 * @returns {{sitemaps:string[], disallow:string[]}}
 */
export function parseRobots(txt) {
  const sitemaps = new Set();
  const disallow = new Set();
  if (!txt || typeof txt !== "string") return { sitemaps: [], disallow: [] };
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!value) continue;
    if (field === "sitemap") {
      try { const u = new URL(value); if (/^https?:$/.test(u.protocol)) sitemaps.add(u.href); } catch {}
    } else if (field === "disallow" && value !== "/" && value.length > 1) {
      disallow.add(value);
    }
  }
  return { sitemaps: [...sitemaps], disallow: [...disallow] };
}

// ── subdomains ────────────────────────────────────────

/**
 * Find hostnames belonging to the same registered root inside arbitrary text
 * (cert JSON, HTML, JS, link headers).
 */
export function extractSubdomains(text, rootDomain) {
  const root = (rootDomain || "").toLowerCase().replace(/\.$/, "");
  const out = new Set();
  if (!text || !root) return [];
  const re = /([a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)+)/gi;
  let m;
  while ((m = re.exec(text))) {
    const h = m[1].toLowerCase();
    if (h === root || h.endsWith("." + root)) out.add(h);
  }
  return [...out].sort();
}

// ── hunt scoring ──────────────────────────────────────

const GENERIC_PATH_WORDS = /(page|p|id|view|article|news|post|item|detail)/i;

/** Tokenize a target query into scored terms (CJK chars + ascii words). */
export function targetTerms(query) {
  const q = (query || "").toLowerCase();
  const ascii = q.match(/[a-z0-9][a-z0-9\-_]{1,}/g) || [];
  const cjk = [...new Set(q.match(/[一-鿿]/g) || [])];
  // Adjacent pairs taken from the ORIGINAL CJK sequence (sliding window), not
  // from the deduped char set — cross-word pairs otherwise create false hits.
  const seq = q.match(/[一-鿿]+/g) || [];
  const pairs = new Set();
  for (const run of seq) for (let i = 0; i < run.length - 1; i++) pairs.add(run.slice(i, i + 2));
  return { ascii: [...new Set(ascii)], cjk, cjkPairs: [...pairs] };
}

/**
 * Score a candidate URL + page-title/anchor text against a hunt target.
 * Higher = better. Pure. The CLI only deep-fetches the top N.
 * @param {{url:string, title?:string, text?:string, source?:string}} cand
 * @param {{ascii:string[], cjk:string[]}} terms
 * @returns {number}
 */
export function scoreCandidate(cand, terms) {
  const url = (cand.url || "").toLowerCase();
  const path = (() => { try { return decodeURIComponent(new URL(url).pathname.toLowerCase()); } catch { return url; } })();
  const hay = `${path} ${(cand.title || "").toLowerCase()} ${(cand.text || "").toLowerCase()}`;
  let score = 0;
  for (const w of terms.ascii) {
    if (path.includes(w)) score += 3;
    if (hay.includes(w)) score += 1;
  }
  // CJK: adjacent pairs from the original query are the strong signal.
  for (const pair of terms.cjkPairs || []) {
    if (hay.includes(pair)) score += 3;
  }
  if (cand.title && terms.cjk.some(c => cand.title.includes(c))) score += 1;
  // Prefer leaf pages over generic paginated/article URLs when hunting a component
  if (GENERIC_PATH_WORDS.test(path)) score -= 1;
  if (/\b(login|signin|auth|admin|dashboard|pricing|download)\b/.test(path) && terms.ascii.length) score += 1;
  return score;
}

/**
 * Rank candidates (each {url,title?,text?}) against one or more target queries.
 * Pure. Ties are broken by shorter path (leaf pages usually more specific).
 * @returns {{url:string,title:string,score:number,band:"hit"|"weak"|"miss"}[]}
 */
export function rankCandidates(candidates, queries) {
  const termSets = (queries || []).map(targetTerms);
  return candidates.map(c => {
    let score = 0;
    for (const t of termSets) score += scoreCandidate(c, t);
    let pathLen = 99;
    try { pathLen = new URL(c.url).pathname.length; } catch {}
    return { url: c.url, title: c.title || "", score, pathLen };
  }).sort((a, b) => b.score - a.score || a.pathLen - b.pathLen)
    .map(({ url, title, score }) => ({
      url, title, score,
      band: score >= 4 ? "hit" : score >= 1 ? "weak" : "miss",
    }));
}

// ── scope guard (SSRF defense) ─────────────────────────

/** Private / loopback / link-local / reserved IPv4/IPv6 literals. */
export function isPrivateHost(hostname) {
  let h = (hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::" || h === "::1") return true;
  let mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i); // URL-normalized form
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    mapped = [null, [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".")];
  }
  if (mapped) h = mapped[1];
  if (h.includes(":")) {
    return h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("::");
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [, a, b] = m.map(Number);
  return a === 0 || a === 127 || a === 10 || a === 169 && b === 254 ||
    a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
}

/**
 * Is URL allowed to be fetched for this scan? Same registrable domain as the
 * seed, or the exact seed host (which also permits self 打靶 at a private IP).
 * Any other private/reserved/link-local host is refused, blocking sitemap- or
 * redirect-driven SSRF to 169.254.169.254 / intranet addresses.
 */
export function isInScope(rawUrl, { seedHost, rootDomain } = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === seedHost) return true; // exact seed (incl. private 打靶 target)
  if (isPrivateHost(host)) return false;
  return registeredDomain(host) === rootDomain;
}

/** Extract <title> from HTML, trimmed. */
export function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || "");
  return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 120) : "";
}
