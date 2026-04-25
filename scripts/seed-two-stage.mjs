#!/usr/bin/env node
/**
 * Two-stage seed (Stage A pre-call + Stage B post-call) for the three
 * standard personas. This is the assignment-correct flow:
 *
 *   Stage A:
 *     1. POST /api/cases/extract-profile        (structure CRM blob)
 *     2. POST /api/leads                        (lead row, state=nudge_scheduled)
 *     3. POST /api/leads/{id}/fire-nudge-now    (manual fire — skip cron wait)
 *
 *   Stage B (call has just happened, BDA uploads transcript):
 *     4. POST /api/cases/{id}/post-call         (transcript → state=received)
 *     5. POST /api/cases/{id}/generate          (existing pipeline)
 *     6. POST /api/cases/{id}/decision          (BDA approves PDF)
 *     7. POST /api/cases/{id}/pdf               (render + sign)
 *
 * Compares against the legacy linear seed (scripts/seed-personas.mjs) by
 * writing tmp/seed-2stage-<slug>.json for each persona.
 *
 * The "pre-call" nudge in this flow has NEVER seen the transcript — that's
 * the structural difference that fixes the data-leak in the legacy path.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE        = process.env.BASE                 || "http://localhost:3002";
const BDA_CODE    = process.env.BDA_APPROVAL_CODE    || "SCALER-APPROVE-9421";
const LEAD_PHONE  = process.env.SMOKE_LEAD_PHONE     || "whatsapp:+15005550006";
const BDA_PHONE   = process.env.SMOKE_BDA_PHONE      || "whatsapp:+15005550006";
const LANGUAGE    = process.env.LANGUAGE             || "en-IN";
const BDA_NAME    = process.env.BDA_NAME             || "Anjali (BDA)";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR   = path.join(__dirname, "..", "tmp");

async function post(urlPath, body, opts = {}) {
  const url = `${BASE}${urlPath}`;
  const t0 = Date.now();
  const headers = { "Content-Type": "application/json" };
  if (opts.withCode) headers["x-bda-approval-code"] = BDA_CODE;
  if (opts.cronSecret) headers["x-cron-secret"] = opts.cronSecret;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const ms = Date.now() - t0;
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ms, json, text };
}

function stepLine(label, r, extras = []) {
  const tick = r.status < 400 ? "✓" : "✗";
  const status = String(r.status).padEnd(3);
  const ms = String(r.ms).padStart(5) + "ms";
  const extra = extras.length ? "  " + extras.join("  ") : "";
  console.log(`  ${tick} ${label.padEnd(14)} ${status}  ${ms}${extra}`);
}

const PERSONAS = [
  {
    name: "Rohan Sharma",
    slug: "rohan-sharma",
    profile_text: `Rohan Sharma is a 4-year SDE-2 at TCS Bangalore, currently on a Java/Spring backend modernization engagement for a US insurance client. He graduated B.Tech CSE from VIT in 2020 and earned an AWS Solutions Architect Associate certification in late 2023. Over the past six months he's been quietly applying to AI engineering roles at Razorpay, Atlassian, and a handful of YC startups — and getting rejected at the technical screen. He can read papers, but he can't ship a RAG pipeline end-to-end, and that gap is exactly what the interview loops are testing for. His friends from VIT are doing real ML work and he's tired of writing CRUD endpoints for someone else's roadmap. The 3.5L price tag for Scaler's AI engineering track is sitting heavy: his current CTC is 14 LPA and the salary jump quoted in marketing materials (16-22 LPA for AI roles) doesn't quite math out for him after factoring in tax. He's already done two free Andrew Ng courses and feels he's hit a ceiling on YouTube/Coursera content — he wants depth on production RAG, agents, and evals, not another theoretical ML refresher. He can stretch to 3.5L if EMI is on the table, but he's actively comparison-shopping with two cheaper bootcamps.`,
    transcript: `BDA: Hi Rohan, thanks for getting on. So you mentioned the AI engineering track — what's pulling you toward it now?\n\nRohan: Honestly, I've been at TCS for 4 years writing Java backends and I want out. I've been applying to AI eng roles for 6 months and getting rejected because I can read papers but I can't actually ship a RAG pipeline. So I need that hands-on depth.\n\nBDA: Got it. That's exactly what the track is built for. What's holding you back?\n\nRohan: Two things. First — why should I pay 3.5 lakhs when Andrew Ng has put basically the same content out for free on Coursera? I've done two of his courses already.\n\nBDA: Fair question. The free content gets you the theory. The track is built around shipping production systems — real RAG with vector stores, agentic workflows, evals you'd actually run in industry.\n\nRohan: Second — the realistic salary jump. You guys quote 16-22 LPA for AI roles. I'm at 14 LPA at TCS right now. After tax, 14 to 16 doesn't really math out for me.\n\nBDA: I hear that. The 22 number is for stronger profiles — typically people who already have a year of applied ML or strong open-source work. For someone in your spot, the realistic range first year post-program is closer to 18-20.\n\nRohan: OK. And one more — is the curriculum actually RAG, agents, evals depth, or is it theoretical ML?\n\nBDA: Applied. We can walk through the syllabus.`,
  },
  {
    name: "Karthik Iyer",
    slug: "karthik-iyer",
    profile_text: `Karthik Iyer is a 9-year Senior SWE at Google's Bangalore office, on the Search Quality team. He graduated dual-degree CS from IIT Madras in 2016. He is not price-sensitive — Google paid him roughly $400K total comp last year — but he is intensely time-sensitive and skeptical of anything that smells like a beginner cohort. He's looking at Scaler's AI/ML track because his internal team is rotating into LLM evaluation work and he wants to skill up faster than self-study allows, but he reads every page of the curriculum before committing his weekends. His questions are surgical: which instructors have actually shipped production AI systems versus only published academic papers; whether the cohort will include peers at his seniority or whether he'll be the senior-most by 5+ years; and what he'll specifically learn here that he can't pick up by reading the original Anthropic, OpenAI, and DeepMind papers. He'll exit after the first session if it feels remedial. He's done his homework — he already knows the names of three Scaler instructors and has cross-checked one of them on Google Scholar.`,
    transcript: `BDA: Hi Karthik, thanks for the time. You're at Google Search — what brought you to looking at Scaler?\n\nKarthik: My team is rotating into LLM eval work and I want to skill up faster than self-study. But I have three questions before I commit a weekend.\n\nBDA: Sure, go ahead.\n\nKarthik: First — what would I actually learn here that I can't pick up from reading the Anthropic, OpenAI, and DeepMind papers directly? I'm already doing that.\n\nBDA: The papers give you the what. The track gives you the how — production patterns, evaluation harnesses, debugging at scale. Practitioners who've shipped these systems telling you what doesn't work.\n\nKarthik: Second — who's the cohort? If I'm the senior-most by five years, this is a waste of my time.\n\nBDA: We do filter cohorts by experience tier. Your batch would be 6+ years average, several FAANG, a few tech leads.\n\nKarthik: Third — instructors. I want people who shipped production AI systems, not academics with citations. I've already cross-checked one of your instructors on Google Scholar.\n\nBDA: Most of our AI track instructors are from Microsoft, Adobe, and Flipkart's ML platforms. I can send you their detailed profiles.`,
  },
  {
    name: "Meera Patel",
    slug: "meera-patel",
    profile_text: `Meera Patel is in the final year of her B.Tech (CSE) at a Tier-3 engineering college in interior Maharashtra. Her family runs a small grocery shop; combined annual household income is approximately 2.8 lakhs. She has a confirmed offer from a state government IT department — 45,000 per month, joining July, with guaranteed pension and housing allowance — and her parents are pushing her to take it for the family stability. She has no LinkedIn presence yet. She's been quietly grinding LeetCode for 14 months and has built two personal projects: a college-fest registration app and a basic content-recommendation engine she trained on movie-rating data. She found Scaler through a friend's elder brother who placed at Walmart Labs after the DSA course. The 3.5L price for the program is more than her family earns in a year, so she's asked Scaler explicitly whether placement is guaranteed — her family is willing to sell their land if needed, but only with proof. The decision is jointly made with her parents, not a single phone call. She's anxious-positive: high motivation, high household risk-aversion, parents need to see government-job-equivalent certainty. The placement-guarantee question must be answered honestly — empty marketing language will lose this lead permanently.`,
    transcript: `BDA: Hi Meera, thanks for connecting. Your friend mentioned you have a government job offer in hand?\n\nMeera: Yes, 45,000 a month, joining in July. My parents want me to take it. But I want to do something in tech — I've been doing LeetCode and small projects for over a year.\n\nBDA: That's wonderful. What's the biggest question for you?\n\nMeera: First and most important — can you guarantee I'll get a job through Scaler? Because if I turn down the government offer for this, my family loses a sure thing.\n\nBDA: I want to be honest with you. We don't guarantee jobs — what we provide is mock interviews, portfolio coaching, and referrals to our 700+ partner companies. Outcomes data is on our placements page.\n\nMeera: Second — 3.5 lakhs is more than my family earns in a year. How do other students from similar backgrounds afford this?\n\nBDA: We have an income share agreement option — you pay nothing until you're placed at 5L+ CTC, then a percentage for 3 years. Some families also use education loans.\n\nMeera: Third — what if I can't clear the entrance test? I'm from a Tier-3 college, my fundamentals might be weak.\n\nBDA: There's a free 2-week prep before the test, and you can retake it twice. We don't filter aggressively at intake.`,
  },
];

async function saveCollected(slug, data) {
  await fs.mkdir(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, `seed-2stage-${slug}.json`);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  console.log(`  → saved ${filePath}`);
}

async function runPersona(persona) {
  const collected = { persona: persona.name, flow: "two-stage" };
  const result = {
    name: persona.name,
    caseId: null,
    extract: "—",
    lead: "—",
    nudgeFire: "—",
    postCall: "—",
    generate: "—",
    decision: "—",
    pdf: "—",
    archetype: "—",
    nudgeChars: "—",
    pdfBytes: "—",
    failed: false,
  };

  console.log(`\n${"─".repeat(64)}`);
  console.log(`Persona: ${persona.name}  [TWO-STAGE FLOW]`);
  console.log("─".repeat(64));

  // ── 1. Structure the CRM blob ─────────────────────────────────────────
  const r1 = await post("/api/cases/extract-profile", {
    profile_text: persona.profile_text,
    // Note: we DELIBERATELY do NOT pass transcript here — pre-call has
    // no transcript. extract-profile accepts profile_text alone.
    language: LANGUAGE,
  });
  collected.extract = r1.json;
  stepLine("extract", r1, [`conf=${(r1.json.confidence ?? "—").slice(0, 6)}`]);
  result.extract = r1.status < 400 ? "✓" : "✗";
  if (r1.status >= 400) {
    console.log(`    ERR: ${r1.text.slice(0, 400)}`);
    result.failed = true;
    await saveCollected(persona.slug, collected);
    return result;
  }
  const extractedProfile = r1.json.profile ?? {};

  // ── 2. Stage-A: create the lead with a scheduled call time ───────────
  // Schedule 2 minutes in the future. The cron's lead-time window is 60min,
  // so this row is immediately due — but for predictability the seed uses
  // the manual fire-now endpoint to skip the cron wait.
  const callAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const r2 = await post("/api/leads", {
    profile: extractedProfile,
    bda_whatsapp: BDA_PHONE,
    evaluator_phone: LEAD_PHONE,
    bda_name: BDA_NAME,
    language: LANGUAGE,
    scheduled_call_at: callAt,
  });
  collected.lead = r2.json;
  stepLine("lead", r2, [`id=${(r2.json.lead_id ?? "—").slice(0, 8)}`, `state=${r2.json.state ?? "—"}`]);
  if (r2.status >= 400) {
    console.log(`    ERR: ${r2.text.slice(0, 400)}`);
    result.failed = true;
    await saveCollected(persona.slug, collected);
    return result;
  }
  const caseId = r2.json.lead_id;
  result.caseId = caseId;
  result.lead = "✓";

  // ── 3. Stage-A: manually fire the pre-call nudge (profile only) ──────
  const r3 = await post(`/api/leads/${caseId}/fire-nudge-now`, {});
  collected.nudge_fire = r3.json;
  stepLine("fire-nudge", r3, [
    `status=${r3.json.status ?? "—"}`,
    `chunks=${r3.json.retrieved_chunks ?? "—"}`,
    `arch=${(r3.json.archetype ?? "—").slice(0, 16)}`,
  ]);
  if (r3.status >= 400) {
    console.log(`    ERR: ${r3.text.slice(0, 400)}`);
    result.failed = true;
    await saveCollected(persona.slug, collected);
    return result;
  }
  result.nudgeFire = r3.json.status === "sent" ? "✓" : `~${r3.json.status}`;
  result.archetype = r3.json.archetype ?? "—";

  // ── 4. Stage-B: simulate "the call happened" → upload transcript ────
  const r4 = await post(`/api/cases/${caseId}/post-call`, {
    transcript: persona.transcript,
    evaluator_phone: LEAD_PHONE,
  });
  collected.post_call = r4.json;
  stepLine("post-call", r4, [`state=${r4.json.state ?? "—"}`]);
  if (r4.status >= 400) {
    console.log(`    ERR: ${r4.text.slice(0, 400)}`);
    result.failed = true;
    await saveCollected(persona.slug, collected);
    return result;
  }
  result.postCall = "✓";

  // ── 5. Stage-B: generate the post-call PDF ──────────────────────────
  const r5 = await post(`/api/cases/${caseId}/generate`, {});
  collected.generate = r5.json;
  stepLine("generate", r5, [
    `q=${r5.json.questions ?? "—"}`,
    `sec=${r5.json.sections ?? "—"}`,
    `arch=${(r5.json.archetype ?? "—").slice(0, 18)}`,
  ]);
  if (r5.status >= 400) {
    console.log(`    ERR: ${r5.text.slice(0, 400)}`);
    result.failed = true;
    await saveCollected(persona.slug, collected);
    return result;
  }
  result.generate = "✓";

  // ── 6. Stage-B: BDA approves the PDF ────────────────────────────────
  const r6 = await post(`/api/cases/${caseId}/decision`, { action: "approved" }, { withCode: true });
  collected.decision = r6.json;
  stepLine("decision", r6, [`state=${r6.json.state ?? "—"}`]);
  if (r6.status >= 400) {
    console.log(`    ERR: ${r6.text.slice(0, 400)}`);
    result.failed = true;
    await saveCollected(persona.slug, collected);
    return result;
  }
  result.decision = "✓";

  // ── 7. Stage-B: render the PDF ──────────────────────────────────────
  const r7 = await post(`/api/cases/${caseId}/pdf`, {}, { withCode: true });
  collected.pdf = r7.json;
  stepLine("pdf", r7, [`bytes=${r7.json.bytes ?? "—"}`]);
  if (r7.status >= 400) {
    console.log(`    ERR: ${r7.text.slice(0, 400)}`);
    result.failed = true;
    await saveCollected(persona.slug, collected);
    return result;
  }
  result.pdf = "✓";
  result.pdfBytes = r7.json.bytes ?? "—";

  // Read back the persisted nudge plaintext so we can show its character
  // count in the summary table.
  const persistedPlaintext = collected.nudge_fire?.error
    ? null
    : null; // fire-nudge route doesn't return plaintext directly; could GET if needed
  result.nudgeChars = persistedPlaintext?.length ?? "—";

  await saveCollected(persona.slug, collected);
  return result;
}

function printSummary(results) {
  console.log("\n" + "═".repeat(120));
  console.log("TWO-STAGE FLOW SUMMARY (Stage A pre-call → Stage B post-call)");
  console.log("═".repeat(120));
  const hdr = ["PERSONA".padEnd(18), "CASE_ID".padEnd(36), "EXT", "LEAD", "FIRE", "POST", "GEN", "DEC", "PDF", "ARCHETYPE".padEnd(28), "PDF_BYTES"].join("  ");
  console.log(hdr);
  console.log("─".repeat(120));
  for (const r of results) {
    const row = [
      r.name.padEnd(18),
      String(r.caseId ?? "—").padEnd(36),
      String(r.extract).padEnd(3),
      String(r.lead).padEnd(4),
      String(r.nudgeFire).padEnd(4),
      String(r.postCall).padEnd(4),
      String(r.generate).padEnd(3),
      String(r.decision).padEnd(3),
      String(r.pdf).padEnd(3),
      String(r.archetype).slice(0, 28).padEnd(28),
      String(r.pdfBytes),
    ].join("  ");
    console.log(row);
  }
  console.log("═".repeat(120));
}

async function main() {
  console.log(`BASE              = ${BASE}`);
  console.log(`BDA_APPROVAL_CODE = ${BDA_CODE}`);
  console.log(`LEAD_PHONE        = ${LEAD_PHONE}`);
  console.log(`BDA_PHONE         = ${BDA_PHONE}`);

  const results = [];
  for (const persona of PERSONAS) {
    const r = await runPersona(persona);
    results.push(r);
  }

  printSummary(results);

  const anyFailed = results.some((r) => r.failed);
  if (anyFailed) {
    console.log("\nOne or more personas failed — exiting with code 1.");
    process.exit(1);
  } else {
    console.log("\nAll 3 personas completed the two-stage flow successfully.");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("[seed-two-stage] fatal:", e);
  process.exit(1);
});
