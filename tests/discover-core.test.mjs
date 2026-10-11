import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUrl, registeredDomain, extractLinks, extractJsBundles,
  extractRoutesFromJs, parseSitemap, parseRobots, extractSubdomains,
  targetTerms, scoreCandidate, htmlTitle, rankCandidates,
  isPrivateHost, isInScope,
} from "../bin/lib/discover-core.mjs";

test("normalizeUrl resolves relative, drops hash, rejects non-http", () => {
  const u = normalizeUrl("/login?x=1#frag", "https://example.com/a/");
  assert.equal(u.href, "https://example.com/login?x=1");
  assert.equal(normalizeUrl("mailto:a@b.com", "https://example.com"), null);
  assert.equal(normalizeUrl("javascript:alert(1)", "https://example.com"), null);
});

test("registeredDomain handles 2-label and .com.cn", () => {
  assert.equal(registeredDomain("www.example.com"), "example.com");
  assert.equal(registeredDomain("a.b.example.com.cn"), "example.com.cn");
  assert.equal(registeredDomain("example.co.uk"), "example.co.uk");
});

test("extractLinks returns same-registrable-domain links only, deduped, anchors/cross-host dropped", () => {
  const html = `
    <a href="/about">a</a><a href="https://www.example.com/x">b</a>
    <a href="https://example.com/about#z">dup of /about path</a>
    <a href="https://cdn.other.com/lib.js">ext</a>
    <a name="notalink">x</a>`;
  const paths = extractLinks(html, "https://example.com/").map(u => u.pathname).sort();
  assert.deepEqual(paths, ["/about", "/x"]);
});

test("extractJsBundles gets absolute + relative script src", () => {
  const html = `<script src="/_next/static/chunk.js?v=1"></script>
    <script type="module" src="https://example.com/assets/app.js"></script>
    <script>inline()</script>`;
  const js = extractJsBundles(html, "https://example.com/");
  assert.equal(js.length, 2);
  assert.ok(js[0].href.includes("/_next/static/chunk.js?v=1"));
});

test("extractRoutesFromJs finds route literals but skips assets/static", () => {
  const code = `
    var r = ["/login", "/dashboard/admin", 'settings/profile', "/x.png",
             "/static/main.js", "/assets/a.css", "/api/v1/users"];
    const t = "/legal/terms";`;
  const routes = extractRoutesFromJs(code);
  assert.ok(routes.includes("/login"));
  assert.ok(routes.includes("/dashboard/admin"));
  assert.ok(routes.includes("/legal/terms"));
  assert.ok(!routes.some(r => r.endsWith(".png") || r.endsWith(".css")));
  assert.ok(!routes.some(r => r.startsWith("/static/") || r.startsWith("/assets/")));
});

test("parseSitemap urlset gives page urls", () => {
  const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://example.com/</loc></url>
    <url><loc>https://example.com/pricing</loc></url></urlset>`;
  const r = parseSitemap(xml);
  assert.deepEqual(r.urls, ["https://example.com/", "https://example.com/pricing"]);
  assert.deepEqual(r.childSitemaps, []);
});

test("parseSitemap index gives nested sitemap urls, incl .xml.gz", () => {
  const xml = `<sitemapindex><sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap>
    <sitemap><loc>https://example.com/sitemap2.xml.gz</loc></sitemap></sitemapindex>`;
  const r = parseSitemap(xml);
  assert.deepEqual(r.urls, []);
  assert.deepEqual(r.childSitemaps,
    ["https://example.com/sitemap-posts.xml", "https://example.com/sitemap2.xml.gz"]);
});

test("parseSitemap: a page URL containing sitemap.xml inside urlset stays a page URL", () => {
  const xml = `<urlset><url><loc>https://example.com/newsitemap.xml?x=1</loc></url></urlset>`;
  const r = parseSitemap(xml);
  assert.deepEqual(r.urls, ["https://example.com/newsitemap.xml?x=1"]);
  assert.deepEqual(r.childSitemaps, []);
  assert.equal(r.isIndex, false);
});

test("parseSitemap tolerates garbage / BOM-ish", () => {
  assert.deepEqual(parseSitemap(""), { urls: [], childSitemaps: [], isIndex: false });
  assert.deepEqual(parseSitemap("\uFFFD\uFFFD"), { urls: [], childSitemaps: [], isIndex: false });
});

