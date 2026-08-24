#!/usr/bin/env python
"""
extract.py — extract clean main content from HTML using trafilatura.

Usage:
    python extract.py <input.html> [--format markdown|html|text] [--url URL]
    cat page.html | python extract.py --format markdown

Reads HTML from file or stdin, prints extracted content to stdout.
Returns exit code 0 on success, 1 if extraction yields nothing, 2 on error.
"""
import argparse
import sys


def main():
    ap = argparse.ArgumentParser(description="trafilatura content extractor")
    ap.add_argument("input", nargs="?", help="HTML file path (default: stdin)")
    ap.add_argument("--format", default="markdown", choices=["markdown", "html", "txt", "xml"])
    ap.add_argument("--url", default="", help="Original URL (helps trafilatura)")
    ap.add_argument("--include-links", action="store_true", help="Keep links in markdown")
    ap.add_argument("--include-images", action="store_true", help="Keep image references")
    args = ap.parse_args()

    try:
        if args.input:
            with open(args.input, "r", encoding="utf-8", errors="replace") as f:
                html = f.read()
        else:
            html = sys.stdin.read()
    except Exception as e:
        print(f"[extract] read error: {e}", file=sys.stderr)
        return 2

    if not html or len(html.strip()) < 100:
        print("[extract] input too short", file=sys.stderr)
        return 1

    try:
        import trafilatura
    except ImportError:
        print("[extract] trafilatura not installed. pip install trafilatura", file=sys.stderr)
        return 2

    output_format = args.format
    if output_format == "txt":
        output_format = "txt"

    try:
        # trafilatura.extract returns None if it cannot identify main content
        result = trafilatura.extract(
            html,
            url=args.url or None,
            output_format=output_format,
            include_links=args.include_links,
            include_images=args.include_images,
            favor_precision=True,
            no_fallback=False,
            deduplicate=True,
        )
    except Exception as e:
        print(f"[extract] trafilatura error: {e}", file=sys.stderr)
        return 2

    if not result or len(result.strip()) < 50:
        # Fallback: try with recall-favoring settings
        try:
            result = trafilatura.extract(
                html,
                url=args.url or None,
                output_format=output_format,
                include_links=args.include_links,
                include_images=args.include_images,
                favor_precision=False,
                favor_recall=True,
                no_fallback=False,
            )
        except Exception:
            result = None

    if not result or len(result.strip()) < 50:
        print("[extract] trafilatura yielded nothing, trying bs4+markdownify fallback", file=sys.stderr)
        result = bs4_fallback(html, output_format)

    if not result or len(result.strip()) < 50:
        print("[extract] no main content found", file=sys.stderr)
        return 1

    out = result.strip()
    sys.stdout.write(out + "\n")
    return 0


def bs4_fallback(html, output_format):
    """Generic HTML→content fallback for non-article pages trafilatura can't handle.
    Strips nav/footer/aside/script/style, then markdownifies main/article/body."""
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return None

    soup = BeautifulSoup(html, "lxml")

    # Remove non-content elements
    for tag in soup(["script", "style", "noscript", "nav", "footer", "header",
                      "aside", "form", "iframe", "svg", "button"]):
        tag.decompose()
    # Remove common boilerplate by class/id
    for sel in ["nav", "footer", "header", "sidebar", "menu", "breadcrumb",
                "comments", "advertisement", "banner", "cookie"]:
        for el in soup.find_all(attrs={"class": lambda c: c and sel in str(c).lower()}):
            el.decompose()
        for el in soup.find_all(attrs={"id": lambda i: i and sel in str(i).lower()}):
            el.decompose()

    # Pick the best container
    container = soup.find("main") or soup.find("article") or soup.find("body") or soup

    if output_format in ("markdown", "md"):
        try:
            from markdownify import markdownify as md
            text = md(container.decode(), heading_style="ATX").strip()
        except ImportError:
            text = container.get_text(separator="\n").strip()
    elif output_format == "html":
        text = container.decode_contents().strip()
    else:  # txt
        text = container.get_text(separator="\n").strip()

    # Collapse 3+ blank lines
    import re
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text if len(text.strip()) >= 50 else None


if __name__ == "__main__":
    sys.exit(main())
