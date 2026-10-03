"""
netproxy.py — domestic/foreign proxy routing for Playwright contexts.

Rule (G先生 2026-10-03): domestic traffic must NOT go through the proxy.

- *.cn and suffixes in references/cn-domains.txt  => direct
- everything else                                 => socks5 127.0.0.1:10808

Every browser context gets proxy=socks5 with bypass=<full CN suffix list>,
so both the target page and its domestic CDN assets stay direct while
foreign requests still use the proxy. Override:
  Z_PROXY_SERVER  → alternate proxy server
  Z_NO_PROXY=1    → force direct for everything
"""
import os
from pathlib import Path

_LIST_FILE = Path(__file__).resolve().parents[2] / "references" / "cn-domains.txt"
_cache = None


def cn_suffixes():
    global _cache
    if _cache is not None:
        return _cache
    suffixes = []
    try:
        for line in _LIST_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                suffixes.append(line.lower())
    except OSError:
        pass
    _cache = suffixes
    return suffixes


def is_domestic(host):
    host = (host or "").lower().split(":")[0]
    if host.endswith(".cn") or host == "cn":
        return True
    return any(host == s or host.endswith("." + s) for s in cn_suffixes())


def host_of_url(url):
    from urllib.parse import urlparse
    return urlparse(url).hostname or ""


def context_proxy(url=""):
    """Playwright new_context(proxy=...) dict, or None for a pure-direct context."""
    if os.environ.get("Z_NO_PROXY"):
        return None
    server = os.environ.get("Z_PROXY_SERVER", "socks5://127.0.0.1:10808")
    bypass = ["cn", "*.cn"] + ["*." + s for s in cn_suffixes()]
    # If the specific target is domestic the page itself must be in bypass too;
    # the suffix list covers most, but include its registrable host explicitly.
    host = host_of_url(url)
    if host and host.replace(".", "").isalnum():
        bypass.append(host)
    return {"server": server, "bypass": ",".join(bypass)}


def curl_noproxy(url):
    """Return ['--noproxy', host] when target is domestic, else []."""
    host = host_of_url(url)
    if is_domestic(host):
        return ["--noproxy", host]
    return []