test("parseRobots extracts sitemaps + meaningful disallow, skips comments and root", () => {
  const txt = `# comment
User-agent: *
Disallow: /
Disallow: /admin/
Sitemap: https://example.com/sitemap.xml
Sitemap: not-a-url
  disallow:  /private # keep`;
  const r = parseRobots(txt);
  assert.deepEqual(r.sitemaps, ["https://example.com/sitemap.xml"]);
  assert.deepEqual(r.disallow.sort(), ["/admin/", "/private"]);
});

test("extractSubdomains matches same-root hosts in messy text", () => {
  const text = `DNS: admin.example.com  mail.example.com:25 other.example.org
   https://dev-2.example.com/path x.example.com`;
  const subs = extractSubdomains(text, "example.com");
  assert.deepEqual(subs, ["admin.example.com", "dev-2.example.com", "mail.example.com", "x.example.com"]);
});

test("targetTerms splits ascii words and unique CJK chars", () => {
  const t = targetTerms("登录 login 认证 auth");
  assert.deepEqual(t.ascii.sort(), ["auth", "login"]);
  assert.ok(t.cjk.includes("登") && t.cjk.includes("录"));
  // pairs come from the ORIGINAL sequence, no cross-word pair like 录认
  assert.ok(t.cjkPairs.includes("登录"));
  assert.ok(t.cjkPairs.includes("认证"));
  assert.ok(!t.cjkPairs.includes("录认"));
});

test("scoreCandidate ranks path/title hits above generic pages", () => {
  const terms = targetTerms("login 登录");
  const good = scoreCandidate({ url: "https://x.com/login", title: "用户登录" }, terms);
  const generic = scoreCandidate({ url: "https://x.com/news?id=2" }, terms);
  const none = scoreCandidate({ url: "https://x.com/about", title: "关于" }, terms);
  assert.ok(good > none);
  assert.ok(none > generic); // generic paginated URLs get penalized
  assert.ok(good >= 4);
});

test("rankCandidates merges multi-query scores and bands correctly", () => {
  const cands = [
    { url: "https://x.com/about", title: "关于" },
    { url: "https://x.com/login", title: "用户登录 / Sign in" },
    { url: "https://x.com/auth/pricing", title: "价格" },
  ];
  const ranked = rankCandidates(cands, ["login 登录", "pricing 价格"]);
  assert.equal(ranked[0].url, "https://x.com/login");
  assert.equal(ranked[0].band, "hit");
  assert.equal(ranked[ranked.length - 1].band, "miss");
});

test("isPrivateHost covers loopback, RFC1918, link-local, IPv6 ULA/LL, mapped", () => {
  for (const h of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.5", "169.254.1.1",
    "0.0.0.0", "localhost", "::1", "fc00::1", "fd12::2", "fe80::abc", "::ffff:10.0.0.1"])
    assert.ok(isPrivateHost(h), h);
  for (const h of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "example.com"])
    assert.ok(!isPrivateHost(h), h);
});

test("isInScope: same registrable domain allowed, cross-host/private refused", () => {
  const scope = { seedHost: "www.example.com", rootDomain: "example.com" };
  assert.ok(isInScope("https://api.example.com/x", scope));
  assert.ok(isInScope("http://www.example.com:8080/admin", scope));
  assert.ok(!isInScope("https://other.org/x", scope));
  assert.ok(!isInScope("http://169.254.169.254/latest/meta-data", scope));
  assert.ok(!isInScope("http://192.168.1.1/", scope));
  assert.ok(!isInScope("file:///c:/windows/win.ini", scope));
});

test("isInScope: private seed allows exactly itself (self 打靶), nothing else private", () => {
  const scope = { seedHost: "127.0.0.1", rootDomain: "127.0.0.1" };
  assert.ok(isInScope("http://127.0.0.1:8931/login", scope));
  assert.ok(!isInScope("http://127.0.0.2/", scope));
  assert.ok(!isInScope("http://169.254.169.254/", scope));
});

test("htmlTitle extracts and flattens whitespace", () => {
  assert.equal(htmlTitle("<html><title>  a\nb   </title></html>"), "a b");
  assert.equal(htmlTitle(""), "");
});
