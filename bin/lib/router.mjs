/**
 * G-zhen-lan-pachong router — pure URL/options → scrape strategy.
 * Single source of truth for tool path resolution. No side effects.
 * @module router
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Probe a list of Windows candidate paths and return the first that exists;
 * otherwise fall back to the bare command name (PATH lookup).
 */
function resolveBin(cmd, winCandidates = []) {
  if (platform() === "win32") {
    for (const p of winCandidates) {
      if (existsSync(p)) return p;
    }
  }
  return cmd;
}

/**
 * Resolve every external tool the skill may invoke. Single source of truth.
 * Override any path with the corresponding env var.
 * @returns {Record<string,string>}
 */
export function resolveBinPaths() {
  const isWin = platform() === "win32";
  const home = homedir();
  return {
    // Python (scripts live under its Scripts/ on Windows)
    python: process.env.PYTHON_PATH || (isWin ? "python" : "python3"),

    // HTTP
    curl: process.env.CURL_PATH || (isWin ? "curl.exe" : "curl"),

    // Link discovery / fast crawler (Go single binary, ~60MB)
    katana: process.env.KATANA_PATH || resolveBin("katana", [
      join(home, "go", "bin", "katana.exe"),
      "C:\\Program Files\\katana\\katana.exe",
    ]),

    // Single-page self-contained HTML archiver (Rust single binary, ~5MB)
    monolith: process.env.MONOLITH_PATH || resolveBin("monolith", [
      fileURLToPath(new URL("../vendor/monolith.exe", import.meta.url)),
    ]),

    // SaaS scrape/crawl fallback (npm global)
    firecrawl: process.env.FIRECRAWL_PATH || resolveBin("firecrawl", [
      join(home, "AppData", "Roaming", "npm", "firecrawl.ps1"),
      join(home, "AppData", "Roaming", "npm", "firecrawl.cmd"),
    ]),

    // Chrome for CDP screenshot fallback
    chrome: process.env.CHROME_PATH || resolveBin("chrome", [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ]),

    // Node (for invoking sibling .mjs scripts)
    node: process.execPath,
  };
}

/** Default output root: Desktop/zhenpachong/<sanitized-host>/ */
export function defaultOutputDir(url) {
  let host = "unknown";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
  return join(homedir(), "Desktop", "zhenpachong", host);
}

/**
 * Decide a scraping strategy from URL + options. Pure function.
 * @param {string} rawUrl
 * @param {{mode?:"auto"|"curl"|"browser"|"firecrawl"|"screenshot",
 *          scope?:"page"|"site", format?:"markdown"|"html"|"text",
 *          depth?:number, limit?:number}} [opts]
 * @returns {{strategy:"curl"|"browser"|"firecrawl"|"screenshot",
 *            scope:"page"|"site", format:"markdown"|"html"|"text",
 *            depth:number, limit:number, needsJs:boolean}}
 */
export function planStrategy(rawUrl, opts = {}) {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("URL is required");
  }
  let parsed;
  try { parsed = new URL(rawUrl); } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  const scope = opts.scope === "site" ? "site" : "page";
  const format = opts.format === "html" || opts.format === "text" ? opts.format : "markdown";
  const depth = Math.max(0, Math.min(10, parseInt(opts.depth, 10) || (scope === "site" ? 2 : 0)));
  const limit = Math.max(1, Math.min(5000, parseInt(opts.limit, 10) || (scope === "site" ? 100 : 1)));

  // Forced tool wins
  if (opts.mode === "curl" || opts.mode === "browser" || opts.mode === "firecrawl" || opts.mode === "screenshot") {
    return { strategy: opts.mode, scope, format, depth, limit, needsJs: opts.mode !== "curl" };
  }

  // auto: page = curl first (escalate at runtime); site = katana map + per-page curl
  return { strategy: "curl", scope, format, depth, limit, needsJs: false };
}

/** Heuristic: does fetched HTML look like a JS-shell (no real content)? */
export function looksLikeShell(html) {
  if (!html || typeof html !== "string") return true;
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, "")
                   .replace(/<style[\s\S]*?<\/style>/gi, "")
                   .replace(/<[^>]+>/g, " ")
                   .replace(/\s+/g, " ")
                   .trim();
  // <500 chars of visible text after stripping scripts/styles → SPA shell
  return text.length < 500;
}

/**
 * Sanitize a user-supplied --filename: strip every path component/separator so
 * it can never escape the output dir. Returns "" for empty input so callers fall
 * back to the URL-derived default (never the literal string "null"). Windows
 * reserved device basenames get an underscore prefix so writes don't silently fail.
 */
export function safeArgName(name) {
  if (!name) return "";
  const s = String(name).replace(/[<>:"/|?*\\]/g, "_").replace(/\.+/g, ".")
    .replace(/^[. ]+|[. ]+$/g, "").slice(0, 80);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s)) return `_${s}`;
  return s;
}

/** Sanitize a URL path segment into a safe directory/file name. */
export function pathFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.replace(/^\/+|\/+$/g, "").replace(/[<>:"|?*\\]/g, "_") || "index";
    return seg.endsWith(".html") ? seg : `${seg}.html`;
  } catch {
    return "index.html";
  }
}
