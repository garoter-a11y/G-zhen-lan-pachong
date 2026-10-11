#!/usr/bin/env node
/**
 * G-zhen-lan-pachong hunt — goal-directed reference finder.
 *
 * Solves "找不到我们要拿参考的文件": instead of blindly fetching the whole site,
 * hunt reads the asset map from discover.mjs, LIGHTLY probes candidate pages
 * (one GET each, title + visible-text head), scores them against what you are
 * looking for, and ranks them. Only hits get the expensive harvest/scrape pass.
 *
 * Pipeline:  discover → site-map.json
 *            hunt --target "..."  →  hunt-result.json / .md (ranked candidates)
 *            harvest/scrape on the top hits
 *
 * Usage:
 *   node bin/hunt.mjs --map DIR/site-map.json --target "登录 login" [--target "注册"]
 *        [--output DIR] [--max-probe N] [--top N] [--json] [-v]
 *
 * @module hunt
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveBinPaths, defaultOutputDir } from "./lib/router.mjs";
import { runTool } from "./lib/run.mjs";
import { curlProxyArgs } from "./lib/proxy.mjs";
import { rankCandidates, htmlTitle, registeredDomain, isInScope, DISCOVER_UA } from "./lib/discover-core.mjs";

const BIN = resolveBinPaths();

function parseArgs(argv) {
  const o = { targets: [], map: null, output: null, maxProbe: 60, top: 12, json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--map") o.map = argv[++i];
    else if (a === "--target" || a === "-t") o.targets.push(argv[++i]);
    else if (a === "--output" || a === "-o") o.output = argv[++i];
    else if (a === "--max-probe") o.maxProbe = Math.max(1, Math.min(300, parseInt(argv[++i], 10)));
    else if (a === "--top") o.top = parseInt(argv[++i], 10);
    else if (a === "--json") o.json = true;
    else if (a === "-v" || a === "--verbose") o.verbose = true;
    else if (!a.startsWith("-")) {
      // bare positional = map path or target, infer by look
      if (a.endsWith(".json")) o.map = a; else o.targets.push(a);
    }
  }
  if (!o.targets.length) {
    console.error('Usage: hunt.mjs --map site-map.json --target "登录 login" [--target "注册"]');
    process.exit(2);
  }
  return o;
}

const log = (...a) => process.stderr.write(`[hunt] ${a.join(" ")}\n`);

// One hop, no auto-follow. -w returns code and redirect target.
function curlHop(url) {
  const r = runTool(BIN.curl, [
    "-sS", "--max-time", "20", "--proto", "=http,https", "--max-filesize", "5000000",
    "-w", "\n__ZN__%{http_code} %{redirect_url}", "-H", `User-Agent: ${DISCOVER_UA}`,
    ...curlProxyArgs(url), "--", url,
  ], { timeout: 25000 });
  if (!r.ok || !r.stdout) return null;
  const nl = r.stdout.lastIndexOf("\n__ZN__");
  const body = r.stdout.slice(0, nl >= 0 ? nl : 0);
  const tail = nl >= 0 ? r.stdout.slice(nl + 7).trim() : "";
  const sp = tail.indexOf(" ");
  return { code: parseInt(tail.slice(0, sp), 10) || 0, location: tail.slice(sp + 1).trim(), body };
}

// Follow 3xx manually so a candidate that redirects OFF the registrable domain
// cannot make us score a third party's body. ≤5 hops, every hop scope-checked.
function fetchInScope(url, scope) {
  let cur = url;
  for (let hop = 0; hop < 5; hop++) {
    if (!isInScope(cur, scope)) return { crosshost: true };
    const r = curlHop(cur);
    if (!r) return null;
    if (r.code >= 300 && r.code < 400 && r.location) {
      try { cur = new URL(r.location, cur).href; } catch { return null; }
      if (!/^https?:/i.test(cur)) return null;
      continue;
    }
    return { code: r.code, body: r.body, redirected: hop > 0 };
  }
  return null;
}

function probe(url, scope) {
  const f = fetchInScope(url, scope);
  if (!f) return null;
  if (f.crosshost) return { status: 0, title: "", text: "", chars: 0, dead: true, crosshost: true };
  const status = f.code;
  const html = f.body || "";
  if (!html || status === 0 || status >= 400) return { status, title: "", text: "", chars: 0, dead: true };
  const title = htmlTitle(html);
  // visible text head: strip scripts/styles/tags, collapse whitespace
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);
  return { status, redirected: f.redirected, title, text, chars: html.length, dead: false };
}

function renderMd(targets, ranked, mapPath) {
  const hits = ranked.filter(r => r.band === "hit");
  const weak = ranked.filter(r => r.band === "weak");
  const L = [];
  L.push("# hunt 定位结果", "");
  L.push(`> 目标：${targets.map(t => `「${t}」`).join("、")}　·　地图：${mapPath}　·　${new Date().toISOString()}`);
  L.push(`> 强命中 ${hits.length}，沾边 ${weak.length}。强命中直接交 harvest/scrape 深采；沾边可人工瞄一眼。`);
  if (ranked.some(r => r.redirected)) L.push(`> 状态列 ↪ 表示该页经跳转后到达（如统一登录页），命中可能是跳转造成的，人工核一眼。`);
  L.push("");
  const row = r => `| ${r.score} | ${r.status || ""}${r.redirected ? " ↪" : ""} | [${(r.title || r.url).replace(/\|/g, "/")}](${r.url}) |`;
  if (hits.length) {
    L.push("## ✅ 强命中（最可能是要找的参考件）", "", "| 分 | 状态 | 页面 |", "|---|---|---|");
    hits.forEach(r => L.push(row(r)));
  }
  if (weak.length) {
    L.push("", "## 👀 沾边", "", "| 分 | 状态 | 页面 |", "|---|---|---|");
    weak.forEach(r => L.push(row(r)));
  }
  if (!hits.length && !weak.length) {
    L.push("## 无命中", "", "地图里的页面都不沾边。可：① 换关键词（中/英都试）② 先跑 discover --enumerate ③ 用 harvest 对已知 URL 直接采。");
  }
  L.push("", "## 下一步", "");
  L.push(hits[0]
    ? `\`node bin/harvest.mjs "${hits[0].url}" -s "footer,nav" -n "参考组件"\``
    : "（无强命中）");
  return L.join("\n");
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.map) { console.error("[hunt] --map site-map.json required (run discover.mjs first)"); process.exit(2); }
  if (!existsSync(o.map)) { console.error(`[hunt] map not found: ${o.map}`); process.exit(2); }
  const map = JSON.parse(readFileSync(o.map, "utf8"));
  const outDir = o.output || dirname(o.map);
  mkdirSync(outDir, { recursive: true });

  // candidate pool: mapped pages + SPA routes materialized against origin.
  // A site-map.json is data, not trust: require http(s) + same registrable
  // domain (defense against tampered maps injecting argv-like "URLs").
  const seedHost = (() => { try { return new URL(map.url || map.origin).hostname; } catch { return ""; } })();
  const scope = { seedHost, rootDomain: map.rootDomain || (seedHost ? registeredDomain(seedHost) : "") };
  const pool = new Set();
  for (const u of map.pages || []) {
    try {
      const abs = new URL(u, map.origin).href;
      if (isInScope(abs, scope)) pool.add(abs);
    } catch {}
  }
  for (const r of map.jsRoutes || []) {
    if (r.startsWith("/")) { try { const abs = new URL(r, map.origin).href; if (isInScope(abs, scope)) pool.add(abs); } catch {} }
  }
  let candidates = [...pool].map(url => ({ url, title: "", text: "" }));
  log(`${candidates.length} candidate pages from map; probing up to ${o.maxProbe}…`);

  // Pre-rank with URL-only signals so the probe budget goes to promising URLs first,
  // but still probe a baseline so title/text-only pages aren't missed.
  const pre = rankCandidates(candidates, o.targets);
  const ordered = pre.sort((a, b) => b.score - a.score).slice(0, o.maxProbe);

  const probed = [];
  let n = 0;
  for (const c of ordered) {
    n++;
    if (o.verbose) process.stderr.write(`[hunt] [${n}/${ordered.length}] ${c.url.substring(0, 80)}\n`);
    const p = probe(c.url, scope);
    if (p && !p.dead) probed.push({ url: c.url, title: p.title, text: p.text, status: p.status, redirected: p.redirected, chars: p.chars });
  }

  // final rank with title + visible text; carry HTTP status through
  const metaOf = new Map(probed.map(p => [p.url, { status: p.status, redirected: p.redirected }]));
  const ranked = rankCandidates(probed, o.targets).map(r => ({ ...r, ...(metaOf.get(r.url) || {}) }));
  const hits = ranked.filter(r => r.band !== "miss");
  const result = { targets: o.targets, map: o.map, at: new Date().toISOString(),
    probed: probed.length, ranked };
  writeFileSync(join(outDir, "hunt-result.json"), JSON.stringify(result, null, 2), "utf8");
  writeFileSync(join(outDir, "hunt-result.md"), renderMd(o.targets, ranked, o.map), "utf8");

  const hc = ranked.filter(r => r.band === "hit").length;
  log(`probed ${probed.length}/${candidates.length} → ${hc} hits → ${join(outDir, "hunt-result.md")}`);
  if (o.json) console.log(JSON.stringify({ output: outDir, probed: probed.length, hits: hc,
    top: ranked.slice(0, o.top).map(r => ({ score: r.score, band: r.band, title: r.title, url: r.url })) }, null, 2));
}

main();
