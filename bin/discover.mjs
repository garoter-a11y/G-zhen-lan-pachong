#!/usr/bin/env node
/**
 * G-zhen-lan-pachong discover — build a read-only site asset map.
 *
 * Answers "what exists on this site" BEFORE crawling blindly:
 *   1. robots.txt + sitemap.xml (BFS recursion through sitemapindex, .gz ok)
 *   2. homepage HTML  → internal links + JS bundles
 *   3. JS bundles     → route literals (finds SPA pages with no <a>)
 *   4. passive subdomains → crt.sh certificate transparency + names in HTML/JS
 *   5. TCP port probe  → built-in net.connect (nmap auto-used when installed)
 *   6. loud guessing   → ONLY with --enumerate --confirm-loud (own/authorized
 *      targets; common subdomain names + admin paths with soft-404 baseline)
 *
 * READ-ONLY. No login attempts, no exploit traffic. Every fetched URL must be
 * http(s), in-scope (same registrable domain as seed), and not a private host
 * unless the seed itself is private (self 打靶). This blocks sitemap/robots-
 * driven SSRF to cloud metadata / intranet addresses.
 * Offensive self-testing of our own apps belongs to the separate defense module.
 *
 * Usage:
 *   node bin/discover.mjs <url> [--output DIR] [--json] [-v]
 *        [--ports web|common|none] [--scan-subdomains]
 *        [--enumerate --confirm-loud] [--wordlist FILE] [--no-crt] [--sitemap-depth N]
 *
 * @module discover
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import dns from "node:dns/promises";
import { gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { resolveBinPaths, defaultOutputDir } from "./lib/router.mjs";
import { runTool } from "./lib/run.mjs";
import { curlProxyArgs } from "./lib/proxy.mjs";
import {
  registeredDomain, extractLinks, extractJsBundles, extractRoutesFromJs,
  parseSitemap, parseRobots, extractSubdomains, isInScope, DISCOVER_UA,
} from "./lib/discover-core.mjs";

const BIN = resolveBinPaths();

const WEB_PORTS = [80, 443, 8080, 8443, 8000, 8888, 3000, 5000, 9000];
const COMMON_PORTS = [21, 22, 23, 25, 53, 110, 143, 3306, 3389, 5432, 6379, 27017, ...WEB_PORTS];
const SUBDOMAIN_WORDS = ["www", "m", "mobile", "admin", "api", "app", "test", "dev", "staging",
  "stage", "beta", "vpn", "mail", "oa", "git", "jenkins", "gitlab", "wiki", "docs", "static",
  "cdn", "img", "images", "backup", "db", "portal", "manage", "console", "gateway", "internal"];
const ADMIN_PATHS = ["/admin", "/admin/", "/login", "/manage", "/console", "/dashboard",
  "/backend", "/system", "/wp-admin/", "/phpmyadmin/", "/.env", "/.git/config", "/server-status",
  "/actuator/health", "/swagger-ui/", "/api-docs", "/backup.zip"];

function parseArgs(argv) {
  const o = { _: [], output: null, ports: "web", enumerate: false, confirmLoud: false,
    wordlist: null, crt: true, scanSubdomains: false, sitemapDepth: 3, json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--output" || a === "-o") o.output = argv[++i];
    else if (a === "--ports") o.ports = argv[++i];
    else if (a === "--enumerate") o.enumerate = true;
    else if (a === "--confirm-loud" || a === "--yes-i-am-authorized") o.confirmLoud = true;
    else if (a === "--wordlist") o.wordlist = argv[++i];
    else if (a === "--no-crt") o.crt = false;
    else if (a === "--scan-subdomains") o.scanSubdomains = true;
    else if (a === "--sitemap-depth") {
      const d = parseInt(argv[++i], 10);
      if (Number.isInteger(d) && d >= 0 && d <= 8) o.sitemapDepth = d;
      else process.stderr.write(`[discover] --sitemap-depth 非法（${d}），用默认 3\n`);
    }
    else if (a === "--json") o.json = true;
    else if (a === "-v" || a === "--verbose") o.verbose = true;
    else if (!a.startsWith("-")) o._.push(a);
  }
  if (o._.length === 0) {
    console.error("Usage: discover.mjs <url> [--ports web|common|none] [--enumerate --confirm-loud] [--json] [-v]");
    process.exit(2);
  }
  if (o.enumerate && !o.confirmLoud) {
    console.error("[discover] --enumerate 请求量大、会在对方日志留痕，属高动静动作。");
    console.error("           确认目标是自有/已书面授权资产，请再加 --confirm-loud 双闸确认。");
    process.exit(2);
  }
  if (!o.output) o.output = defaultOutputDir(o._[0]);
  return o;
}

const log = (o, ...a) => { if (o.verbose) process.stderr.write(`[discover] ${a.join(" ")}\n`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * One curl round, NO auto-follow (followUrl does in-JS scope-checked hops).
 * binary=true → body written to a temp file (curl -o) and read back as Buffer;
 * required for gzip because spawnSync utf8 decoding destroys non-UTF8 bytes.
 */
