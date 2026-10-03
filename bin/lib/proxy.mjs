// proxy.mjs — domestic/foreign routing shared by scrape.mjs & crawl.mjs.
// Single data source: references/cn-domains.txt (also read by bin/lib/netproxy.py).
// Rule: *.cn + listed suffixes => direct; anything else => use proxy env / socks.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let list = null;

export function cnSuffixes() {
  if (list) return list;
  try {
    list = readFileSync(join(here, "..", "..", "references", "cn-domains.txt"), "utf8")
      .split(/\r?\n/).map(s => s.trim().toLowerCase())
      .filter(s => s && !s.startsWith("#"));
  } catch { list = []; }
  return list;
}

export function isDomestic(urlOrHost) {
  let host = "";
  try { host = urlOrHost.includes("://") ? new URL(urlOrHost).hostname : urlOrHost; }
  catch { host = urlOrHost; }
  host = host.toLowerCase().split(":")[0];
  if (!host) return false;
  if (host === "cn" || host.endsWith(".cn")) return true;
  return cnSuffixes().some(s => host === s || host.endsWith("." + s));
}

// Extra curl args: domestic targets must ignore inherited proxy env vars.
export function curlProxyArgs(url) {
  let host = "";
  try { host = new URL(url).hostname; } catch { host = ""; }
  return host && isDomestic(host) ? ["--noproxy", host] : [];
}
