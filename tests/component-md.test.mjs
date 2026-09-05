/**
 * component-md.test.mjs — pure-function tests for the UI-component harvest pipeline.
 * Covers: DOM-string sanitization, design-token inference, markdown task-sheet rendering.
 * Run: node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeDomString,
  inferTokens,
  buildComponentMarkdown,
  componentFileName,
} from "../bin/lib/component-md.mjs";

// ── sanitizeDomString: strip sensitive/tracking/action attributes ──

test("sanitize strips event handlers, hrefs and form actions", () => {
  const html = `<a href="https://evil.test/x" onclick="steal()" class="btn">Go</a>`;
  const out = sanitizeDomString(html);
  assert.ok(!/href=/.test(out), "href must be removed");
  assert.ok(!/onclick=/.test(out), "onclick must be removed");
  assert.ok(!/steal/.test(out), "handler body must be gone");
  assert.match(out, /class="btn"/, "structural class must survive");
  assert.match(out, /Go/, "visible text must survive");
});

test("sanitize strips sensitive and tracking attributes (credentials/analytics)", () => {
  const html = `<input name="pw" type="password" data-auth-token="abc123" ` +
    `data-gtm-id="GTM-9" data-secret-key="s" value="keepme" aria-label="Password">`;
  const out = sanitizeDomString(html);
  assert.ok(!/data-auth-token/.test(out), "auth token attr must be stripped");
  assert.ok(!/abc123/.test(out), "token value must be gone");
  assert.ok(!/data-gtm-id/.test(out), "analytics attr must be stripped");
  assert.ok(!/data-secret-key/.test(out), "secret attr must be stripped");
  assert.match(out, /type="password"/, "type must survive");
  assert.match(out, /aria-label="Password"/, "aria must survive");
});

test("sanitize keeps a structural allowlist (id/class/role/type/name/aria/data-state)", () => {
  const html = `<button id="ok" class="primary" role="tab" type="button" ` +
    `name="next" aria-selected="true" data-state="active">Next</button>`;
  const out = sanitizeDomString(html);
  for (const attr of ['id="ok"', 'class="primary"', 'role="tab"', 'type="button"',
    'name="next"', 'aria-selected="true"', 'data-state="active"']) {
    assert.match(out, new RegExp(attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${attr} must survive`);
  }
});

test("sanitize neutralizes anchors into generic buttons (role/tabindex, no navigation)", () => {
  const out = sanitizeDomString(`<a href="/dashboard" class="nav">Dash</a>`);
  assert.match(out, /role="button"/, "anchor becomes a generic button role");
  assert.ok(!/href=/.test(out));
});

test("sanitize removes <script>/<style>/<link> bodies entirely (no inline tracking/credentials/beacons)", () => {
  const html = `<div><script>fbq("track",{email:"a@b.com"}); var apikey="SEKRET123";</script>` +
    `<style>.x{background:url(//evil.test/beacon)}</style>` +
    `<link rel="stylesheet" href="https://evil.test/x.css"><p>ok</p></div>`;
  const out = sanitizeDomString(html);
  for (const leak of ["SEKRET123", "fbq", "apikey", "evil.test", "<script", "<style", "<link", "beacon"]) {
    assert.ok(!out.includes(leak), `must not leak: ${leak}`);
  }
  assert.match(out, /<p>ok<\/p>/, "structural content must survive");
});

test("sanitize drops prefilled values and hidden inputs (csrf / email / phone never leak)", () => {
  const html = `<form>` +
    `<input type="hidden" name="csrf_token" value="CSRF-LEAK-XYZ">` +
    `<input type="email" name="email" value="user@example.com" placeholder="Email">` +
    `<input type="tel" name="phone" value="13800000000">` +
    `<button type="submit">Go</button></form>`;
  const out = sanitizeDomString(html);
  for (const leak of ["CSRF-LEAK-XYZ", "user@example.com", "13800000000", "type=\"hidden\"", "csrf_token"]) {
    assert.ok(!out.includes(leak), `must not leak: ${leak}`);
  }
  assert.match(out, /placeholder="Email"/, "placeholder (non-sensitive hint) may survive");
  assert.match(out, /<button/, "button must survive");
});

test("sanitize truncation never cuts inside a tag (no half-sanitized attributes leak)", () => {
  // A huge DOM: after sanitize+truncate, the tail must end on a tag boundary and
  // never expose a raw unsanitized attribute like data-token.
  const big = `<div class="wrap">` + `<a href="/x" data-token="TOPSECRET">item</a>`.repeat(500) + `</div>`;
  const out = sanitizeDomString(big, 2000);
  assert.ok(!/data-token|TOPSECRET|href=/.test(out), "truncated output stays fully sanitized");
});

test("sanitize is idempotent and never throws on empty input", () => {
  assert.equal(sanitizeDomString(""), "");
  const once = sanitizeDomString(`<a href="x" onclick="y()">t</a>`);
  assert.equal(sanitizeDomString(once), once);
});

// ── inferTokens: cluster computed styles into design tokens ──

test("inferTokens clusters repeated colors / radius / font sizes", () => {
  const styles = [
    { color: "rgb(255, 255, 255)", backgroundColor: "rgb(15, 118, 110)", borderRadius: "8px", fontSize: "16px", fontFamily: "Poppins" },
    { color: "rgb(255, 255, 255)", backgroundColor: "rgb(15, 118, 110)", borderRadius: "8px", fontSize: "14px", fontFamily: "Poppins" },
    { color: "rgb(15, 118, 110)", backgroundColor: "rgb(245, 241, 234)", borderRadius: "4px", fontSize: "14px", fontFamily: "Poppins" },
  ];
  const t = inferTokens(styles);
  assert.ok(t.colors && t.colors.length > 0, "should report colors");
  // The sage green appears twice as a background → should be ranked first
  assert.match(t.colors[0].value, /15, 118, 110|#0f766e/i);
  assert.ok(t.colors[0].count >= 2, "most frequent color ranked first");
  assert.ok(t.radii.includes("8px"), "radius 8px captured");
  assert.ok(t.fontSizes.includes("16px") && t.fontSizes.includes("14px"), "font sizes captured");
  assert.match(t.fontFamily, /Poppins/);
});

test("inferTokens ignores transparent / zero noise", () => {
  const t = inferTokens([
    { color: "rgb(0, 0, 0)", backgroundColor: "rgba(0, 0, 0, 0)", borderRadius: "0px", fontSize: "16px", fontFamily: "none" },
  ]);
  assert.ok(!t.colors.some(c => /rgba\(0, ?0, ?0, ?0\)/.test(c.value)), "transparent bg not a token");
  assert.ok(!t.radii.includes("0px"), "zero radius not a token");
});

// ── buildComponentMarkdown: the AI task sheet ──

function mockData() {
  return {
    selector: "footer.newsletter",
    tag: "footer",
    rect: { width: 1149, height: 220 },
    dom: `<footer class="newsletter"><a href="/x" onclick="t()" data-token="sekret">Subscribe</a>` +
      `<input type="email" aria-label="Email"><button type="button" class="btn">Send</button></footer>`,
    visualCss: [
      { selector: "footer.newsletter", css: { backgroundColor: "rgb(15, 118, 110)", color: "rgb(255,255,255)", borderRadius: "12px", padding: "32px" } },
    ],
    stateRules: [
      { selector: "footer.newsletter .btn:hover", cssText: "background-color: rgb(13, 100, 93);" },
    ],
    responsiveRules: [
      { media: "@media (max-width: 720px)", cssText: "footer.newsletter { padding: 16px; }" },
    ],
    interactive: { inputs: 1, buttons: 2, links: 1, sliders: 0, switches: 0, details: [] },
    stylesheets: { total: 2, readable: 1, blocked: 1 },
  };
}

test("buildComponentMarkdown renders all required task-sheet sections", () => {
  const md = buildComponentMarkdown(mockData(), { url: "https://example.com/", capturedAt: "2026-09-05T00:00:00Z", mode: "harvest" });
  for (const section of ["组件复刻任务", "目标位置", "组件摘要", "通用交互", "设计 Token",
    "响应式规则", "状态", "安全清理清单", "清理后 DOM", "关键视觉 CSS", "验收要求"]) {
    assert.match(md, new RegExp(section), `must contain section: ${section}`);
  }
});

test("buildComponentMarkdown sanitizes embedded DOM (no credentials/hrefs leak into the sheet)", () => {
  const md = buildComponentMarkdown(mockData(), { url: "https://example.com/", capturedAt: "x", mode: "harvest" });
  assert.ok(!/sekret/.test(md), "token value must not leak into markdown");
  assert.ok(!/onclick/.test(md), "handlers must not leak");
  assert.ok(!/href=/.test(md), "hrefs must not leak");
});

test("buildComponentMarkdown flags cross-domain stylesheet blocking honestly", () => {
  const data = mockData();
  const md = buildComponentMarkdown(data, { url: "https://example.com/", capturedAt: "x", mode: "harvest" });
  assert.match(md, /跨域|CORS|未取到|1 个/i, "must disclose that 1 stylesheet was blocked");
});

test("buildComponentMarkdown includes the incremental/safe contract wording", () => {
  const md = buildComponentMarkdown(mockData(), { url: "u", capturedAt: "x", mode: "harvest" });
  assert.match(md, /增量/, "must say: additive only / do not touch existing");
  assert.match(md, /props|callback|回调/, "generic actions exposed via props/callback");
  assert.match(md, /推测/, "guessed states must be marked as speculation");
});

// ── componentFileName ──

test("componentFileName makes a safe, lower-snake, .md name", () => {
  assert.equal(componentFileName("Newsletter Footer!"), "newsletter-footer.md");
  assert.equal(componentFileName("a/b<c>:d?"), "a-b-c-d.md");
  assert.equal(componentFileName(""), "component.md");
  assert.match(componentFileName("My Card 2"), /^[\w-]+\.md$/);
});
