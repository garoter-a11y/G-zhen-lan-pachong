import { test } from "node:test";
import assert from "node:assert/strict";
import { isDomestic, curlProxyArgs, cnSuffixes } from "../bin/lib/proxy.mjs";

test("cn TLD always domestic", () => {
  assert.ok(isDomestic("example.gov.cn"));
  assert.ok(isDomestic("https://foo.bar.edu.cn/x"));
  assert.ok(isDomestic("cn"));
});

test("listed suffixes and subdomains are domestic", () => {
  assert.ok(isDomestic("www.bilibili.com"));
  assert.ok( isDomestic("i0.hdslb.com"));
  assert.ok(isDomestic("bilibili.com"));
});

test("foreign domains are not domestic", () => {
  assert.ok(!isDomestic("example.com"));
  assert.ok(!isDomestic("https://www.google.com/search"));
  assert.ok(!isDomestic("github.com"));
});

test("suffix-match must not cross labels", () => {
  // evilbilibili.com must not match bilibili.com
  assert.ok(!isDomestic("evilbilibili.com"));
});

test("curlProxyArgs only for domestic hosts", () => {
  assert.deepEqual(curlProxyArgs("https://www.bilibili.com/x"), ["--noproxy", "www.bilibili.com"]);
  assert.deepEqual(curlProxyArgs("https://example.com"), []);
});

test("domain list file actually loaded", () => {
  assert.ok(cnSuffixes().length > 50);
});
