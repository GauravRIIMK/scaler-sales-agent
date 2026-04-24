"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProfileFields {
  name: string;
  role: string;
  company: string;
  years_experience: string;
  location: string;
  education: string;
  goals: string;
  concerns: string;
  budget_range: string;
}

type CallSource = "transcript" | "audio";
type Language = "en-IN" | "en-US" | "hi";

// ---------------------------------------------------------------------------
// Pipeline step definitions
// ---------------------------------------------------------------------------

const PIPELINE_STEPS = [
  "Creating case",
  "Transcribing",
  "Extracting questions",
  "Inferring persona",
  "Retrieving grounding",
  "Drafting PDF",
  "Verifying",
  "Rendering",
  "Nudge drafted",
  "Done",
] as const;

type PipelineStep = (typeof PIPELINE_STEPS)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_PROFILE: ProfileFields = {
  name: "",
  role: "",
  company: "",
  years_experience: "",
  location: "",
  education: "",
  goals: "",
  concerns: "",
  budget_range: "",
};

function phoneWarning(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("+")) return "Phone should start with + (E.164 format, e.g. +91XXXXXXXXXX)";
  return null;
}

function profileToJson(fields: ProfileFields, jsonOverride: string): Record<string, unknown> {
  if (jsonOverride.trim()) {
    return JSON.parse(jsonOverride.trim());
  }
  const out: Record<string, unknown> = {};
  if (fields.name.trim()) out.name = fields.name.trim();
  if (fields.role.trim()) out.role = fields.role.trim();
  if (fields.company.trim()) out.company = fields.company.trim();
  if (fields.years_experience.trim()) {
    const n = parseInt(fields.years_experience.trim(), 10);
    out.years_experience = isNaN(n) ? fields.years_experience.trim() : n;
  }
  if (fields.location.trim()) out.location = fields.location.trim();
  if (fields.education.trim()) out.education = fields.education.trim();
  if (fields.goals.trim()) {
    out.goals = fields.goals
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }
  if (fields.concerns.trim()) {
    out.concerns = fields.concerns
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }
  if (fields.budget_range.trim()) out.budget_range = fields.budget_range.trim();
  return out;
}

