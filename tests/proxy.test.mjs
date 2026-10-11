import { test } from "node:test";
import assert from "node:assert/strict";
import { isDomestic, curlProxyArgs, proxyEnv, cnSuffixes, isLocalHost } from "../bin/lib/proxy.mjs";

test("cn TLD always domestic", () => {
  assert.ok(isDomestic("example.gov.cn"));
  assert.ok(isDomestic("https://foo.bar.edu.cn/x"));
  assert.ok(isDomestic("cn"));
});

test("listed suffixes and subdomains are domestic", () => {
  assert.ok(isDomestic("www.bilibili.com"));
  assert.ok(isDomestic("i0.hdslb.com"));
  assert.ok(isDomestic("bilibili.com"));
});

test("foreign domains are not domestic", () => {
  assert.ok(!isDomestic("example.com"));
  assert.ok(!isDomestic("https://www.google.com/search"));
  assert.ok(!isDomestic("github.com"));
});

test("suffix-match must not cross labels", () => {
  assert.ok(!isDomestic("evilbilibili.com"));
});

test("curlProxyArgs: domestic bypasses, foreign gets explicit proxy", () => {
  assert.deepEqual(curlProxyArgs("https://www.bilibili.com/x"), ["--noproxy", "www.bilibili.com"]);
  const foreign = curlProxyArgs("https://example.com");
  assert.equal(foreign[0], "-x");
  assert.ok(foreign[1].includes("10808"));
});

test("proxyEnv: domestic strips proxy vars, foreign sets them", () => {
  assert.equal(proxyEnv("https://www.baidu.com").HTTPS_PROXY, "");
  assert.ok(proxyEnv("https://example.com").HTTPS_PROXY.includes("10808"));
});

test("loopback/local addresses are always direct (no proxy, no --noproxy either)", () => {
  for (const u of ["http://127.0.0.1:8787/x", "http://localhost:9222", "http://192.168.1.5/",
    "http://[::1]:8787/", "http://[fe80::1]/", "http://[::ffff:10.0.0.1]/"])
    assert.deepEqual(curlProxyArgs(u), [], u);
  assert.equal(proxyEnv("http://localhost:8787").HTTPS_PROXY, "");
  for (const h of ["127.0.0.1", "::1", "fc00::1", "fe80::ab", "::ffff:172.16.0.1"])
    assert.ok(isLocalHost(h), h);
  for (const h of ["8.8.8.8", "172.32.0.1", "example.com"])
    assert.ok(!isLocalHost(h), h);
});

test("domain list file actually loaded with no dupes", () => {
  const l = cnSuffixes();
  assert.ok(l.length > 50);
  assert.equal(new Set(l).size, l.length, "no duplicate suffixes");
});
