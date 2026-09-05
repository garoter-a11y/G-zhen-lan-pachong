#!/usr/bin/env node
/**
 * G-zhen-lan-pachong harvest — UI-component collection (built-in line).
 *
 * Opens a page (URL or local .html) with Playwright, injects the self-written
 * collector, harvests one or more CSS selectors, and writes each component as a
 * sanitized "component replication task sheet" (.md) for the design step
 * (箴UI craft) to re-implement in the project's own DESIGN.md tokens.
 *
 * Counterpart to the browser-plugin line (Com-Pick human point-and-pick):
 * this line is reproducible, scriptable, batchable, and — for same-origin
 * stylesheets — preserves original @media / :hover rules that a computed-style
 * snapshot cannot.
 *
 * Usage:
 *   node bin/harvest.mjs <url-or-file> --selector "footer.newsletter"
 *        [--selector ".card"] [--name "newsletter-footer"] [--name "card"]
 *        [--output DIR] [--wait MS] [--viewport WxH] [--json] [-v]
 *
 * @module harvest
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { resolveBinPaths, defaultOutputDir } from "./lib/router.mjs";
import { runTool } from "./lib/run.mjs";
import { buildComponentMarkdown, componentFileName } from "./lib/component-md.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolveBinPaths();

function parseArgs(argv) {
  const out = { _: [], selectors: [], names: [], output: null, wait: 2500, viewport: "1440x900", json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selector" || a === "-s") out.selectors.push(argv[++i]);
    else if (a === "--name" || a === "-n") out.names.push(argv[++i]);
    else if (a === "--output" || a === "-o") out.output = argv[++i];
    else if (a === "--wait") out.wait = parseInt(argv[++i], 10);
    else if (a === "--viewport") out.viewport = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "-v" || a === "--verbose") out.verbose = true;
    else if (!a.startsWith("-")) out._.push(a);
  }
  return out;
}

function log(opts, ...args) { if (opts.verbose) console.error("[harvest]", ...args); }

function defaultOut(target) {
  // Reuse the router's single-source-of-truth host/path logic for real URLs;
  // local files land in a fixed local-components bucket.
  if (/^https?:\/\//i.test(target)) return join(defaultOutputDir(target), "components");
  return join(homedir(), "Desktop", "zhenpachong", "local-components", "components");
}

function nameFromSelector(sel, idx) {
  const stem = sel.replace(/[#.]/g, " ").replace(/[^a-zA-Z0-9]+/g, " ").trim().replace(/\s+/g, "-").toLowerCase();
  return stem || `component-${idx + 1}`;
}

const args = parseArgs(process.argv.slice(2));
const target = args._[0];

if (!target || args.selectors.length === 0) {
  console.error("Usage: harvest.mjs <url-or-file> --selector \"css\" [--selector \"css2\"] [--name NAME] [--output DIR] [--wait MS] [--json] [-v]");
  process.exit(2);
}

if (!args.output) args.output = defaultOut(target);

const pyArgs = [
  join(__dirname, "harvest.py"), target,
  "--wait", String(args.wait),
  "--viewport", args.viewport,
];
for (const s of args.selectors) pyArgs.push("--selector", s);

log(args, "running collector via Playwright:", target, "selectors:", args.selectors.length);
const r = runTool(BIN.python, pyArgs, { timeout: 90000 });

if (!r.ok) {
  console.error(`[harvest] collector failed (exit ${r.status}): ${r.stderr || r.stdout || "unknown error"}`);
  if (args.json) console.log(JSON.stringify({ ok: false, target, error: r.stderr || "collector failed" }, null, 2));
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(r.stdout);
} catch (e) {
  console.error("[harvest] cannot parse collector JSON:", e.message);
  console.error(r.stdout.slice(0, 1000));
  process.exit(1);
}

if (!payload.ok && payload.error && !payload.components) {
  console.error("[harvest]", payload.error);
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  process.exit(1);
}

mkdirSync(args.output, { recursive: true });
const results = [];
const capturedAt = new Date().toISOString();

payload.components.forEach((comp, idx) => {
  const name = args.names[idx] || nameFromSelector(comp.selector || args.selectors[idx], idx);
  if (comp.error) {
    results.push({ selector: comp.selector, name, ok: false, error: comp.error });
    log(args, `✗ ${comp.selector}: ${comp.error}`);
    return;
  }
  const md = buildComponentMarkdown(comp, {
    url: /^https?:/i.test(target) ? target : `(local file: ${basename(target)})`,
    capturedAt,
    mode: "harvest",
  });
  const file = join(args.output, componentFileName(name));
  writeFileSync(file, md, "utf8");
  results.push({
    selector: comp.selector, name, ok: true, file,
    tag: comp.tag, size: `${Math.round(comp.rect?.width || 0)}x${Math.round(comp.rect?.height || 0)}`,
    interactive: comp.interactive,
    stylesheets: comp.stylesheets,
    domTruncated: !!comp.domTruncated,
  });
  log(args, `✓ ${comp.selector} → ${file}`);
});

if (args.json) {
  console.log(JSON.stringify({ ok: results.every(x => x.ok), target, output: args.output, results }, null, 2));
} else {
  for (const x of results) {
    if (x.ok) {
      const sh = x.stylesheets || {};
      const warn = sh.blocked ? ` ⚠️${sh.blocked} 跨域样式表未取到` : "";
      const trunc = x.domTruncated ? " ⚠️DOM 截断" : "";
      console.error(`✓ ${x.name} [${x.tag} ${x.size}] → ${x.file}${warn}${trunc}`);
    } else {
      console.error(`✗ ${x.selector}: ${x.error}`);
    }
  }
  const okCount = results.filter(x => x.ok).length;
  console.error(okCount === results.length
    ? `\n✓ 采集 ${okCount}/${results.length} 个组件 → ${args.output}`
    : `\n${okCount}/${results.length} 个组件采集成功（失败见上）→ ${args.output}`);
}

process.exit(results.some(x => !x.ok) ? 1 : 0);
