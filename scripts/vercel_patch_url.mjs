#!/usr/bin/env node
/**
 * Fix PUBLIC_APP_URL on the Vercel project to the *actual* alias.
 * We initially pushed https://scaler-sales-agent.vercel.app (a guess),
 * but the real alias Vercel assigned is scaler-sales-agent-theta.vercel.app.
 * Twilio statusCallback must resolve, so this must match reality.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Pull VERCEL_TOKEN from .env.local (ambient shell doesn't have it)
const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
const env = {};
for (const line of raw.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq <= 0) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  env[k] = v;
}

const TOKEN = env.VERCEL_TOKEN || process.env.VERCEL_TOKEN;
const TEAM_ID = env.VERCEL_TEAM_ID || "team_VjXSRTwWDrgkFTghIVC7LUSS";
const PROJECT = "scaler-sales-agent";
const NEW_URL = "https://scaler-sales-agent-theta.vercel.app";

if (!TOKEN) {
  console.error("VERCEL_TOKEN missing from .env.local");
  process.exit(1);
}

const api = async (method, path, body) => {
  const url = `https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${TEAM_ID}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json ?? text };
};

// 1. Locate existing PUBLIC_APP_URL entry
console.log("-- listing envs --");
const list = await api("GET", `/v10/projects/${PROJECT}/env`);
if (list.status >= 400) {
  console.error("list failed:", list.body);
  process.exit(1);
}
const entry = (list.body.envs ?? []).find((e) => e.key === "PUBLIC_APP_URL");
if (!entry) {
  console.log("PUBLIC_APP_URL not found - adding it");
  const add = await api("POST", `/v10/projects/${PROJECT}/env`, {
    key: "PUBLIC_APP_URL",
    value: NEW_URL,
    target: ["production", "preview", "development"],
    type: "encrypted",
  });
  console.log("add:", add.status, JSON.stringify(add.body).slice(0, 200));
  process.exit(add.status >= 400 ? 1 : 0);
}
console.log(`found id=${entry.id}  current value is stored (encrypted, not visible via API)`);

// 2. PATCH it to the correct alias
console.log(`-- patching PUBLIC_APP_URL -> ${NEW_URL} --`);
const upd = await api("PATCH", `/v10/projects/${PROJECT}/env/${entry.id}`, {
  value: NEW_URL,
  target: ["production", "preview", "development"],
  type: "encrypted",
});
if (upd.status >= 400) {
  console.error("patch failed:", upd.body);
  process.exit(1);
}
console.log("patched OK");
console.log("\nNext: redeploy so the new URL is picked up:");
console.log(`  npx vercel deploy --prod --yes --token ${TOKEN.slice(0, 6)}...`);
