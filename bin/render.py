#!/usr/bin/env python
"""
render.py — render a URL with Playwright Chromium and dump fully-loaded HTML.

Usage:
    python render.py <url> [--wait MS] [--scroll] [--out FILE] [--user-agent UA]
                       [--viewport WxH]

Prints rendered HTML to stdout (or writes to --out).
Exit 0 on success, 1 on navigation/render failure.
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from netproxy import context_proxy


def main():
    ap = argparse.ArgumentParser(description="Playwright page renderer")
    ap.add_argument("url", help="URL to render")
    ap.add_argument("--wait", type=int, default=2500, help="ms to wait after networkidle")
    ap.add_argument("--scroll", action="store_true", help="auto-scroll to trigger lazy content")
    ap.add_argument("--out", default="", help="output file (default: stdout)")
    ap.add_argument("--user-agent", default=None, help="override User-Agent")
    ap.add_argument("--viewport", default="1440x900", help="WxH viewport")
    ap.add_argument("--timeout", type=int, default=30000, help="navigation timeout ms")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[render] playwright not installed. pip install playwright",
              file=sys.stderr)
        return 2

    try:
        w, h = args.viewport.lower().split("x", 1)
        viewport = {"width": int(w), "height": int(h)}
    except Exception:
        viewport = {"width": 1440, "height": 900}

    try:
        with sync_playwright() as p:
            # 铁律：不下载/不自起浏览器，一律 CDP 连共享系统 Chrome(9222)。
            # new_context() 在 CDP 上是无痕式隔离上下文，不碰共享 profile 的登录态。
            try:
                browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
            except Exception:
                print("[render] cannot connect to Chrome CDP 127.0.0.1:9222. Start it first:\n"
                      "  powershell -NoProfile -ExecutionPolicy Bypass -File \""
                      "C:\\Users\\Administrator\\.openclaw\\workspace\\skills\\G-zhen-wangluo\\bin\\start-chrome-9222.ps1\"",
                      file=sys.stderr)
                return 2
            context = browser.new_context(
                proxy=context_proxy(args.url),
                viewport=viewport,
                user_agent=args.user_agent or (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                ),
            )
            page = context.new_page()
            try:
                page.goto(args.url, wait_until="domcontentloaded", timeout=args.timeout)
                # Give JS a moment; don't hard-require networkidle (some pages never idle)
                page.wait_for_timeout(args.wait)

                if args.scroll:
                    # Scroll to bottom in steps to trigger lazy-loaded content
                    last_height = page.evaluate("document.body.scrollHeight")
                    for _ in range(12):
                        page.evaluate("window.scrollBy(0, document.body.scrollHeight)")
                        page.wait_for_timeout(400)
                        new_height = page.evaluate("document.body.scrollHeight")
                        if new_height == last_height:
                            break
                        last_height = new_height
                    page.evaluate("window.scrollTo(0, 0)")
                    page.wait_for_timeout(500)

                html = page.content()
            finally:
                context.close()
                browser.close()
    except Exception as e:
        print(f"[render] error: {e}", file=sys.stderr)
        return 1

    if not html or len(html) < 200:
        print("[render] empty or too short response", file=sys.stderr)
        return 1

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(html)
    else:
        sys.stdout.write(html)
    return 0


if __name__ == "__main__":
    sys.exit(main())