function curlOnce(url, { binary = false } = {}) {
  if (!/^https?:\/\//i.test(url)) return null;
  const tmp = binary ? join(tmpdir(), `zn-disc-${randomBytes(6).toString("hex")}`) : null;
  const args = ["-sS", "--max-time", "25", "--proto", "=http,https",
    "--max-filesize", "5000000", "-H", `User-Agent: ${DISCOVER_UA}`];
  if (tmp) args.push("-o", tmp);
  args.push(...curlProxyArgs(url),
    "-w", "\n__ZN__%{http_code} %{num_redirects} %{redirect_url}", "--", url);
  const r = runTool(BIN.curl, args, { timeout: 30000 });
  if (!r.ok) { if (tmp && existsSync(tmp)) try { unlinkSync(tmp); } catch {} return null; }
  const out = r.stdout || "";
  const marker = out.lastIndexOf("\n__ZN__");
  const body = tmp ? null : out.slice(0, marker >= 0 ? marker : 0);
  const tail = marker >= 0 ? out.slice(marker + 7).trim() : "";
  const [codeStr, , ...redirParts] = tail.split(" ");
  const code = parseInt(codeStr, 10) || 0;
  const redirectUrl = redirParts.join(" ") || "";
  let buffer = null;
  if (tmp) { try { buffer = readFileSync(tmp); } catch {} try { unlinkSync(tmp); } catch {} }
  return { code, body, buffer, redirectUrl };
}

/** Follow 3xx within scope, max 5 hops. */
function followUrl(url, scope, { binary = false } = {}) {
  let cur = url;
  for (let hop = 0; hop < 5; hop++) {
    if (!isInScope(cur, scope)) return null;
    const r = curlOnce(cur, { binary: binary && hop === 0 });
    if (!r) return null;
    if (r.code >= 300 && r.code < 400 && r.redirectUrl) {
      let next;
      try { next = new URL(r.redirectUrl, cur).href; } catch { return null; }
      if (!/^https?:/i.test(next)) return null;
      cur = next;
      continue;
    }
    return { ...r, url: cur };
  }
  return null;
}

// Text GET with scope-checked redirect following. Returns body or null.
function httpGet(url, scope) {
  const r = followUrl(url, scope);
  return r && r.code >= 200 && r.code < 300 ? r.body : null;
}

// ── DNS / ports ───────────────────────────────────────

async function resolveHost(host) {
  try { return await dns.resolve4(host); } catch { return []; }
}

function tcpProbe(host, port, timeout = 2500) {
  return new Promise(resolve => {
    const sock = net.createConnection({ host, port, timeout });
    let settled = false;
    const done = open => { if (!settled) { settled = true; sock.destroy(); resolve(open); } };
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

async function probePorts(host, ports) {
  const open = [];
  for (const p of ports) if (await tcpProbe(host, p)) open.push(p);
  return open;
}

function hasNmap() {
  return runTool("nmap", ["--version"], { timeout: 8000 }).ok;
}

function nmapScan(host, profile) {
  // derive from the same lists the built-in prober uses — no hand-copied drift
  const ports = (profile === "common" ? COMMON_PORTS : WEB_PORTS).join(",");
  const r = runTool("nmap", ["-sT", "-Pn", "--open", "-p", ports, "-oG", "-", host], { timeout: 180000 });
  const open = [];
  if (r.ok) {
    const m = r.stdout.match(/Ports:\s*(.+)/);
    if (m) for (const part of m[1].split(";")) {
      const pm = part.trim().match(/^(\d+)\/open\/tcp\/\/([^/]*)?/);
      if (pm) open.push({ port: +pm[1], service: (pm[2] || "").trim() });
    }
  }
  return r.ok ? open : null;
}

// ── sitemap discovery (BFS by tree level) ─────────────

async function fetchSitemaps(origin, declaredSitemaps, maxDepth, scope, o) {
  const pageUrls = new Set();
  const seen = new Set();
  let frontier = new Set(["/sitemap.xml"]);
  for (const s of declaredSitemaps) frontier.add(s.startsWith("http") ? s : new URL(s, origin).href);
  let files = 0;

  for (let level = 0; level <= maxDepth && frontier.size; level++) {
    const current = [...frontier];
    const next = new Set();
    for (const sm of current) {
      const abs = sm.startsWith("http") ? sm : new URL(sm, origin).href;
      if (seen.has(abs) || !isInScope(abs, scope)) {
        if (!isInScope(abs, scope)) log(o, `sitemap 越界，丢弃: ${abs}`);
        continue;
      }
      seen.add(abs);
      let body = null;
      if (/\.gz($|\?)/i.test(abs)) {
        const r = followUrl(abs, scope, { binary: true });
        if (r && r.buffer) { try { body = gunzipSync(r.buffer).toString("utf8"); } catch { log(o, `gunzip 失败: ${abs}`); } }
      } else {
        body = httpGet(abs, scope);
      }
      if (!body) continue;
      files++;
      const parsed = parseSitemap(body);
      parsed.urls.forEach(u => pageUrls.add(u));
      // only a sitemapindex container produces children, one tree level down
      if (parsed.isIndex && level < maxDepth) parsed.childSitemaps.forEach(u => {
        if (!seen.has(u)) next.add(u);
      });
    }
    frontier = next;
  }
  log(o, `sitemap: ${pageUrls.size} page urls from ${files} sitemap file(s), depth<=${maxDepth}`);
  return [...pageUrls];
}

// ── passive subdomains ────────────────────────────────

async function crtShSubdomains(root, o) {
  // fixed HTTPS endpoint, not scope-bound; caller already gates on o.crt
  const r = curlOnce(`https://crt.sh/?q=%25.${root}&output=json`);
  if (!r || r.code !== 200) { log(o, "crt.sh unreachable (proxy?) — skipped"); return []; }
  try {
    const out = new Set();
    for (const row of JSON.parse(r.body)) {
      extractSubdomains(`${row.common_name || ""}\n${row.name_value || ""}`, root).forEach(h => out.add(h));
    }
    return [...out];
  } catch { return []; }
}

// ── render the map ────────────────────────────────────

function renderMarkdown(map) {
  const L = [];
  L.push(`# 站点资产图：${map.host}`, "");
  L.push(`> discover.mjs 只读侦察 · ${map.generatedAt} · 数据源 ${map.sources.join(" / ")}`, "");
  L.push(`- 根注册域：${map.rootDomain}`);
  L.push(`- 主站 IP：${map.mainIps.join(", ") || "解析失败（境外站走代理时本地 DNS 可能无解，页面发现不受影响）"}`);
  L.push(`- 开放端口：${map.ports.length ? map.ports.map(p => typeof p === "object" ? `${p.port}/${p.service || "?"}` : p).join(", ") : "无 / 未扫"}`);
  L.push(`- 站点页面（sitemap/链接/JS路由去重后）：**${map.pages.length}**`);
  L.push(`- 子域：${map.subdomains.length}`);
  if (map.robotsDisallow.length) L.push(`- robots.txt 禁止收录：${map.robotsDisallow.map(d => `\`${d}\``).join(" ")}`);
  if (map.enumeratedPaths.length) L.push(`- 猜查命中的后台路径：${map.enumeratedPaths.length}（已剔除软 404）`);
  L.push("", "## 页面清单", "");
  for (const p of map.pages.sort()) L.push(`- ${p}`);
  if (map.jsRoutes.length) {
    L.push("", "## JS bundle 中发现的前端路由（SPA 深页，无 <a> 链接）", "");
    for (const r of map.jsRoutes) L.push(`- ${r}`);
  }
  if (map.subdomains.length) {
    L.push("", "## 子域", "", "| 主机名 | IP | 开放端口 | 来源 |", "|---|---|---|---|");
    for (const s of map.subdomains) L.push(`| ${s.host} | ${s.ips.join(", ")} | ${(s.openPorts || []).join(", ") || "-"} | ${s.sources.join("+")} |`);
  }
  if (map.enumeratedPaths.length) {
    L.push("", "## 猜查命中路径（--enumerate --confirm-loud，授权目标用）", "");
    for (const p of map.enumeratedPaths) L.push(`- ${p.status} ${p.path}${p.note ? `（${p.note}）` : ""}`);
  }
  return L.join("\n");
}

// ── main ──────────────────────────────────────────────

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let seed;
  try { seed = new URL(o._[0]); } catch { console.error(`[discover] 非法 URL: ${o._[0]}`); process.exit(2); }
  if (seed.protocol !== "http:" && seed.protocol !== "https:") {
    console.error(`[discover] 只允许 http(s) 目标，拒绝协议 ${seed.protocol}（防 file:// 等本地读取）`);
    process.exit(2);
  }
  const origin = seed.origin;
  const host = seed.hostname;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const root = isIp ? host : registeredDomain(host);
  const scope = { seedHost: host, rootDomain: root };
  mkdirSync(o.output, { recursive: true });
  const sources = ["robots", "sitemap", "homepage", "js-routes"];

  process.stderr.write(`[discover] mapping ${origin} (root: ${root})\n`);

  // DNS + ports
  const mainIps = await resolveHost(host);
  log(o, `DNS ${host} → ${mainIps.join(", ") || "NXDOMAIN"}`);
  let ports = [];
  if (o.ports !== "none" && mainIps.length) {
    const profile = o.ports === "common" ? "common" : "web";
    if (hasNmap()) {
      const nm = nmapScan(host, profile);
      if (nm) { ports = nm; sources.push("nmap"); }
      else ports = await probePorts(host, profile === "common" ? COMMON_PORTS : WEB_PORTS);
    } else {
      ports = await probePorts(host, profile === "common" ? COMMON_PORTS : WEB_PORTS);
    }
    sources.push("tcp-connect");
    process.stderr.write(`[discover] open ports: ${ports.map(p => typeof p === "object" ? p.port : p).join(", ") || "none"}\n`);
  }

  // robots (fixed first-party URL, in scope by construction)
  const robotsTxt = httpGet(`${origin}/robots.txt`, scope) || "";
  const robots = parseRobots(robotsTxt);

  // sitemaps (scope-checked inside BFS; children must stay on registrable domain)
  const sitemapUrls = await fetchSitemaps(origin, robots.sitemaps, o.sitemapDepth, scope, o);
  const pages = new Set(sitemapUrls);

  // homepage + JS routes
  const homeUrl = origin + (seed.pathname !== "/" ? seed.pathname : "/");
  const home = httpGet(homeUrl, scope) || "";
  extractLinks(home, origin).forEach(u => { if (isInScope(u.href, scope)) pages.add(u.href); });
  const bundles = extractJsBundles(home, origin).filter(u => isInScope(u.href, scope));
  const jsRoutes = new Set();
  const seenInText = new Set();
  for (const b of bundles.slice(0, 12)) {
    const code = httpGet(b.href, scope);
    if (!code) continue;
    extractRoutesFromJs(code).forEach(r => jsRoutes.add(r));
    extractSubdomains(code, root).forEach(h => seenInText.add(h));
  }
  for (const r of jsRoutes) {
    if (r.startsWith("/")) { try { const u = new URL(r, origin).href; if (isInScope(u, scope)) pages.add(u); } catch {} }
  }

  // passive subdomains (root-bound extraction; only meaningful for domain seeds)
  const subSet = new Map();
  const addSub = (h, src) => {
    const e = subSet.get(h) || { host: h, ips: [], sources: [] };
    if (!e.sources.includes(src)) e.sources.push(src);
    subSet.set(h, e);
  };
  if (!isIp) {
    extractSubdomains(home, root).forEach(h => addSub(h, "homepage"));
    seenInText.forEach(h => addSub(h, "js"));
    if (o.crt) {
      const crt = await crtShSubdomains(root, o);
      crt.forEach(h => addSub(h, "crt.sh"));
      if (crt.length) sources.push("crt.sh");
    }
  }

  // optional loud enumeration (double gate: --enumerate --confirm-loud)
  const enumeratedPaths = [];
  if (o.enumerate) {
    sources.push("enumerate");
    process.stderr.write("[discover] 高动静清单猜查开启：仅限自有/已授权目标，慢速进行\n");
    let words = SUBDOMAIN_WORDS;
    if (o.wordlist && existsSync(o.wordlist)) {
      words = readFileSync(o.wordlist, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
    if (!isIp) for (const w of words) {
      const ips = await resolveHost(`${w}.${root}`);
      if (ips.length) addSub(`${w}.${root}`, "wordlist");
      await sleep(80);
    }
    // soft-404 baseline: random nonexistent path defines the site's "not found" shape
    const basePath = `/__zn_${randomBytes(4).toString("hex")}__.htm`;
    const base = curlOnce(origin + basePath);
    const baseCode = base ? base.code : 404;
    const baseLen = base && base.body ? base.body.length : 0;
    const isSoft404 = r => r.code === baseCode && Math.abs((r.body || "").length - baseLen) < Math.max(64, baseLen * 0.2);
    for (const path of ADMIN_PATHS) {
      const r = curlOnce(origin + path);
      await sleep(120);
      if (!r || r.code === 0 || r.code === 404 || isSoft404(r)) continue;
      const note = r.code === 401 || r.code === 403 ? "需认证（存在性强信号）" : "";
      enumeratedPaths.push({ path, status: r.code, note });
    }
  }

  const subdomains = [...subSet.values()];
  for (const s of subdomains) s.ips = await resolveHost(s.host);
  if (o.scanSubdomains) {
    for (const s of subdomains) {
      if (!s.ips.length) continue;
      s.openPorts = await probePorts(s.host, WEB_PORTS);
      await sleep(50);
    }
  }

  const map = {
    generatedAt: new Date().toISOString(), url: o._[0], origin, host, rootDomain: root,
    mainIps, ports, pages: [...pages].sort(), jsRoutes: [...jsRoutes].sort(),
    subdomains, enumeratedPaths, sources, robotsDisallow: robots.disallow,
  };

  writeFileSync(join(o.output, "site-map.json"), JSON.stringify(map, null, 2), "utf8");
  writeFileSync(join(o.output, "site-map.md"), renderMarkdown(map), "utf8");

  process.stderr.write(`[discover] done: ${pages.size} pages, ${jsRoutes.size} SPA routes, ` +
    `${subdomains.length} subdomains → ${join(o.output, "site-map.md")}\n`);
  if (o.json) console.log(JSON.stringify({ output: o.output, pages: pages.size,
    spaRoutes: jsRoutes.size, subdomains: subdomains.length, ports: map.ports.length }));
}

main().catch(e => { console.error(`[discover] fatal: ${e.stack || e.message}`); process.exit(2); });
