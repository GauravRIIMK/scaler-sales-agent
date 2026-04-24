#!/usr/bin/env node
/**
 * Create a Vercel project and push all runtime env vars via the Vercel API.
 * Reads secrets from .env.local, so run `node scripts/vercel_setup.mjs`
 * from the project root. Idempotent: if project exists we just upsert envs.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const TOKEN = process.env.VERCEL_TOKEN;
const TEAM_ID = process.env.VERCEL_TEAM_ID || "team_VjXSRTwWDrgkFTghIVC7LUSS";
const PROJECT_NAME = process.env.VERCEL_PROJECT_NAME || "scaler-sales-agent";

if (!TOKEN) {
  console.error("VERCEL_TOKEN missing");
  process.exit(1);
}

// Load env vars we care about from .env.local
const envPath = join(process.cwd(), ".env.local");
if (!existsSync(envPath)) {
  console.error(".env.local not found");
  process.exit(1);
}

const raw = readFileSync(envPath, "utf8");
const localEnv = {};
for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) continue;
  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();
  if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
  if (val.length > 0) localEnv[key] = val;
}

// Explicit allow-list: only push what the runtime actually reads.
const RUNTIME_KEYS = [
  "ANTHROPIC_API_KEY",
  "VOYAGE_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_FROM",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_BUCKET_PDFS",
  "SUPABASE_BUCKET_AUDIO",
  "DEEPGRAM_API_KEY",
  "PUBLIC_APP_URL",
];

const api = async (method, path, body) => {
  const url = `https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${TEAM_ID}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json ?? text };
};

// 1. Ensure project exists
console.log(`── Ensuring project "${PROJECT_NAME}" exists ──`);
let proj = await api("GET", `/v10/projects/${PROJECT_NAME}`);
if (proj.status === 404) {
  console.log("  creating…");
  proj = await api("POST", `/v10/projects`, {
    name: PROJECT_NAME,
    framework: "nextjs",
  });
  if (proj.status >= 400) {
    console.error("  failed:", proj.body);
    process.exit(1);
  }
  console.log(`  created id=${proj.body.id}`);
} else if (proj.status >= 400) {
  console.error("  lookup failed:", proj.body);
  process.exit(1);
} else {
  console.log(`  already exists id=${proj.body.id}`);
}

// PUBLIC_APP_URL needs to point at the prod vercel URL once we know it.
// We'll set it to a placeholder now and fix after first deploy.
if (!localEnv.PUBLIC_APP_URL || localEnv.PUBLIC_APP_URL.startsWith("http://localhost")) {
  localEnv.PUBLIC_APP_URL = `https://${PROJECT_NAME}.vercel.app`;
}

// 2. List existing env vars and upsert.
console.log(`\n── Upserting env vars ──`);
const existing = await api("GET", `/v10/projects/${PROJECT_NAME}/env`);
if (existing.status >= 400) {
  console.error("env list failed:", existing.body);
  process.exit(1);
}
const byKey = new Map();
for (const e of existing.body.envs ?? []) byKey.set(e.key, e);

for (const key of RUNTIME_KEYS) {
  const value = localEnv[key];
  if (!value) {
    console.log(`  ${key.padEnd(30)} SKIP (not in .env.local)`);
    continue;
  }
  const prior = byKey.get(key);
  if (prior) {
    const upd = await api("PATCH", `/v10/projects/${PROJECT_NAME}/env/${prior.id}`, {
      value,
      target: ["production", "preview", "development"],
      type: "encrypted",
    });
    if (upd.status >= 400) {
      console.log(`  ${key.padEnd(30)} PATCH ERR ${upd.status}: ${JSON.stringify(upd.body).slice(0, 200)}`);
    } else {
      console.log(`  ${key.padEnd(30)} UPDATED (len=${value.length})`);
    }
  } else {
    const add = await api("POST", `/v10/projects/${PROJECT_NAME}/env`, {
      key,
      value,
      target: ["production", "preview", "development"],
      type: "encrypted",
    });
    if (add.status >= 400) {
      console.log(`  ${key.padEnd(30)} ADD ERR ${add.status}: ${JSON.stringify(add.body).slice(0, 200)}`);
    } else {
      console.log(`  ${key.padEnd(30)} ADDED (len=${value.length})`);
    }
  }
}

console.log(`\nProject ready. Deploy with:\n  npx vercel deploy --prod --yes --token ${TOKEN.slice(0, 6)}…`);
