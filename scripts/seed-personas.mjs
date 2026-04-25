#!/usr/bin/env node
/**
 * Seeds 3 evaluator personas through the full pipeline:
 *   1. POST /api/cases/extract-profile
 *   2. POST /api/cases/new
 *   3. POST /api/cases/:id/generate
 *   4. POST /api/cases/:id/decision  (approve)
 *   5. POST /api/cases/:id/pdf
 *   6. POST /api/cases/:id/nudge
 *
 * Saves full response JSON to tmp/seed-<persona-slug>.json.
 * Prints a compact summary table at the end.
 *
 * Usage: BASE=http://localhost:3002 node scripts/seed-personas.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE             = process.env.BASE             || "http://localhost:3002";
const BDA_CODE         = process.env.BDA_APPROVAL_CODE || "SCALER-APPROVE-9421";
const LEAD_PHONE       = process.env.SMOKE_LEAD_PHONE  || "whatsapp:+15005550006";
const BDA_PHONE        = process.env.SMOKE_BDA_PHONE   || "whatsapp:+15005550006";
const LANGUAGE         = process.env.LANGUAGE          || "en-IN";
const BDA_NAME         = process.env.BDA_NAME          || "Anjali (BDA)";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR   = path.join(__dirname, "..", "tmp");

// ── helpers ────────────────────────────────────────────────────────────────

async function post(urlPath, body, opts = {}) {
  const url = `${BASE}${urlPath}`;
  const t0  = Date.now();
  const headers = { "Content-Type": "application/json" };
  if (opts.withCode) headers["x-bda-approval-code"] = BDA_CODE;
  const res  = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const ms   = Date.now() - t0;
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ms, json, text };
}

function stepLine(label, r, extraFields = []) {
  const tick   = r.status < 400 ? "✓" : "✗";
  const status = String(r.status).padEnd(3);
  const ms     = String(r.ms).padStart(5) + "ms";
  const extra  = extraFields.length ? "  " + extraFields.join("  ") : "";
  console.log(`  ${tick} ${label.padEnd(12)} ${status}  ${ms}${extra}`);
}

// ── personas ───────────────────────────────────────────────────────────────

const PERSONAS = [
  {
    name: "Rohan Sharma",
    slug: "rohan-sharma",
    profile_text: `Rohan Sharma is a 4-year SDE-2 at TCS Bangalore, currently on a Java/Spring backend modernization engagement for a US insurance client. He graduated B.Tech CSE from VIT in 2020 and earned an AWS Solutions Architect Associate certification in late 2023. Over the past six months he's been quietly applying to AI engineering roles at Razorpay, Atlassian, and a handful of YC startups — and getting rejected at the technical screen. He can read papers, but he can't ship a RAG pipeline end-to-end, and that gap is exactly what the interview loops are testing for. His friends from VIT are doing real ML work and he's tired of writing CRUD endpoints for someone else's roadmap. The 3.5L price tag for Scaler's AI engineering track is sitting heavy: his current CTC is 14 LPA and the salary jump quoted in marketing materials (16-22 LPA for AI roles) doesn't quite math out for him after factoring in tax. He's already done two free Andrew Ng courses and feels he's hit a ceiling on YouTube/Coursera content — he wants depth on production RAG, agents, and evals, not another theoretical ML refresher. He can stretch to 3.5L if EMI is on the table, but he's actively comparison-shopping with two cheaper bootcamps.`,
    transcript: `BDA: Hi Rohan, thanks for getting on. So you mentioned the AI engineering track — what's pulling you toward it now?

Rohan: Honestly, I've been at TCS for 4 years writing Java backends and I want out. I've been applying to AI eng roles for 6 months and getting rejected because I can read papers but I can't actually ship a RAG pipeline. So I need that hands-on depth.

BDA: Got it. That's exactly what the track is built for. What's holding you back?

Rohan: Two things. First — why should I pay 3.5 lakhs when Andrew Ng has put basically the same content out for free on Coursera? I've done two of his courses already.

BDA: Fair question. The free content gets you the theory. The track is built around shipping production systems — real RAG with vector stores, agentic workflows, evals you'd actually run in industry.

Rohan: Second — the realistic salary jump. You guys quote 16-22 LPA for AI roles. I'm at 14 LPA at TCS right now. After tax, 14 to 16 doesn't really math out for me.

BDA: I hear that. The 22 number is for stronger profiles — typically people who already have a year of applied ML or strong open-source work. For someone in your spot, the realistic range first year post-program is closer to 18-20.

Rohan: OK. And one more — is the curriculum actually RAG, agents, evals depth, or is it theoretical ML?

BDA: Applied. We can walk through the syllabus.`,
  },
  {
    name: "Karthik Iyer",
    slug: "karthik-iyer",
    profile_text: `Karthik Iyer is a 9-year Senior SWE at Google's Bangalore office, on the Search Quality team. He graduated dual-degree CS from IIT Madras in 2016. He is not price-sensitive — Google paid him roughly $400K total comp last year — but he is intensely time-sensitive and skeptical of anything that smells like a beginner cohort. He's looking at Scaler's AI/ML track because his internal team is rotating into LLM evaluation work and he wants to skill up faster than self-study allows, but he reads every page of the curriculum before committing his weekends. His questions are surgical: which instructors have actually shipped production AI systems versus only published academic papers; whether the cohort will include peers at his seniority or whether he'll be the senior-most by 5+ years; and what he'll specifically learn here that he can't pick up by reading the original Anthropic, OpenAI, and DeepMind papers. He'll exit after the first session if it feels remedial. He's done his homework — he already knows the names of three Scaler instructors and has cross-checked one of them on Google Scholar.`,
    transcript: `BDA: Hi Karthik, thanks for the time. You're at Google Search — what brought you to looking at Scaler?

Karthik: My team is rotating into LLM eval work and I want to skill up faster than self-study. But I have three questions before I commit a weekend.

BDA: Sure, go ahead.

Karthik: First — what would I actually learn here that I can't pick up from reading the Anthropic, OpenAI, and DeepMind papers directly? I'm already doing that.

BDA: The papers give you the what. The track gives you the how — production patterns, evaluation harnesses, debugging at scale. Practitioners who've shipped these systems telling you what doesn't work.

Karthik: Second — who's the cohort? If I'm the senior-most by five years, this is a waste of my time.

BDA: We do filter cohorts by experience tier. Your batch would be 6+ years average, several FAANG, a few tech leads.

Karthik: Third — instructors. I want people who shipped production AI systems, not academics with citations. I've already cross-checked one of your instructors on Google Scholar.

BDA: Most of our AI track instructors are from Microsoft, Adobe, and Flipkart's ML platforms. I can send you their detailed profiles.`,
  },
  {
    name: "Meera Patel",
    slug: "meera-patel",
    profile_text: `Meera Patel is in the final year of her B.Tech (CSE) at a Tier-3 engineering college in interior Maharashtra. Her family runs a small grocery shop; combined annual household income is approximately 2.8 lakhs. She has a confirmed offer from a state government IT department — 45,000 per month, joining July, with guaranteed pension and housing allowance — and her parents are pushing her to take it for the family stability. She has no LinkedIn presence yet. She's been quietly grinding LeetCode for 14 months and has built two personal projects: a college-fest registration app and a basic content-recommendation engine she trained on movie-rating data. She found Scaler through a friend's elder brother who placed at Walmart Labs after the DSA course. The 3.5L price for the program is more than her family earns in a year, so she's asked Scaler explicitly whether placement is guaranteed — her family is willing to sell their land if needed, but only with proof. The decision is jointly made with her parents, not a single phone call. She's anxious-positive: high motivation, high household risk-aversion, parents need to see government-job-equivalent certainty. The placement-guarantee question must be answered honestly — empty marketing language will lose this lead permanently.`,
    transcript: `BDA: Hi Meera, thanks for connecting. Your friend mentioned you have a government job offer in hand?

Meera: Yes, 45,000 a month, joining in July. My parents want me to take it. But I want to do something in tech — I've been doing LeetCode and small projects for over a year.

BDA: That's wonderful. What's the biggest question for you?

Meera: First and most important — can you guarantee I'll get a job through Scaler? Because if I turn down the government offer for this, my family loses a sure thing.

BDA: I want to be honest with you. We don't guarantee jobs — what we provide is mock interviews, portfolio coaching, and referrals to our 700+ partner companies. Outcomes data is on our placements page.

Meera: Second — 3.5 lakhs is more than my family earns in a year. How do other students from similar backgrounds afford this?

BDA: We have an income share agreement option — you pay nothing until you're placed at 5L+ CTC, then a percentage for 3 years. Some families also use education loans.

Meera: Third — what if I can't clear the entrance test? I'm from a Tier-3 college, my fundamentals might be weak.

BDA: There's a free 2-week prep before the test, and you can retake it twice. We don't filter aggressively at intake.`,
  },
];

// ── per-persona pipeline ────────────────────────────────────────────────────

async function runPersona(persona) {
  const collected = { persona: persona.name };
  const result = {
    name:      persona.name,
    caseId:    null,
    extract:   null,   // confidence string
    conf:      "—",
    generate:  null,   // ok/fail
    archetype: "—",
    questions: "—",
    sections:  "—",
    okRate:    "—",
    pdfBytes:  "—",
    nudgeChars:"—",
    failed:    false,
  };

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Persona: ${persona.name}`);
  console.log("─".repeat(60));

  // ── step 1: extract-profile ─────────────────────────────────────────────
  const r1 = await post("/api/cases/extract-profile", {
    profile_text: persona.profile_text,
    transcript:   persona.transcript,
    language:     LANGUAGE,
  });
  collected.extract = r1.json;
  const confShort = (r1.json.confidence ?? "").slice(0, 6) || "—";
  stepLine("extract", r1, [`conf=${confShort}`]);
  result.extract = r1.status < 400 ? "✓" : "✗";
  result.conf    = confShort;

  if (r1.status >= 400) {
    console.log(`    ERR: ${r1.text.slice(0, 400)}`);
    result.failed = true;
    await saveCollected(persona.slug, collected);
    return result;
  }

  const extractedProfile = r1.json.profile ?? {};

  // ── step 2: /api/cases/new ───────────────────────────────────────────────
  const r2 = await post("/api/cases/new", {
    profile:         extractedProfile,
    transcript:      persona.transcript,
    evaluator_phone: LEAD_PHONE,
    bda_whatsapp:    BDA_PHONE,
    bda_name:        BDA_NAME,
    language:        LANGUAGE,
  });
  collected.new = r2.json;
  stepLine("new", r2, [`case_id=${r2.json.case_id ?? "—"}`, `state=${r2.json.state ?? "—"}`]);

  if (r2.status >= 400) {
    console.log(`    ERR: ${r2.text.slice(0, 400)}`);
    result.failed = true;
    await saveCollected(persona.slug, collected);
    return result;
  }

  const caseId  = r2.json.case_id;
  result.caseId = caseId;

  // ── step 3: generate ─────────────────────────────────────────────────────
  const r3 = await post(`/api/cases/${caseId}/generate`, {});
  collected.generate = r3.json;
  stepLine("generate", r3, [
    `arch=${(r3.json.archetype ?? "").slice(0, 18)}`,
    `q=${r3.json.questions ?? "—"}`,
    `sec=${r3.json.sections ?? "—"}`,
  ]);

  if (r3.status >= 400) {
    console.log(`    ERR: ${r3.text.slice(0, 400)}`);
    result.failed = true;
    await saveCollected(persona.slug, collected);
    return result;
  }

  result.generate  = "✓";
  result.archetype = r3.json.archetype   ?? "—";
  result.questions = r3.json.questions   ?? "—";
  result.sections  = r3.json.sections    ?? "—";
  result.okRate    = r3.json.verify_stats?.ok_rate != null
    ? r3.json.verify_stats.ok_rate.toFixed(2)
    : "—";

  // ── step 4: decision (approve) ───────────────────────────────────────────
  const r4 = await post(`/api/cases/${caseId}/decision`, { action: "approved" }, { withCode: true });
  collected.decision = r4.json;
  stepLine("decision", r4, [`state=${r4.json.state ?? "—"}`]);

  if (r4.status >= 400) {
    console.log(`    ERR: ${r4.text.slice(0, 400)}`);
    result.failed = true;
    await saveCollected(persona.slug, collected);
    return result;
  }

  // ── step 5: pdf ──────────────────────────────────────────────────────────
  const r5 = await post(`/api/cases/${caseId}/pdf`, {}, { withCode: true });
  collected.pdf = r5.json;
  stepLine("pdf", r5, [`bytes=${r5.json.bytes ?? "—"}`, `pages=${r5.json.pages ?? "—"}`]);

  if (r5.status >= 400) {
    console.log(`    ERR: ${r5.text.slice(0, 400)}`);
    result.failed = true;
    await saveCollected(persona.slug, collected);
    return result;
  }

  result.pdfBytes = r5.json.bytes ?? "—";

  // ── step 6: nudge ────────────────────────────────────────────────────────
  const r6 = await post(`/api/cases/${caseId}/nudge`, {});
  collected.nudge = r6.json;
  const nudgeLen = (r6.json.whatsapp_plaintext ?? r6.json.markdown ?? "").length;
  stepLine("nudge", r6, [`chars=${nudgeLen}`]);

  if (r6.status >= 400) {
    console.log(`    ERR: ${r6.text.slice(0, 400)}`);
    result.failed = true;
    await saveCollected(persona.slug, collected);
    return result;
  }

  result.nudgeChars = nudgeLen;

  await saveCollected(persona.slug, collected);
  return result;
}

// ── file helpers ────────────────────────────────────────────────────────────

async function saveCollected(slug, data) {
  await fs.mkdir(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, `seed-${slug}.json`);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  console.log(`  → saved ${filePath}`);
}

// ── summary table ───────────────────────────────────────────────────────────

function printSummaryTable(results) {
  console.log("\n" + "═".repeat(110));
  console.log("SUMMARY");
  console.log("═".repeat(110));

  const COL = {
    PERSONA:   18,
    CASE_ID:   28,
    EXTRACT:    8,
    CONF:       6,
    GENERATE:   9,
    ARCHETYPE: 20,
    QUESTIONS: 10,
    SECTIONS:   9,
    OK_RATE:    8,
    PDF_BYTES: 10,
    NUDGE:      0,
  };

  const hdr = [
    "PERSONA".padEnd(COL.PERSONA),
    "CASE_ID".padEnd(COL.CASE_ID),
    "EXTRACT".padEnd(COL.EXTRACT),
    "CONF".padEnd(COL.CONF),
    "GENERATE".padEnd(COL.GENERATE),
    "ARCHETYPE".padEnd(COL.ARCHETYPE),
    "QUESTIONS".padEnd(COL.QUESTIONS),
    "SECTIONS".padEnd(COL.SECTIONS),
    "OK_RATE".padEnd(COL.OK_RATE),
    "PDF_BYTES".padEnd(COL.PDF_BYTES),
    "NUDGE_CHARS",
  ].join("  ");

  console.log(hdr);
  console.log("─".repeat(110));

  for (const r of results) {
    const row = [
      r.name.padEnd(COL.PERSONA),
      String(r.caseId ?? "—").padEnd(COL.CASE_ID),
      String(r.extract ?? "—").padEnd(COL.EXTRACT),
      String(r.conf).padEnd(COL.CONF),
      String(r.generate ?? (r.failed ? "✗" : "—")).padEnd(COL.GENERATE),
      String(r.archetype).padEnd(COL.ARCHETYPE),
      String(r.questions).padEnd(COL.QUESTIONS),
      String(r.sections).padEnd(COL.SECTIONS),
      String(r.okRate).padEnd(COL.OK_RATE),
      String(r.pdfBytes).padEnd(COL.PDF_BYTES),
      String(r.nudgeChars),
    ].join("  ");
    console.log(row);
  }

  console.log("═".repeat(110));
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`BASE = ${BASE}`);
  console.log(`BDA_APPROVAL_CODE = ${BDA_CODE}`);
  console.log(`LEAD_PHONE = ${LEAD_PHONE}`);
  console.log(`BDA_PHONE  = ${BDA_PHONE}`);

  const results = [];
  for (const persona of PERSONAS) {
    const r = await runPersona(persona);
    results.push(r);
  }

  printSummaryTable(results);

  const anyFailed = results.some((r) => r.failed);
  if (anyFailed) {
    console.log("\nOne or more personas failed — exiting with code 1.");
    process.exit(1);
  } else {
    console.log("\nAll 3 personas completed successfully.");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("[seed-personas] fatal:", e);
  process.exit(1);
});
