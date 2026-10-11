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

/**
 * Loopback / link-local / RFC1918 private addresses and bare "localhost" are
 * never proxied — socks5 to 127.0.0.1 would break local 打靶/CDP targets.
 */
export function isLocalHost(urlOrHost) {
  let host;
  if (urlOrHost.includes("://")) {
    host = hostOf(urlOrHost);              // URL.hostname already strips port
  } else {
    // bare host:port (dns/IPv4) or [ipv6]:port; bare IPv6 with multiple colons
    // (fe80::1, ::ffff:…) has no single trailing :port and passes through whole
    const withPort = urlOrHost.match(/^(\[[^\]]+\]|[^:\]]+):\d+$/);
    host = withPort ? withPort[1] : urlOrHost;
  }
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::" || host === "0.0.0.0") return true;
  // IPv4-mapped IPv6 unwrap then re-test: dotted form (::ffff:10.0.0.1)
  // and URL-normalized hex form (::ffff:a00:1 → 10.0.0.1)
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) { host = mapped[1]; }
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
    host = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".");
  }
  if (host.includes(":")) {
    // unique local fc00::/7 (fc/fd), link-local fe80::/10
    return /^f[cd][0-9a-f]{2}/i.test(host) || /^fe[89ab]/i.test(host);
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [, a, b] = m.map(Number);
  return a === 0 || a === 127 || a === 10 || (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
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
  if (isLocalHost(host)) return [];
  if (isDomestic(host)) return ["--noproxy", host];
  return process.env.Z_NO_PROXY ? [] : ["-x", PROXY_SERVER];
}

// Tools without proxy flags (monolith) read proxy env vars: domestic targets need a
// proxy-free environment; foreign targets get explicit proxy env.
export function proxyEnv(url) {
  const host = hostOf(url);
  if (!host) return {};
  if (isLocalHost(host) || isDomestic(host) || process.env.Z_NO_PROXY)
    return { HTTPS_PROXY: "", HTTP_PROXY: "", ALL_PROXY: "", https_proxy: "", http_proxy: "", all_proxy: "" };
  return { HTTPS_PROXY: PROXY_SERVER, HTTP_PROXY: PROXY_SERVER, ALL_PROXY: PROXY_SERVER };
}
