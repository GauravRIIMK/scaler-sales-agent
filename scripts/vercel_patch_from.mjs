#!/usr/bin/env node
/**
 * Switch TWILIO_WHATSAPP_FROM on Vercel to the sandbox number.
 * Trial accounts have no approved sender, so only whatsapp:+14155238886 works.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const TOKEN = env.VERCEL_TOKEN;
const TEAM_ID = "team_VjXSRTwWDrgkFTghIVC7LUSS";
const PROJECT = "scaler-sales-agent";
const NEW_VAL = "whatsapp:+14155238886";

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

const list = await api("GET", `/v10/projects/${PROJECT}/env`);
const entry = (list.body.envs ?? []).find((e) => e.key === "TWILIO_WHATSAPP_FROM");
if (!entry) {
  console.error("TWILIO_WHATSAPP_FROM not found — aborting");
  process.exit(1);
}
const upd = await api("PATCH", `/v10/projects/${PROJECT}/env/${entry.id}`, {
  value: NEW_VAL,
  target: ["production", "preview", "development"],
  type: "encrypted",
});
console.log("patch status:", upd.status);
if (upd.status >= 400) {
  console.error(upd.body);
  process.exit(1);
}
console.log(`TWILIO_WHATSAPP_FROM -> ${NEW_VAL}`);
