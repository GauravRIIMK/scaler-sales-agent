#!/usr/bin/env node
/**
 * E2E smoke test:
 *   1. POST /api/cases/new with a Priya-PM profile + transcript
 *   2. POST /api/cases/:id/generate  (STT skipped — transcript provided)
 *   3. POST /api/cases/:id/pdf
 *   4. POST /api/cases/:id/nudge
 * Prints a compact report at each stage.
 *
 * Usage: BASE=http://localhost:3002 node scripts/smoke.mjs
 */
const BASE = process.env.BASE || "http://localhost:3002";
const BDA_CODE = process.env.BDA_APPROVAL_CODE || "SCALER-APPROVE-9421";
// Smoke-only placeholders. Override with env vars when running for real:
//   SMOKE_LEAD_PHONE=whatsapp:+91XXXXXXXXXX SMOKE_BDA_PHONE=whatsapp:+91XXXXXXXXXX node scripts/smoke.mjs
const LEAD_PHONE = process.env.SMOKE_LEAD_PHONE || "whatsapp:+15005550006";
const BDA_PHONE = process.env.SMOKE_BDA_PHONE || "whatsapp:+15005550006";

const profile = {
  name: "Priya Sharma",
  role: "Senior Product Manager",
  experience_years: 6,
  industry: "SaaS",
  location: "Bangalore",
  current_company: "Freshworks",
  education: "B.Tech, IIIT-Hyderabad",
  budget_range: "INR 3-5L",
  goals: ["transition to AI/ML PM roles", "build technical depth"],
  concerns: ["time commitment with current job", "ROI vs program cost"],
};

const transcript = `BDA: Hi Priya, thanks for hopping on. How's your current role treating you?

Priya: Honestly a bit flat. I've been at Freshworks 4 years now managing our core analytics product. I want to move into AI/ML PM but I don't have the depth to even ask the right questions in design reviews.

BDA: Got it. That's a common gap, and the AI/ML track was built for that. Mind if I ask what's holding you back?

Priya: Two things. The cost is around 3.5 lakhs — I need to justify that. And I can't quit my job, I have a 2-year-old at home. Is this actually doable part-time?

BDA: Yes, most of our learners are working full-time. Classes are weekend mornings with recorded content for weekdays.

Priya: What about outcomes? I keep hearing "100% placement" but I don't believe that for senior folks.

BDA: Fair. For mid-career PMs like you, placement support is mock interviews, portfolio coaching, and referrals into our partner network. It's not a guarantee — we call out what we actually do.

Priya: OK. The ROI doesn't feel right until I see concrete numbers for people at my level. Can I see placement data filtered by 5+ years experience?

BDA: I'll put together a brief for you with exactly that.

Priya: Is there a refund if I drop out? And what if my family situation changes?

BDA: Great, I'll include the refund policy detail too.`;

async function post(path, body, opts = {}) {
  const url = `${BASE}${path}`;
  const t0 = Date.now();
  const headers = { "Content-Type": "application/json" };
  if (opts.withCode) headers["x-bda-approval-code"] = BDA_CODE;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const ms = Date.now() - t0;
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ms, json, text };
}

function summary(label, r) {
  const head = `${label.padEnd(8)} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)}ms`;
  if (r.status >= 400) {
    console.log(head, "ERR:", r.text.slice(0, 400));
    return false;
  }
  console.log(head, Object.keys(r.json).join(","));
  return true;
}

async function main() {
  console.log(`BASE = ${BASE}\n`);

  console.log("── 1. /api/cases/new ──");
  const r1 = await post("/api/cases/new", {
    profile,
    transcript,
    evaluator_phone: LEAD_PHONE,
    bda_whatsapp: BDA_PHONE,
    bda_name: "Anjali (BDA)",
    language: "en-IN",
  });
  if (!summary("new", r1)) process.exit(1);
  const caseId = r1.json.case_id;
  console.log("   case_id:", caseId, "state:", r1.json.state);

  console.log("\n── 2. /api/cases/:id/generate ──");
  const r2 = await post(`/api/cases/${caseId}/generate`, {});
  if (!summary("generate", r2)) process.exit(1);
  console.log("   state:", r2.json.state);
  console.log("   questions:", r2.json.questions, "sections:", r2.json.sections);
  console.log("   archetype:", r2.json.archetype, "degraded:", r2.json.degraded);
  console.log("   verify_stats:", JSON.stringify(r2.json.verify_stats));
  console.log("   covering_msg:", (r2.json.covering_msg ?? "").slice(0,160));

  console.log("\n── 3a. /api/cases/:id/pdf without code (expect 401) ──");
  const r3a = await post(`/api/cases/${caseId}/pdf`, {});
  console.log(`   status: ${r3a.status}  err: ${(r3a.json.error ?? "").slice(0, 80)}`);

  console.log("\n── 3b. /api/cases/:id/decision (approve) ──");
  const r3b = await post(`/api/cases/${caseId}/decision`, { action: "approved" }, { withCode: true });
  if (!summary("decision", r3b)) process.exit(1);
  console.log("   state:", r3b.json.state);

  console.log("\n── 3c. /api/cases/:id/pdf with code ──");
  const r3 = await post(`/api/cases/${caseId}/pdf`, {}, { withCode: true });
  if (!summary("pdf", r3)) process.exit(1);
  console.log("   pdf_url:", (r3.json.pdf_url ?? "").slice(0,120));
  console.log("   bytes:", r3.json.bytes, "pages:", r3.json.pages);

  console.log("\n── 4. /api/cases/:id/nudge ──");
  const r4 = await post(`/api/cases/${caseId}/nudge`, {});
  if (!summary("nudge", r4)) process.exit(1);
  console.log("   markdown chars:", (r4.json.markdown ?? "").length);
  console.log("   plaintext chars:", (r4.json.whatsapp_plaintext ?? "").length);
  console.log("   plaintext preview:", (r4.json.whatsapp_plaintext ?? "").slice(0, 240).replace(/\n/g, " | "));

  console.log(`\n✓ E2E smoke complete — visit ${BASE}/cases/${caseId}`);
}

main().catch((e) => {
  console.error("[smoke] fatal:", e);
  process.exit(1);
});
