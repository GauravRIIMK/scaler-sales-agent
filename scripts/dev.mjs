#!/usr/bin/env node
/**
 * Force-loads .env.local (overriding existing process.env) then spawns
 * `next dev`. Works around the case where the ambient shell has set a
 * blocking empty ANTHROPIC_API_KEY=, which Node --env-file + @next/env
 * both refuse to override.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const envPath = join(process.cwd(), ".env.local");
if (!existsSync(envPath)) {
  console.error("[dev] .env.local not found");
  process.exit(1);
}

const raw = readFileSync(envPath, "utf8");
for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) continue;
  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();
  if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
  if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
  process.env[key] = val; // force override
}

const args = process.argv.slice(2);
const cmd = process.platform === "win32" ? "next.cmd" : "next";
const child = spawn(cmd, ["dev", ...args], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 0));
