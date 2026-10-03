import { test } from "node:test";
import assert from "node:assert/strict";
import { isDomestic, curlProxyArgs, proxyEnv, cnSuffixes } from "../bin/lib/proxy.mjs";

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

test("domain list file actually loaded with no dupes", () => {
  const l = cnSuffixes();
  assert.ok(l.length > 50);
  assert.equal(new Set(l).size, l.length, "no duplicate suffixes");
});
