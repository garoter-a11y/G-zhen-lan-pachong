#!/usr/bin/env python
"""
harvest.py — open a page (URL or local file) with Playwright, inject the
self-written component collector (harvest-inject.js), run it against one or
more CSS selectors, and print the harvested payload(s) as JSON.

This is the built-in counterpart of the Com-Pick browser-plugin line: instead
of a human hovering/clicking, a CSS selector drives the pick. It also reads the
page's ORIGINAL stylesheet rules (@media / :hover) when same-origin, which a
getComputedStyle-only dump cannot provide.

Usage:
    python harvest.py <url-or-file> --selector "footer.newsletter" \
        [--selector ".card"] [--wait MS] [--viewport WxH] [--inject PATH]

Prints JSON to stdout: {"ok": bool, "components": [...], "error": "..."}.
Exit 0 on success (even if a selector misses — reported per component), 1 on
navigation/injection failure.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from netproxy import context_proxy


def main():
    ap = argparse.ArgumentParser(description="Harvest a UI component from a live page")
    ap.add_argument("target", help="http(s) URL or path to a local .html file")
    ap.add_argument("--selector", action="append", default=[],
                    help="CSS selector to harvest (repeatable)")
    ap.add_argument("--wait", type=int, default=2500, help="ms to wait after load")
    ap.add_argument("--viewport", default="1440x900", help="WxH viewport")
    ap.add_argument("--inject", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                     "harvest-inject.js"),
                    help="path to the injected collector script")
    ap.add_argument("--timeout", type=int, default=30000, help="navigation timeout ms")
    args = ap.parse_args()

    if not args.selector:
        print(json.dumps({"ok": False, "error": "at least one --selector is required"},
                         ensure_ascii=False))
        return 2

    target = args.target
    if os.path.exists(target):
        target = "file://" + os.path.abspath(target).replace("\\", "/")

    try:
        w, h = args.viewport.lower().split("x", 1)
        viewport = {"width": int(w), "height": int(h)}
    except Exception:
        viewport = {"width": 1440, "height": 900}

    try:
        with open(args.inject, "r", encoding="utf-8") as f:
            inject_src = f.read()
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"cannot read inject script: {e}"},
                         ensure_ascii=False))
        return 2

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(json.dumps({"ok": False,
                          "error": "playwright not installed. pip install playwright"},
                         ensure_ascii=False))
        return 2

    components = []
    nav_error = None
    try:
        with sync_playwright() as p:
            # 铁律：CDP 连共享系统 Chrome(9222)，new_context() 隔离登录态
            try:
                browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
            except Exception:
                print(json.dumps({"ok": False,
                                  "error": "cannot connect to Chrome CDP 127.0.0.1:9222; start shared Chrome via G-zhen-wangluo bin/start-chrome-9222.ps1"},
                                 ensure_ascii=False))
                return 2
            context = browser.new_context(
                proxy=context_proxy(target),
                viewport=viewport,
                user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
            )
            # Inject the collector BEFORE page scripts run. add_init_script goes
            # through CDP (Page.addScriptToEvaluateOnNewDocument), so it is NOT
            # blocked by the page's Content-Security-Policy — unlike injecting a
            # <script> element, which strict-CSP sites silently refuse.
            context.add_init_script(inject_src)
            page = context.new_page()
            try:
                page.goto(target, wait_until="domcontentloaded", timeout=args.timeout)
                page.wait_for_timeout(args.wait)
                for sel in args.selector:
                    try:
                        payload = page.evaluate(
                            "(selector) => window.__zhenHarvest ? window.__zhenHarvest(selector) "
                            ": { error: 'collector not installed' }", sel)
                    except Exception as e:
                        payload = {"error": f"evaluate failed: {e}"}
                    payload["selector"] = sel
                    components.append(payload)
            finally:
                context.close()
                browser.close()
    except Exception as e:
        nav_error = str(e)

    if nav_error:
        print(json.dumps({"ok": False, "error": f"navigation/injection failed: {nav_error}"},
                         ensure_ascii=False))
        return 1

    ok = all("error" not in c for c in components)
    print(json.dumps({"ok": ok, "url": target, "components": components},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
