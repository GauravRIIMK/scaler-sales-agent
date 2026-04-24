#!/usr/bin/env node
/**
 * One-shot helper: apply supabase/migrations/*.sql via the Supabase
 * Management API (`POST /v1/projects/{ref}/database/query`). Reads
 * SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF from env. Not part of
 * the runtime bundle — manual `node scripts/apply_migrations.mjs`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref) {
  console.error("Need SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF in env.");
  process.exit(1);
}

const dir = join(process.cwd(), "supabase", "migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

for (const f of files) {
  const sql = readFileSync(join(dir, f), "utf8");
  console.log(`\n── applying ${f} (${sql.length} chars) ──`);
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    }
  );
  const text = await res.text();
  if (!res.ok) {
    console.error(`FAILED (${res.status}): ${text.slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`OK (${res.status}): ${text.slice(0, 300)}`);
}
console.log("\nAll migrations applied.");
