#!/usr/bin/env node
/**
 * G-zhen-lan-pachong scrape — single-page content extraction.
 *
 * Fallback ladder (lazy → heavy, local → cloud):
 *   1. curl + trafilatura  (SSR static, fastest, fully local)
 *   2. Playwright render + trafilatura  (SPA/JS, via CDP 9222 shared system Chrome)
 *   3. firecrawl scrape  (SaaS render, needs internet/auth)
 *   4. monolith  (self-contained HTML archive, no content extraction)
 *   5. Playwright screenshot  (last resort → agent uses image vision)
 *
 * Usage:
 *   node bin/scrape.mjs <url> [--format markdown|html|text]
 *        [--mode auto|curl|browser|firecrawl|screenshot]
 *        [--output DIR] [--filename NAME] [--archive] [--no-scroll]
 *        [--wait MS] [--json] [-v]
 *
 * @module scrape
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { resolveBinPaths, planStrategy, defaultOutputDir, looksLikeShell, pathFromUrl } from "./lib/router.mjs";
import { runTool } from "./lib/run.mjs";
import { curlProxyArgs } from "./lib/proxy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolveBinPaths();

function parseArgs(argv) {
  const out = {
    _: [], format: "markdown", mode: "auto", output: null, filename: null,
    archive: false, scroll: true, wait: 2500, json: false, verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--format" || a === "-f") out.format = argv[++i];
    else if (a === "--mode") out.mode = argv[++i];
    else if (a === "--output" || a === "-o") out.output = argv[++i];
    else if (a === "--filename") out.filename = argv[++i];
    else if (a === "--archive") out.archive = true;
    else if (a === "--no-scroll") out.scroll = false;
    else if (a === "--wait") out.wait = parseInt(argv[++i], 10);
    else if (a === "--json") out.json = true;
    else if (a === "-v" || a === "--verbose") out.verbose = true;
    else if (!a.startsWith("-")) out._.push(a);
  }
  if (out._.length === 0) {
    console.error("Usage: scrape.mjs <url> [--format markdown|html|text] [--mode auto|curl|browser|firecrawl] [--output DIR] [--archive] [--json]");
    process.exit(2);
  }
  if (!out.output) out.output = defaultOutputDir(out._[0]);
  return out;
}

function log(opts, ...args) { if (opts.verbose) console.error("[scrape]", ...args); }

function safeFilename(url, format) {
  try {
    const u = new URL(url);
    const seg = (u.pathname || "/").replace(/^\/+|\/+$/g, "").replace(/[<>:"/|?*\\]/g, "_") || "index";
    const ext = format === "html" ? "html" : format === "text" ? "txt" : "md";
    return `${seg}.${ext}`;
  } catch {
    return `page.${format === "html" ? "html" : "md"}`;
  }
}

// ── Tier 1: curl + trafilatura ────────────────────────

function curlFetch(url, opts) {
  const r = runTool(BIN.curl, [
    "-sL", "--max-time", "30",
    ...curlProxyArgs(url),
    "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    url,
  ], { timeout: 35000 });
  if (!r.ok || r.stdout.length < 200) return null;
  return r.stdout;
}

function trafilaturaExtract(html, url, format) {
  const extFormat = format === "text" ? "txt" : format;
  const r = runTool(BIN.python, [join(__dirname, "extract.py"), "--format", extFormat, "--url", url], {
    timeout: 30000, input: html,
  });
  if (r.ok && r.stdout.trim().length > 50) return r.stdout.trim();
  return null;
}

// ── Tier 2: Playwright render + trafilatura ───────────

function playwrightRender(url, opts) {
  const args = [join(__dirname, "render.py"), url, "--wait", String(opts.wait)];
  if (opts.scroll) args.push("--scroll");
  const r = runTool(BIN.python, args, { timeout: 90000 });
  if (!r.ok || r.stdout.length < 200) return null;
  return r.stdout;
}

// ── Tier 3: firecrawl SaaS ────────────────────────────

function firecrawlScrape(url, format) {
  const args = ["scrape", url];
  if (format === "markdown") args.push("--markdown");
  else if (format === "html") args.push("--html");
  const r = runTool(BIN.firecrawl, args, { timeout: 60000 });
  if (r.ok && r.stdout.trim().length > 50) return r.stdout.trim();
  return null;
}

// ── Tier 4: monolith self-contained HTML ──────────────

function monolithArchive(url, outPath) {
  // monolith 2.10.x on Windows panics with -o <path> ("could not prepare output").
  // Workaround: write to stdout (-o -) and persist ourselves.
  mkdirSync(dirname(outPath), { recursive: true });
  const r = runTool(BIN.monolith, [url, "-o", "-", "-e", "-q"], { timeout: 120000 });
  if (r.ok && r.stdout && r.stdout.length > 100) {
    writeFileSync(outPath, r.stdout, "utf8");
    return existsSync(outPath);
  }
  return false;
}

// ── Tier 5: screenshot (returns path, agent uses vision) ─

function screenshot(url, outPath) {
  // Inline Playwright screenshot. try/finally guarantees browser close even if
  // goto/screenshot throws — otherwise a timed-out navigation leaks a page in the shared browser.
  const script = `
import sys
sys.path.insert(0, r"${join(__dirname, "lib")}")
from netproxy import context_proxy
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    try:
        b = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    except Exception:
        sys.exit(3)  # shared Chrome CDP down; caller records failure
    kw = {"viewport":{"width":1440,"height":900}}
    cp = context_proxy(sys.argv[1])
    if cp: kw["proxy"] = cp
    pg = b.new_page(**kw)
    try:
        pg.goto(sys.argv[1], wait_until="domcontentloaded", timeout=30000)
        pg.wait_for_timeout(2500)
        pg.screenshot(path=sys.argv[2], full_page=True)
    finally:
        pg.close()
`;
  const r = runTool(BIN.python, ["-c", script, url, outPath], { timeout: 60000 });
  return r.ok && existsSync(outPath);
}

// ── main ──────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
const plan = planStrategy(url, { mode: args.mode, scope: "page", format: args.format });
const result = { url, format: args.format, output: args.output, method: null, content: null, archivePath: null, screenshotPath: null, errors: {} };

function fail(step, err) { result.errors[step] = String(err || "failed").substring(0, 500); }

try {
  mkdirSync(args.output, { recursive: true });

  // Screenshot mode is a direct strategy (tier 5)
  if (plan.strategy === "screenshot") {
    const shotPath = join(args.output, args.filename ? `${args.filename}.png` : safeFilename(url, "html").replace(/\.html$/, ".png"));
    if (screenshot(url, shotPath)) { result.method = "screenshot"; result.screenshotPath = shotPath; }
    else fail("screenshot", "render failed");
  }

  // firecrawl forced
  if (!result.method && plan.strategy === "firecrawl") {
    log(args, "trying firecrawl...");
    const content = firecrawlScrape(url, args.format);
    if (content) { result.method = "firecrawl"; result.content = content; }
    else fail("firecrawl", "no content");
  }

  // curl forced
  if (!result.method && plan.strategy === "curl") {
    log(args, "trying curl...");
    const html = curlFetch(url, args);
    if (html) {
      const extracted = trafilaturaExtract(html, url, args.format);
      if (extracted) { result.method = "curl+trafilatura"; result.content = extracted; result.rawHtml = args.archive ? html : undefined; }
      else fail("curl:trafilatura", "no main content in static HTML");
    } else { fail("curl", "fetch failed"); }
  }

  // browser forced
  if (!result.method && plan.strategy === "browser") {
    log(args, "trying playwright...");
    const html = playwrightRender(url, args);
    if (html) {
      const extracted = trafilaturaExtract(html, url, args.format);
      if (extracted) { result.method = "playwright+trafilatura"; result.content = extracted; }
      else {
        // Fall back to returning raw rendered HTML
        result.method = "playwright-raw"; result.content = html;
        fail("playwright:trafilatura", "extraction empty, returning raw HTML");
      }
    } else fail("playwright", "render failed");
  }

  // ── auto ladder ────────────────────────────────────
  if (!result.method && args.mode === "auto") {
    // 1. curl + trafilatura (always try — trafilatura itself judges content, not a word-count heuristic)
    log(args, "tier 1: curl + trafilatura...");
    let html = curlFetch(url, args);
    if (html) {
      if (looksLikeShell(html)) log(args, "  (page looks short — trafilatura will decide)");
      const extracted = trafilaturaExtract(html, url, args.format);
      if (extracted) { result.method = "curl+trafilatura"; result.content = extracted; }
      else { fail("curl:trafilatura", "no main content extracted from static HTML"); }
    } else { fail("curl", "fetch failed"); }

    // 2. playwright render + trafilatura
    if (!result.method) {
      log(args, "tier 2: playwright render...");
      html = playwrightRender(url, args);
      if (html) {
        const extracted = trafilaturaExtract(html, url, args.format);
        if (extracted) { result.method = "playwright+trafilatura"; result.content = extracted; }
        else { result.method = "playwright-raw"; result.content = html; fail("playwright:trafilatura", "extraction empty, raw HTML returned"); }
      } else fail("playwright", "render failed");
    }

    // 3. firecrawl
    if (!result.method) {
      log(args, "tier 3: firecrawl...");
      const content = firecrawlScrape(url, args.format);
      if (content) { result.method = "firecrawl"; result.content = content; }
      else fail("firecrawl", "no content");
    }
  }

  // ── save content ──────────────────────────────────
  if (result.content) {
    const filename = args.filename ? `${args.filename}.${args.format === "html" ? "html" : args.format === "text" ? "txt" : "md"}` : safeFilename(url, args.format);
    const outPath = join(args.output, filename);
    writeFileSync(outPath, result.content, "utf8");
    result.file = outPath;
    log(args, `saved → ${outPath} (${result.content.length} chars via ${result.method})`);
  }

  // ── optional monolith archive ────────────────────
  if (args.archive) {
    const archPath = join(args.output, args.filename ? `${args.filename}.archive.html` : safeFilename(url, "html").replace(/\.html$/, ".archive.html"));
    log(args, "archiving with monolith...");
    if (monolithArchive(url, archPath)) {
      result.archivePath = archPath;
    } else {
      fail("monolith", "archive failed");
    }
  }

  // ── last resort: screenshot ──────────────────────
  if (!result.method && !result.file) {
    log(args, "tier 5: screenshot fallback...");
    const shotPath = join(args.output, safeFilename(url, "html").replace(/\.html$/, ".screenshot.png"));
    if (screenshot(url, shotPath)) { result.method = "screenshot"; result.screenshotPath = shotPath; }
    else fail("screenshot", "all methods failed");
  }

  if (args.json) {
    // Don't dump full content into JSON summary; always provide a preview when content exists.
    const summary = { ...result };
    if (summary.content) {
      summary.contentPreview = summary.content.length > 200
        ? summary.content.substring(0, 200) + "…"
        : summary.content;
    }
    delete summary.content; delete summary.rawHtml;
    console.log(JSON.stringify(summary, null, 2));
  } else {
    if (result.file) console.error(`✓ ${result.method} → ${result.file} (${result.content?.length || 0} chars)`);
    if (result.archivePath) console.error(`✓ archive → ${result.archivePath}`);
    if (result.screenshotPath) console.error(`✓ screenshot → ${result.screenshotPath}`);
    if (!result.file && !result.screenshotPath) {
      console.error("✗ all methods failed:");
      for (const [k, v] of Object.entries(result.errors)) console.error(`  ${k}: ${v}`);
    }
    if (result.content && !result.file) console.log(result.content);
  }
  process.exit(result.file || result.screenshotPath ? 0 : 1);
} catch (err) {
  console.error(`[scrape] ${err.message}`);
  if (args.json) console.log(JSON.stringify({ url, error: err.message }, null, 2));
  process.exit(2);
}
