// proxy.mjs — domestic/foreign routing shared by scrape.mjs & crawl.mjs.
// Single data source: references/cn-domains.txt (also read by bin/lib/netproxy.py).
// Rules (G先生 2026-10-03):
//   *.cn + listed suffixes => direct (never proxy)
//   everything else        => socks5 127.0.0.1:10808
// Overrides: Z_PROXY_SERVER, Z_NO_PROXY=1.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let list = null;

export const PROXY_SERVER = process.env.Z_PROXY_SERVER || "socks5://127.0.0.1:10808";

export function cnSuffixes() {
  if (list) return list;
  try {
    list = readFileSync(join(here, "..", "..", "references", "cn-domains.txt"), "utf8")
      .split(/\r?\n/).map(s => s.trim().toLowerCase())
      .filter(s => s && !s.startsWith("#"));
  } catch { list = []; }
  return list;
}

export function hostOf(url) {
  try { return (new URL(url)).hostname.toLowerCase(); } catch { return ""; }
}

export function isDomestic(urlOrHost) {
  const host = (urlOrHost.includes("://") ? hostOf(urlOrHost) : urlOrHost).split(":")[0];
  if (!host) return false;
  if (host === "cn" || host.endsWith(".cn")) return true;
  return cnSuffixes().some(s => host === s || host.endsWith("." + s));
}

// curl: domestic targets ignore inherited proxy env; foreign targets get explicit -x
// (overrides env; Z_NO_PROXY forces direct).
export function curlProxyArgs(url) {
  const host = hostOf(url);
  if (!host) return [];
  if (isDomestic(host)) return ["--noproxy", host];
  return process.env.Z_NO_PROXY ? [] : ["-x", PROXY_SERVER];
}

// Tools without proxy flags (monolith) read proxy env vars: domestic targets need a
// proxy-free environment; foreign targets get explicit proxy env.
export function proxyEnv(url) {
  const host = hostOf(url);
  if (!host) return {};
  if (isDomestic(host) || process.env.Z_NO_PROXY)
    return { HTTPS_PROXY: "", HTTP_PROXY: "", ALL_PROXY: "", https_proxy: "", http_proxy: "", all_proxy: "" };
  return { HTTPS_PROXY: PROXY_SERVER, HTTP_PROXY: PROXY_SERVER, ALL_PROXY: PROXY_SERVER };
}
