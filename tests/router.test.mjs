/**
 * router.test.mjs — pure-function tests for G-zhen-lan-pachong router + run.
 * Run: node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  resolveBinPaths,
  defaultOutputDir,
  planStrategy,
  looksLikeShell,
  pathFromUrl,
  safeArgName,
} from "../bin/lib/router.mjs";
import { runTool } from "../bin/lib/run.mjs";

// ── safeArgName (N1 regression) ──────────────────────

test("safeArgName: empty/null input returns empty, never 'null'", () => {
  assert.equal(safeArgName(null), "");
  assert.equal(safeArgName(undefined), "");
  assert.equal(safeArgName(""), "");
});

test("safeArgName: traversal and separators neutralised", () => {
  for (const bad of ["..\\..\\evil", "../../evil", "a/../../b", "....//....//x", "nul?"])
    assert.ok(!safeArgName(bad).includes("/"), bad);
  assert.equal(safeArgName("..\\..\\evil"), "_._evil");
});

test("safeArgName: Windows reserved names prefixed", () => {
  assert.equal(safeArgName("con.txt"), "_con.txt");
  assert.equal(safeArgName("nul"), "_nul");
  assert.equal(safeArgName("normal.md"), "normal.md");
});

const WIN = process.platform === "win32";
const node = process.execPath;

// ── resolveBinPaths ──────────────────────────────────

test("resolveBinPaths returns absolute-or-name paths for all tools", () => {
  const b = resolveBinPaths();
  for (const k of ["python", "curl", "katana", "monolith", "firecrawl", "chrome", "node"]) {
    assert.ok(typeof b[k] === "string" && b[k].length > 0, `${k} must be a non-empty string`);
  }
  assert.equal(b.node, process.execPath);
});

test("resolveBinPaths honors env overrides", () => {
  const orig = process.env.MONOLITH_PATH;
  process.env.MONOLITH_PATH = "X:\\custom\\monolith.exe";
  try {
    assert.equal(resolveBinPaths().monolith, "X:\\custom\\monolith.exe");
  } finally {
    if (orig === undefined) delete process.env.MONOLITH_PATH; else process.env.MONOLITH_PATH = orig;
  }
});

// ── defaultOutputDir ─────────────────────────────────

test("defaultOutputDir strips www and places under Desktop/zhenpachong", () => {
  const d = defaultOutputDir("https://www.Example.COM/path/x");
  assert.match(d, /zhenpachong[\\/]+example\.com/i);
});

test("defaultOutputDir handles malformed URL without throwing", () => {
  const d = defaultOutputDir("not a url");
  assert.match(d, /unknown/);
});

// ── planStrategy ─────────────────────────────────────

test("auto page mode defaults to curl strategy", () => {
  const p = planStrategy("https://x.com/a");
  assert.equal(p.strategy, "curl");
  assert.equal(p.scope, "page");
  assert.equal(p.format, "markdown");
  assert.equal(p.needsJs, false);
});

test("forced browser mode is respected", () => {
  const p = planStrategy("https://x.com/a", { mode: "browser" });
  assert.equal(p.strategy, "browser");
  assert.equal(p.needsJs, true);
});

test("site scope defaults depth=2 limit=100", () => {
  const p = planStrategy("https://x.com/", { scope: "site" });
  assert.equal(p.scope, "site");
  assert.equal(p.depth, 2);
  assert.equal(p.limit, 100);
});

test("depth/limit are clamped to sane bounds", () => {
  const p = planStrategy("https://x.com/", { scope: "site", depth: 999, limit: 999999 });
  assert.equal(p.depth, 10);
  assert.equal(p.limit, 5000);
  const p2 = planStrategy("https://x.com/", { scope: "site", depth: -5, limit: 0 });
  assert.ok(p2.depth >= 0);
  assert.ok(p2.limit >= 1);
});

test("html and text formats are accepted", () => {
  assert.equal(planStrategy("https://x.com/", { format: "html" }).format, "html");
  assert.equal(planStrategy("https://x.com/", { format: "text" }).format, "text");
});

test("invalid URL throws", () => {
  assert.throws(() => planStrategy(""));
  assert.throws(() => planStrategy(null));
});

test("invalid mode falls through as auto (not a forced tool)", () => {
  // Unknown modes should not crash; planStrategy only recognizes the 4 forced modes.
  const p = planStrategy("https://x.com/", { mode: "bogus" });
  assert.equal(p.strategy, "curl");
});

// ── looksLikeShell ───────────────────────────────────

test("empty/short html is a shell", () => {
  assert.equal(looksLikeShell(""), true);
  assert.equal(looksLikeShell("<html><body><div>hi</div></body></html>"), true);
});

test("content-rich html is not a shell", () => {
  const body = "<p>" + "lorem ipsum dolor sit amet ".repeat(40) + "</p>";
  assert.equal(looksLikeShell(`<html><body>${body}</body></html>`), false);
});

test("script-only page with no visible text is a shell", () => {
  const html = `<html><body><script>${"var x=1;".repeat(200)}</script></body></html>`;
  assert.equal(looksLikeShell(html), true);
});

// ── pathFromUrl ──────────────────────────────────────

test("pathFromUrl maps root to index.html", () => {
  assert.equal(pathFromUrl("https://x.com/"), "index.html");
});

test("pathFromUrl preserves existing .html suffix", () => {
  assert.equal(pathFromUrl("https://x.com/about.html"), "about.html");
});

test("pathFromUrl appends .html to clean paths", () => {
  assert.equal(pathFromUrl("https://x.com/blog/post-1"), "blog/post-1.html");
});

test("pathFromUrl strips illegal filename chars", () => {
  const p = pathFromUrl("https://x.com/a<b>c");
  assert.doesNotMatch(p, /[<>:"|?*\\]/);
});

// ── runTool: the stdin bug regression test ───────────

test("runTool pipes input to stdin (regression: stdio must be pipe, not ignore)", () => {
  // A script that echoes stdin back. If stdio[0] is "ignore", input is dropped.
  const script = WIN
    ? "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log('GOT:'+d));"
    : "import sys; print('GOT:'+sys.stdin.read())";
  const args = WIN ? ["-e", script] : ["-c", script];
  const r = runTool(node, args, { input: "hello-stdin-12345", timeout: 10000 });
  assert.ok(r.ok, `stderr: ${r.stderr} error: ${r.error || ""}`);
  assert.match(r.stdout, /GOT:hello-stdin-12345/);
});

test("runTool returns ok=false for missing binary", () => {
  const r = runTool("definitely-not-a-real-bin-xyz", ["--version"], { timeout: 5000 });
  assert.equal(r.ok, false);
});

test("runTool handles nonzero exit codes", () => {
  const r = runTool(node, ["-e", "process.exit(7)"], { timeout: 5000 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 7);
});

test("runTool arg array prevents shell injection (no shell interpolation)", () => {
  // If args were passed through a shell, `; echo PWNED` would execute.
  const marker = "ZZZ_SAFE_MARKER_ZZZ";
  const r = runTool(node, ["-e", `console.log("${marker}");`, ";", "echo", "PWNED"], { timeout: 5000 });
  assert.ok(r.stdout.includes(marker));
  assert.ok(!r.stdout.includes("PWNED"));
});

// ── extract.py integration (real trafilatura) ────────

test("extract.py pulls main content and strips nav/footer", () => {
  const html = `<!DOCTYPE html><html><head><title>T</title></head><body>
    <nav>Home About Contact Privacy Terms</nav>
    <article><h1>Real Article Title</h1>
    <p>${"Substantive paragraph content that should survive extraction. ".repeat(8)}</p>
    <p>${"A second paragraph with more real content to exceed thresholds. ".repeat(8)}</p>
    </article>
    <footer>Copyright 2026 Privacy Policy Terms of Service Cookie Settings</footer>
    </body></html>`;
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "extract.py");
  const r = runTool(process.platform === "win32" ? "python" : "python3",
    [script, "--format", "markdown"], { input: html, timeout: 30000 });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Real Article Title/);
  // Nav/footer boilerplate should be stripped
  assert.ok(!/Privacy Policy Terms of Service Cookie Settings/.test(r.stdout), "footer should be stripped");
});