function fieldLabel(
  label: string,
  required?: boolean,
  hint?: string
): React.ReactElement {
  return (
    <label className="mb-1 block text-sm font-medium text-slate-700">
      {label}
      {required && <span className="ml-0.5 text-rose-500">*</span>}
      {hint && <span className="ml-2 font-normal text-slate-400 text-xs">{hint}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-base font-semibold text-slate-800 border-b border-slate-200 pb-1.5 mb-4">
      {children}
    </h2>
  );
}

function PhoneField({
  label,
  value,
  onChange,
  disabled,
  required,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  required?: boolean;
  hint?: string;
}) {
  const warn = phoneWarning(value);
  return (
    <div>
      {fieldLabel(label, required, hint)}
      <input
        type="tel"
        className={`w-full rounded border p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 ${
          warn ? "border-amber-400 bg-amber-50" : "border-slate-300"
        }`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="+91XXXXXXXXXX"
        disabled={disabled}
      />
      {warn && <p className="mt-1 text-xs text-amber-700">{warn}</p>}
    </div>
  );
}

function StepIndicator({
  completedSteps,
  busy,
}: {
  completedSteps: Set<PipelineStep>;
  busy: boolean;
}) {
  if (!busy && completedSteps.size === 0) return null;
  return (
    <div className="rounded border border-slate-200 bg-slate-50 p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Progress
      </p>
      <ol className="space-y-1.5">
        {PIPELINE_STEPS.map((step) => {
          const done = completedSteps.has(step);
          const isActive = busy && !done && (() => {
            const doneCount = completedSteps.size;
            return PIPELINE_STEPS.indexOf(step) === doneCount;
          })();
          return (
            <li key={step} className="flex items-center gap-2 text-sm">
              <span
                className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  done
                    ? "bg-emerald-100 text-emerald-700"
                    : isActive
                    ? "bg-slate-200 text-slate-500"
                    : "text-slate-300"
                }`}
              >
                {done ? "✓" : "\u2013"}
              </span>
              <span
                className={
                  done
                    ? "text-emerald-700"
                    : isActive
                    ? "font-medium text-slate-700"
                    : "text-slate-400"
                }
              >
                {step}
                {isActive && (
                  <span className="ml-1 inline-block animate-pulse text-slate-400">...</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main form
// ---------------------------------------------------------------------------

const TRANSCRIPT_PLACEHOLDER = `LEAD: I'm six years in as a PM — how does the curriculum help me move into an AI product role?
BDA: Tell me what you've tried so far...
LEAD: I built a RAG POC at work but I don't know if I can justify the fee to my spouse.`;

export function NewCaseForm() {
  const router = useRouter();

  // Profile
  const [profileFields, setProfileFields] = useState<ProfileFields>(EMPTY_PROFILE);
  const [profileJsonOverride, setProfileJsonOverride] = useState("");

  // Call
  const [callSource, setCallSource] = useState<CallSource>("transcript");
  const [transcript, setTranscript] = useState("");
  const [audio, setAudio] = useState<File | null>(null);

  // Recipients
  const [leadPhone, setLeadPhone] = useState("");
  const [bdaPhone, setBdaPhone] = useState("");
  const [bdaName, setBdaName] = useState("");
  const [language, setLanguage] = useState<Language>("en-IN");

  // Options
  const [runGenerate, setRunGenerate] = useState(true);
  const [runNudge, setRunNudge] = useState(true);

  // State
  const [busy, setBusy] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<Set<PipelineStep>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  function markStep(step: PipelineStep) {
    setCompletedSteps((prev) => new Set([...prev, step]));
  }

  function setField(key: keyof ProfileFields) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setProfileFields((prev) => ({ ...prev, [key]: e.target.value }));
    };
  }

  // ------------------------------------------------------------------
  // Validation
  // ------------------------------------------------------------------

  function validate(): string | null {
    if (profileJsonOverride.trim()) {
      try {
        const parsed = JSON.parse(profileJsonOverride.trim());
        if (typeof parsed !== "object" || Array.isArray(parsed)) {
          return "Advanced JSON must be a JSON object (not array or primitive)";
        }
      } catch {
        return "Advanced JSON is not valid JSON";
      }
    } else {
      if (!profileFields.name.trim()) return "Lead name is required";
    }

    if (callSource === "transcript" && !transcript.trim()) {
      return "Transcript text is required when 'Transcript' source is selected";
    }
    if (callSource === "audio" && !audio) {
      return "Select an audio file or switch to transcript input";
    }

    const leadWarn = phoneWarning(leadPhone);
    const bdaWarn = phoneWarning(bdaPhone);
    if (leadWarn) return `Lead WhatsApp: ${leadWarn}`;
    if (bdaWarn) return `BDA WhatsApp: ${bdaWarn}`;

    return null;
  }

  // ------------------------------------------------------------------
  // Submit
  // ------------------------------------------------------------------

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setCompletedSteps(new Set());
    setBusy(true);

    try {
      const validationError = validate();
      if (validationError) throw new Error(validationError);

      // Build profile
      let profileParsed: Record<string, unknown>;
      try {
        profileParsed = profileToJson(profileFields, profileJsonOverride);
      } catch {
        throw new Error("Could not parse advanced profile JSON");
      }

      if (Object.keys(profileParsed).length === 0) {
        throw new Error("Profile must have at least one field");
      }

      // POST /api/cases/new
      let createRes: Response;
      const useAudio = callSource === "audio" && audio !== null;

      if (useAudio) {
        const form = new FormData();
        form.set("profile", JSON.stringify(profileParsed));
        if (transcript.trim()) form.set("transcript", transcript);
        if (leadPhone.trim()) form.set("evaluator_phone", leadPhone.trim());
        if (bdaPhone.trim()) form.set("bda_whatsapp", bdaPhone.trim());
        if (bdaName.trim()) form.set("bda_name", bdaName.trim());
        form.set("language", language);
        form.set("audio", audio!);
        createRes = await fetch("/api/cases/new", { method: "POST", body: form });
      } else {
        createRes = await fetch("/api/cases/new", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            profile: profileParsed,
            transcript: transcript.trim() || undefined,
            evaluator_phone: leadPhone.trim() || undefined,
            bda_whatsapp: bdaPhone.trim() || undefined,
            bda_name: bdaName.trim() || undefined,
            language,
          }),
        });
      }

      const createJson = await createRes.json();
      if (!createRes.ok) throw new Error(createJson.error ?? `HTTP ${createRes.status}`);
      const caseId = createJson.case_id as string;
      markStep("Creating case");

      if (runGenerate) {
        // Transcribing step fires only if audio was submitted
        if (useAudio) markStep("Transcribing");

        markStep("Extracting questions");
        const genRes = await fetch(`/api/cases/${caseId}/generate`, { method: "POST" });
        const genJson = await genRes.json();
        if (!genRes.ok) throw new Error(genJson.error ?? `HTTP ${genRes.status}`);
        markStep("Inferring persona");
        markStep("Retrieving grounding");
        markStep("Drafting PDF");
        markStep("Verifying");

        const pdfRes = await fetch(`/api/cases/${caseId}/pdf`, { method: "POST" });
        const pdfJson = await pdfRes.json();
        if (!pdfRes.ok) throw new Error(pdfJson.error ?? `HTTP ${pdfRes.status}`);
        markStep("Rendering");
      }

      if (runNudge) {
        const nudgeRes = await fetch(`/api/cases/${caseId}/nudge`, { method: "POST" });
        const nudgeJson = await nudgeRes.json();
        if (!nudgeRes.ok) throw new Error(nudgeJson.error ?? `HTTP ${nudgeRes.status}`);
        markStep("Nudge drafted");
      }

      markStep("Done");
      router.push(`/cases/${caseId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------
  // Summary checklist for sticky bar
  // ------------------------------------------------------------------

  const hasProfile = profileJsonOverride.trim()
    ? true
    : !!profileFields.name.trim();
  const hasCall =
    callSource === "transcript" ? !!transcript.trim() : !!audio;

  return (
    <form onSubmit={submit} className="space-y-8">

      {/* ----------------------------------------------------------------
          Estimated time notice
      ---------------------------------------------------------------- */}
      <p className="rounded border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
        Generation takes approximately 2 minutes for a 5-minute call. Keep this tab open until redirected.
      </p>

      {/* ================================================================
          Section 1 — Lead profile
      ================================================================ */}
      <section className="space-y-4">
        <SectionHeading>1. Lead profile</SectionHeading>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Name */}
          <div>
            {fieldLabel("Lead name", true)}
            <input
              type="text"
              className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={profileFields.name}
              onChange={setField("name")}
              placeholder="Priya Rao"
              disabled={busy || !!profileJsonOverride.trim()}
            />
          </div>

          {/* Role */}
          <div>
            {fieldLabel("Role / current designation")}
            <input
              type="text"
              className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={profileFields.role}
              onChange={setField("role")}
              placeholder="Senior Product Manager"
              disabled={busy || !!profileJsonOverride.trim()}
            />
          </div>

          {/* Company */}
          <div>
            {fieldLabel("Current company")}
            <input
              type="text"
              className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={profileFields.company}
              onChange={setField("company")}
              placeholder="Flipkart"
              disabled={busy || !!profileJsonOverride.trim()}
            />
          </div>

          {/* Years experience */}
          <div>
            {fieldLabel("Years of experience")}
            <input
              type="number"
              min={0}
              max={50}
              className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={profileFields.years_experience}
              onChange={setField("years_experience")}
              placeholder="6"
              disabled={busy || !!profileJsonOverride.trim()}
            />
          </div>

          {/* Location */}
          <div>
            {fieldLabel("Current location")}
            <input
              type="text"
              className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={profileFields.location}
              onChange={setField("location")}
              placeholder="Bangalore"
              disabled={busy || !!profileJsonOverride.trim()}
            />
          </div>

          {/* Education */}
          <div>
            {fieldLabel("Education")}
            <input
              type="text"
              className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={profileFields.education}
              onChange={setField("education")}
              placeholder="B.Tech, IIIT-Hyderabad"
              disabled={busy || !!profileJsonOverride.trim()}
            />
          </div>

          {/* Budget range */}
          <div className="sm:col-span-2">
            {fieldLabel("Budget range", false, "helps persona vector")}
            <input
              type="text"
              className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={profileFields.budget_range}
              onChange={setField("budget_range")}
              placeholder="INR 3-5L"
              disabled={busy || !!profileJsonOverride.trim()}
            />
          </div>
        </div>

        {/* Goals */}
        <div>
          {fieldLabel("Goals", false, "one per line")}
          <textarea
            className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            rows={3}
            value={profileFields.goals}
            onChange={setField("goals")}
            placeholder={"Move into AI product roles\nLearn to work with LLMs hands-on"}
            disabled={busy || !!profileJsonOverride.trim()}
          />
        </div>

        {/* Concerns */}
        <div>
          {fieldLabel("Concerns stated on call", false, "one per line")}
          <textarea
            className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            rows={3}
            value={profileFields.concerns}
            onChange={setField("concerns")}
            placeholder={"Fee justification to spouse\nUncertain about time commitment"}
            disabled={busy || !!profileJsonOverride.trim()}
          />
        </div>

        {/* Advanced JSON override */}
        <details className="rounded border border-slate-200">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50">
            Advanced: paste profile JSON (overrides structured fields above)
          </summary>
          <div className="border-t border-slate-200 p-3">
            <textarea
              className="w-full rounded border border-slate-200 p-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-slate-400"
              rows={8}
              value={profileJsonOverride}
              onChange={(e) => setProfileJsonOverride(e.target.value)}
              placeholder={'{\n  "name": "Priya Rao",\n  "role": "Product Manager",\n  "company": "Flipkart",\n  "years_experience": 6,\n  "location": "Bengaluru"\n}'}
              disabled={busy}
            />
            {profileJsonOverride.trim() && (
              <p className="mt-1 text-xs text-amber-700">
                Structured fields above are ignored while JSON is pasted here.
              </p>
            )}
          </div>
        </details>
      </section>

      {/* ================================================================
          Section 2 — Call
      ================================================================ */}
      <section className="space-y-4">
        <SectionHeading>2. Call</SectionHeading>

        {/* Source toggle */}
        <div className="flex gap-4">
          {(["transcript", "audio"] as const).map((src) => (
            <label
              key={src}
              className="inline-flex cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="callSource"
                value={src}
                checked={callSource === src}
                onChange={() => setCallSource(src)}
                disabled={busy}
                className="accent-slate-700"
              />
              {src === "transcript" ? "Transcript (paste text)" : "Audio (upload file)"}
            </label>
          ))}
        </div>

        {/* Transcript textarea */}
        {callSource === "transcript" && (
          <div>
            {fieldLabel("Call transcript", true)}
            <textarea
              className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              rows={9}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder={TRANSCRIPT_PLACEHOLDER}
              disabled={busy}
            />
            <p className="mt-1 text-xs text-slate-500">
              LEAD: / BDA: speaker prefixes are recognised. Loose plaintext is treated as a single LEAD turn.
            </p>
          </div>
        )}

        {/* Audio upload */}
        {callSource === "audio" && (
          <div>
            {fieldLabel("Audio file", true, "mp3 / wav, max 40 MB — transcribed via Deepgram")}
            <input
              type="file"
              accept="audio/*"
              className="block w-full rounded border border-slate-300 p-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200"
              onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
              disabled={busy}
            />
            {audio && (
              <p className="mt-1 text-xs text-slate-500">
                Selected: {audio.name} ({(audio.size / (1024 * 1024)).toFixed(1)} MB)
              </p>
            )}
          </div>
        )}
      </section>

      {/* ================================================================
          Section 3 — Recipients
      ================================================================ */}
      <section className="space-y-4">
        <SectionHeading>3. Recipients</SectionHeading>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Lead WhatsApp */}
          <PhoneField
            label="Lead WhatsApp"
            value={leadPhone}
            onChange={setLeadPhone}
            disabled={busy}
            hint="recipient of final PDF"
          />

          {/* BDA WhatsApp */}
          <PhoneField
            label="BDA WhatsApp"
            value={bdaPhone}
            onChange={setBdaPhone}
            disabled={busy}
            hint="recipient of pre-call nudge"
          />

          {/* BDA name */}
          <div>
            {fieldLabel("BDA name", false, "shown on nudge message")}
            <input
              type="text"
              className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={bdaName}
              onChange={(e) => setBdaName(e.target.value)}
              placeholder="Rajan"
              disabled={busy}
            />
          </div>

          {/* Language */}
          <div>
            {fieldLabel("Language")}
            <select
              className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
              disabled={busy}
            >
              <option value="en-IN">English (en-IN)</option>
              <option value="en-US">English (en-US)</option>
              <option value="hi">Hindi (hi)</option>
            </select>
          </div>
        </div>
      </section>

      {/* ================================================================
          Auto-run options
      ================================================================ */}
      <fieldset className="rounded border border-slate-200 p-3">
        <legend className="px-1 text-xs font-medium text-slate-500">
          Auto-run after create
        </legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={runGenerate}
              onChange={(e) => setRunGenerate(e.target.checked)}
              disabled={busy}
              className="accent-slate-700"
            />
            Generate + render PDF
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={runNudge}
              onChange={(e) => setRunNudge(e.target.checked)}
              disabled={busy}
              className="accent-slate-700"
            />
            Generate BDA nudge
          </label>
        </div>
      </fieldset>

      {/* ================================================================
          Sticky submit bar
      ================================================================ */}
      <div className="sticky bottom-0 z-10 -mx-6 border-t border-slate-200 bg-white/90 px-6 py-3 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-4">
          {/* Checklist summary */}
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            <li className={hasProfile ? "text-emerald-700" : ""}>
              {hasProfile ? "[+]" : "[ ]"} Profile
            </li>
            <li className={hasCall ? "text-emerald-700" : ""}>
              {hasCall ? "[+]" : "[ ]"} {callSource === "transcript" ? "Transcript" : "Audio"}
            </li>
            <li className={leadPhone.trim() ? "text-emerald-700" : ""}>
              {leadPhone.trim() ? "[+]" : "[ ]"} Lead WhatsApp
            </li>
            <li className={bdaPhone.trim() ? "text-emerald-700" : ""}>
              {bdaPhone.trim() ? "[+]" : "[ ]"} BDA WhatsApp
            </li>
          </ul>

          <button
            type="submit"
            disabled={busy}
            className="shrink-0 rounded bg-slate-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-50"
          >
            {busy ? "Working..." : "Create case"}
          </button>
        </div>
      </div>

      {/* ================================================================
          Error
      ================================================================ */}
      {err && (
        <div className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">
          {err}
        </div>
      )}

      {/* ================================================================
          Step indicator
      ================================================================ */}
      <StepIndicator completedSteps={completedSteps} busy={busy} />
    </form>
  );
}
