import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Drive the Python netproxy from node so it lives under the same test command.
function pyContextProxy(url, extraEnv = {}) {
  const code = `
import json, sys
sys.path.insert(0, r"${join(root, "bin")}")
from lib.netproxy import context_proxy
print(json.dumps(context_proxy(sys.argv[1])))
`;
  const r = spawnSync("python", ["-c", code, url], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  return JSON.parse(r.stdout);
}

test("foreign main document is NOT in bypass (B2 regression)", () => {
  const cp = pyContextProxy("https://www.google.com/search?q=x");
  assert.ok(!cp.bypass.split(",").includes("www.google.com"));
  assert.ok(cp.server.includes("10808"));
});

test("domestic main document bare host IS in bypass", () => {
  const cp = pyContextProxy("https://www.bilibili.com/");
  assert.ok(cp.bypass.split(",").includes("www.bilibili.com"));
});

test("Z_NO_PROXY=1 returns no proxy at all", () => {
  const cp = pyContextProxy("https://example.com", { Z_NO_PROXY: "1" });
  assert.equal(cp, null);
});
