#!/usr/bin/env node
/**
 * Query delivery_events rows for the smoke-test case to verify that Twilio
 * statusCallback webhooks landed (Task 4.3). If no rows exist, either the
 * statusCallback URL wasn't reachable (PUBLIC_APP_URL mismatch, signature
 * validation fail, etc.) or Twilio hasn't posted yet.
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

const PROJ = env.SUPABASE_PROJECT_REF;
const TOKEN = env.SUPABASE_ACCESS_TOKEN;
const CASE = process.argv[2] || "c61397cb-61be-489e-a62b-0c6cb38492fd";

const sql = `
  select
    id, case_id, channel, direction, twilio_sid as sid,
    status, error_code, created_at, payload -> 'MessageStatus' as ms
  from delivery_events
  where case_id = '${CASE}'
  order by created_at desc
  limit 50;
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJ}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});
const body = await res.json();
if (!res.ok) {
  console.error("query failed:", body);
  process.exit(1);
}
console.log(`rows: ${body.length}`);
for (const r of body) {
  console.log(`  ${r.created_at}  sid=${r.sid}  status=${r.status}  err=${r.error_code ?? '-'}`);
}

// Also show any recent webhook failures in agent_logs
const logsSql = `
  select created_at, event, component, error_message, payload
  from agent_logs
  where case_id = '${CASE}' and component like 'twilio%'
  order by created_at desc
  limit 20;
`;
const res2 = await fetch(`https://api.supabase.com/v1/projects/${PROJ}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: logsSql }),
});
const body2 = await res2.json();
console.log(`\nagent_logs twilio rows: ${body2.length}`);
for (const r of body2) {
  console.log(`  ${r.created_at}  [${r.component}] ${r.event}${r.error_message ? ' ERR=' + r.error_message : ''}`);
}
