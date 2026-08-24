#!/usr/bin/env node
/**
 * G-zhen-lan-pachong crawl — site-wide scraping via katana + per-page scrape.
 *
 * Pipeline:
 *   1. katana map   → discover all same-domain URLs (fast, headless-capable)
 *   2. dedupe + same-host filter + apply depth/limit
 *   3. for each URL: run scrape.mjs logic (curl+trafilatura → playwright → firecrawl)
 *   4. write {output}/{path}/index.md  +  _manifest.json
 *
 * Usage:
 *   node bin/crawl.mjs <url> [--output DIR] [--depth N] [--limit N]
 *        [--concurrency N] [--delay MS] [--js] [--firecrawl] [--format markdown|html|text]
 *        [--same-domain] [--include GLOB] [--exclude GLOB] [--json] [-v]
 *
 * @module crawl
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinPaths, planStrategy, defaultOutputDir } from "./lib/router.mjs";
import { runTool } from "./lib/run.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolveBinPaths();

function parseArgs(argv) {
  const out = {
    _: [], output: null, depth: 2, limit: 100, concurrency: 3, delay: 300,
    js: false, format: "markdown", sameDomain: true,
    include: null, exclude: null, firecrawl: false, json: false, verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--output" || a === "-o") out.output = argv[++i];
    else if (a === "--depth") out.depth = parseInt(argv[++i], 10);
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "--concurrency" || a === "-c") out.concurrency = Math.max(1, Math.min(8, parseInt(argv[++i], 10)));
    else if (a === "--delay") out.delay = parseInt(argv[++i], 10);
    else if (a === "--js") out.js = true;
    else if (a === "--firecrawl") out.firecrawl = true;
    else if (a === "--format" || a === "-f") out.format = argv[++i];
    else if (a === "--all-domains") out.sameDomain = false;
    else if (a === "--include") out.include = argv[++i];
    else if (a === "--exclude") out.exclude = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "-v" || a === "--verbose") out.verbose = true;
    else if (!a.startsWith("-")) out._.push(a);
  }
  if (out._.length === 0) {
    console.error("Usage: crawl.mjs <url> [--output DIR] [--depth N] [--limit N] [--js] [--concurrency N] [--delay MS]");
    process.exit(2);
  }
  if (!out.output) out.output = defaultOutputDir(out._[0]);
  return out;
}

function log(opts, ...args) { if (opts.verbose) console.error("[crawl]", ...args); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── katana map ────────────────────────────────────────

function katanaMap(url, opts) {
  const args = [
    "-u", url,
    "-d", String(opts.depth),
    "-c", String(opts.concurrency),
    "-rl", "30",                 // 30 req/sec
    "-timeout", "15",
    "-silent",
    "-nc",                       // no color
  ];
  // Same-domain scope: -cs takes a regex. Default -fs=rdn covers the registered
  // domain (www.example.com + app.example.com); for strict same-host, add -cs.
  if (opts.sameDomain) {
    try {
      const host = new URL(url).hostname.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      args.push("-cs", host);
    } catch {}
  }
  if (opts.js) {
    args.push("-headless");
  }
  if (opts.exclude) {
    args.push("-ef", opts.exclude);
  }
  log(opts, `katana: ${BIN.katana} ${args.join(" ")}`);
  const r = runTool(BIN.katana, args, { timeout: 300000 });
  if (!r.ok && r.stdout.trim().length === 0) {
    throw new Error(`katana failed: ${r.stderr || r.error || "unknown error"}`);
  }
  return r.stdout.split("\n").map(s => s.trim()).filter(Boolean);
}

// ── URL filtering ─────────────────────────────────────

function globToRe(glob) {
  return new RegExp(glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."), "i");
}

// Extensions that are never page content — filtered by default.
const STATIC_EXT = /\.(css|js|mjs|json|xml|rss|atom|png|jpe?g|gif|svg|webp|ico|bmp|tiff?|mp[34]|wav|ogg|webm|mov|avi|mkv|pdf|zip|rar|7z|tar|gz|woff2?|ttf|eot|otf|map|wasm)$/i;

function filterUrls(urls, seedUrl, opts) {
  const seed = new URL(seedUrl);
  const includeRe = opts.include ? globToRe(opts.include) : null;
  const excludeRe = opts.exclude ? globToRe(opts.exclude) : null;
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    let parsed;
    try { parsed = new URL(u); } catch { continue; }
    if (opts.sameDomain && parsed.hostname !== seed.hostname) continue;
    if (STATIC_EXT.test(parsed.pathname)) continue;
    if (includeRe && !includeRe.test(parsed.pathname)) continue;
    if (excludeRe && excludeRe.test(parsed.pathname)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= opts.limit) break;
  }
  return out;
}

// ── per-page scrape (in-process, no shell call) ───────

function curlFetch(url) {
  const r = runTool(BIN.curl, [
    "-sL", "--max-time", "25",
    "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    url,
  ], { timeout: 30000 });
  return r.ok && r.stdout.length > 200 ? r.stdout : null;
}

function trafilaturaExtract(html, url, format) {
  const r = runTool(BIN.python, [join(__dirname, "extract.py"), "--format", format === "text" ? "txt" : format, "--url", url], {
    timeout: 30000, input: html,
  });
  return r.ok && r.stdout.trim().length > 50 ? r.stdout.trim() : null;
}

function playwrightRender(url, waitMs, scroll) {
  const args = [join(__dirname, "render.py"), url, "--wait", String(waitMs)];
  if (scroll) args.push("--scroll");
  const r = runTool(BIN.python, args, { timeout: 90000 });
  return r.ok && r.stdout.length > 200 ? r.stdout : null;
}

function firecrawlScrape(url, format) {
  const args = ["scrape", url];
  if (format === "markdown") args.push("--markdown");
  else if (format === "html") args.push("--html");
  const r = runTool(BIN.firecrawl, args, { timeout: 60000 });
  return r.ok && r.stdout.trim().length > 50 ? r.stdout.trim() : null;
}

function scrapeOne(url, opts) {
  const errors = {};
  // tier 1: curl + trafilatura (fast, local; ideal for the SSR doc/blog sites crawl targets)
  let html = curlFetch(url);
  if (html) {
    const extracted = trafilaturaExtract(html, url, opts.format);
    if (extracted) return { url, method: "curl+trafilatura", content: extracted, errors };
    errors.curl_extract = "no main content";
  } else {
    errors.curl = "fetch failed";
  }
  // tier 2: Playwright render (only with --js; headless Chromium per page is slow for bulk)
  if (opts.js) {
    html = playwrightRender(url, 2500, true);
    if (html) {
      const extracted = trafilaturaExtract(html, url, opts.format);
      if (extracted) return { url, method: "playwright+trafilatura", content: extracted, errors };
      errors.pw_extract = "no main content";
    } else {
      errors.playwright = "render failed";
    }
  }
  // tier 3: firecrawl SaaS (only with --firecrawl; per-page cloud calls are slow/rate-limited)
  if (opts.firecrawl) {
    const content = firecrawlScrape(url, opts.format);
    if (content) return { url, method: "firecrawl", content, errors };
    errors.firecrawl = "no content";
  }
  // NOTE: monolith/screenshot are intentionally NOT in the crawl chain — they don't produce
  // extractable text and a self-contained HTML per page is too heavy for a 100-page crawl.
  return { url, method: null, content: null, errors };
}

// ── output path from URL ──────────────────────────────

function urlToRelPath(url, format) {
  try {
    const u = new URL(url);
    let seg = (u.pathname || "/").replace(/^\/+|\/+$/g, "").replace(/[<>:"|?*\\]/g, "_");
    if (!seg) seg = "index";
    // Remove .html/.htm suffix to create directory/index structure
    seg = seg.replace(/\.(html?|php|aspx?|jsp)$/i, "");
    const ext = format === "html" ? "html" : format === "text" ? "txt" : "md";
    return join(seg, `index.${ext}`);
  } catch {
    return join("index", `index.${format === "html" ? "html" : "md"}`);
  }
}

// ── main ──────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = args._[0];
  const plan = planStrategy(seed, { scope: "site", format: args.format, depth: args.depth, limit: args.limit });

  mkdirSync(args.output, { recursive: true });

  // 1. map
  console.error(`[crawl] mapping ${seed} (depth=${args.depth}, js=${args.js})...`);
  let urls;
  try {
    urls = katanaMap(seed, args);
  } catch (e) {
    console.error(`[crawl] katana failed: ${e.message}`);
    console.error("[crawl] falling back to seed URL only");
    urls = [seed];
  }

  // Always include seed
  if (!urls.includes(seed)) urls.unshift(seed);
  const filtered = filterUrls(urls, seed, args);
  console.error(`[crawl] ${filtered.length} URLs to scrape (of ${urls.length} discovered)`);

  // 2. scrape sequentially with delay (avoid hammering; concurrency via katana only)
  const manifest = { seed, scrapedAt: new Date().toISOString(), total: filtered.length, pages: [], failures: [] };
  let ok = 0, fail = 0;

  for (let i = 0; i < filtered.length; i++) {
    const url = filtered[i];
    process.stderr.write(`[crawl] [${i + 1}/${filtered.length}] ${url.substring(0, 80)}... `);
    try {
      const res = scrapeOne(url, args);
      if (res.content) {
        const rel = urlToRelPath(url, args.format);
        const outPath = join(args.output, rel);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, res.content, "utf8");
        manifest.pages.push({ url, method: res.method, file: rel, chars: res.content.length });
        ok++;
        process.stderr.write(`✓ ${res.method} (${res.content.length} chars)\n`);
      } else {
        manifest.failures.push({ url, errors: res.errors });
        fail++;
        process.stderr.write(`✗ ${Object.keys(res.errors).join(",")}\n`);
      }
    } catch (e) {
      manifest.failures.push({ url, errors: { exception: e.message } });
      fail++;
      process.stderr.write(`✗ exception: ${e.message}\n`);
    }
    if (args.delay && i < filtered.length - 1) await sleep(args.delay);
  }

  // 3. write manifest
  manifest.ok = ok;
  manifest.fail = fail;
  writeFileSync(join(args.output, "_manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.error(`[crawl] done: ${ok} ok, ${fail} failed → ${args.output}`);

  if (args.json) {
    console.log(JSON.stringify({ output: args.output, total: filtered.length, ok, fail, manifest: join(args.output, "_manifest.json") }, null, 2));
  }
  process.exit(fail > ok ? 1 : 0);
}

main().catch(err => {
  console.error(`[crawl] fatal: ${err.message}`);
  process.exit(2);
});
