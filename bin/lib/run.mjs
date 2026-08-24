/**
 * Safe subprocess runner — spawnSync with arg arrays (no shell injection).
 * @module run
 */

import { spawnSync } from "node:child_process";

/**
 * Run an external command safely.
 * @param {string} bin - absolute path or PATH name
 * @param {string[]} args - argument vector (NOT a shell string)
 * @param {{timeout?:number, cwd?:string, input?:string}} [opts]
 * @returns {{ok:boolean, status:number|null, stdout:string, stderr:string, error?:string}}
 */
export function runTool(bin, args, opts = {}) {
  try {
    // When piping input, stdio[0] must be "pipe" (not "ignore") or `input` is silently dropped.
    const stdin = opts.input != null ? "pipe" : "ignore";
    const res = spawnSync(bin, args, {
      stdio: [stdin, "pipe", "pipe"],
      encoding: "utf8",
      timeout: opts.timeout || 120000,
      maxBuffer: 100 * 1024 * 1024,
      cwd: opts.cwd,
      input: opts.input,
    });
    const stdout = res.stdout || "";
    const stderr = res.stderr || "";
    if (res.error) {
      return { ok: false, status: null, stdout, stderr, error: res.error.message };
    }
    return { ok: res.status === 0, status: res.status, stdout, stderr };
  } catch (e) {
    return { ok: false, status: null, stdout: "", stderr: "", error: e.message };
  }
}
