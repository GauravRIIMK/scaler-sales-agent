"use client";

import { useEffect, useMemo, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { getSamplePersona, type SamplePersona } from "@/lib/samplePersonas";

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
  intent: string;
  goals: string;
  concerns: string;
  budget_range: string;
  linkedin: string;
}

interface ExtractMeta {
  confidence: string;
  missing_fields: string[];
  reasoning: string;
}

type Language = "en-IN" | "en-US" | "hi";

interface CreateLeadResult {
  lead_id: string;
  state: string;
  scheduled_call_at: string;
  fires_at: string;
  lead_minutes: number;
  fire_now_url: string;
  post_call_url: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMPTY_PROFILE: ProfileFields = {
  name: "",
  role: "",
  company: "",
  years_experience: "",
  location: "",
  education: "",
  intent: "",
  goals: "",
  concerns: "",
  budget_range: "",
  linkedin: "",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  if (fields.intent.trim()) out.intent = fields.intent.trim();
  if (fields.budget_range.trim()) out.budget_range = fields.budget_range.trim();
  if (fields.linkedin.trim()) out.linkedin = fields.linkedin.trim();
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
  return out;
}

/** Build a value compatible with <input type="datetime-local"> from a Date. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function fieldLabel(
  label: string,
  required?: boolean,
  hint?: string,
  htmlFor?: string
): React.ReactElement {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-slate-700">
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
  id,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  required?: boolean;
  hint?: string;
  id: string;
}) {
  const warn = phoneWarning(value);
  return (
    <div>
      {fieldLabel(label, required, hint, id)}
      <input
        id={id}
        type="tel"
        className={`w-full rounded border p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 ${
          warn ? "border-amber-400 bg-amber-50" : "border-slate-300"
        }`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="+91XXXXXXXXXX"
        disabled={disabled}
        aria-required={required ? "true" : undefined}
      />
      {warn && <p className="mt-1 text-xs text-amber-700">{warn}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main form
// ---------------------------------------------------------------------------

function NewLeadFormInner() {
  // Profile
  const [profileFields, setProfileFields] = useState<ProfileFields>(EMPTY_PROFILE);
  const [profileJsonOverride, setProfileJsonOverride] = useState("");

  // Lead context paragraph + extract state
  const [paragraphText, setParagraphText] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractMeta, setExtractMeta] = useState<ExtractMeta | null>(null);
  const [showManualFields, setShowManualFields] = useState(false);
  const [extractDone, setExtractDone] = useState(false);

  // Schedule — default to 1h 15m from now so nudge fires in ~15 min by default
  const defaultCallAt = useMemo(() => {
    const d = new Date(Date.now() + 75 * 60 * 1000);
    return toLocalInputValue(d);
  }, []);
  const [scheduledCallAt, setScheduledCallAt] = useState(defaultCallAt);

  // Recipients
  const [bdaPhone, setBdaPhone] = useState("");
  const [bdaName, setBdaName] = useState("");
  const [evaluatorPhone, setEvaluatorPhone] = useState("");
  const [language, setLanguage] = useState<Language>("en-IN");

  // State
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CreateLeadResult | null>(null);
  const [firing, setFiring] = useState(false);
  const [fireResult, setFireResult] = useState<string | null>(null);
  const [fireError, setFireError] = useState<string | null>(null);

  // Prefill state
  const searchParams = useSearchParams();
  const [prefillPersona, setPrefillPersona] = useState<SamplePersona | null>(null);

  // On mount: read ?prefill=<slug> and sessionStorage evaluator_phone
  useEffect(() => {
    const slug = searchParams.get("prefill");
    if (slug) {
      const persona = getSamplePersona(slug);
      if (persona) {
        setPrefillPersona(persona);
        setParagraphText(persona.profileText);
      }
    }

    try {
      const stored = sessionStorage.getItem("evaluator_phone");
      if (stored) {
        setBdaPhone((prev) => (prev.trim() ? prev : stored));
        setEvaluatorPhone((prev) => (prev.trim() ? prev : stored));
      }
    } catch {
      // private browsing — ignore
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleClearPrefill() {
    setPrefillPersona(null);
    setParagraphText("");
    setProfileFields(EMPTY_PROFILE);
    setExtractMeta(null);
    setExtractDone(false);
    setShowManualFields(false);
    setExtractError(null);
  }

  function setField(key: keyof ProfileFields) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setProfileFields((prev) => ({ ...prev, [key]: e.target.value }));
    };
  }

  // ------------------------------------------------------------------
  // Extract profile from paragraph
  // ------------------------------------------------------------------

  async function handleExtract() {
    setExtractError(null);
    setExtracting(true);
    try {
      const res = await fetch("/api/cases/extract-profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile_text: paragraphText, language }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);

      const extracted = json.profile ?? json;
      setProfileFields({
        name: typeof extracted.name === "string" ? extracted.name : "",
        role: typeof extracted.role === "string" ? extracted.role : "",
        company: typeof extracted.company === "string" ? extracted.company : "",
        years_experience:
          extracted.years_experience !== undefined
            ? String(extracted.years_experience)
            : "",
        location: typeof extracted.location === "string" ? extracted.location : "",
        education: typeof extracted.education === "string" ? extracted.education : "",
        intent: typeof extracted.intent === "string" ? extracted.intent : "",
        goals: Array.isArray(extracted.goals)
          ? extracted.goals.join("\n")
          : typeof extracted.goals === "string"
          ? extracted.goals
          : "",
        concerns: Array.isArray(extracted.concerns)
          ? extracted.concerns.join("\n")
          : typeof extracted.concerns === "string"
          ? extracted.concerns
          : "",
        budget_range:
          typeof extracted.budget_range === "string" ? extracted.budget_range : "",
        linkedin: typeof extracted.linkedin === "string" ? extracted.linkedin : "",
      });
      setExtractMeta({
        confidence: typeof json.confidence === "string" ? json.confidence : "unknown",
        missing_fields: Array.isArray(json.missing_fields) ? json.missing_fields : [],
        reasoning: typeof json.reasoning === "string" ? json.reasoning : "",
      });
      setExtractDone(true);
      setShowManualFields(true);
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : String(e));
    } finally {
      setExtracting(false);
    }
  }

  function handleClearAndRepaste() {
    setProfileFields(EMPTY_PROFILE);
    setExtractMeta(null);
    setExtractDone(false);
    setShowManualFields(false);
    setExtractError(null);
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
      if (!profileFields.name.trim()) {
        if (!extractDone && !showManualFields) {
          return "You haven't extracted a profile yet. Click Extract first or reveal the manual fields.";
        }
        return "Lead name is required";
      }
    }

    if (!bdaPhone.trim()) return "BDA WhatsApp is required — that's where the nudge goes";
    const bdaWarn = phoneWarning(bdaPhone);
    if (bdaWarn) return `BDA WhatsApp: ${bdaWarn}`;

    if (evaluatorPhone.trim()) {
      const evalWarn = phoneWarning(evaluatorPhone);
      if (evalWarn) return `Evaluator WhatsApp: ${evalWarn}`;
    }

    if (!scheduledCallAt) return "Scheduled call time is required";
    const dt = new Date(scheduledCallAt);
    if (Number.isNaN(dt.getTime())) return "Scheduled call time is not a valid timestamp";

    return null;
  }

  // ------------------------------------------------------------------
  // Submit
  // ------------------------------------------------------------------

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    setResult(null);
    setFireResult(null);
    setFireError(null);

    try {
      const validationError = validate();
      if (validationError) throw new Error(validationError);

      let profileParsed: Record<string, unknown>;
      try {
        profileParsed = profileToJson(profileFields, profileJsonOverride);
      } catch {
        throw new Error("Could not parse advanced profile JSON");
      }

      if (Object.keys(profileParsed).length === 0) {
        throw new Error("Profile must have at least one field");
      }

      // datetime-local gives "YYYY-MM-DDTHH:mm" without timezone — interpret
      // in the browser's local zone, then send ISO.
      const isoCallAt = new Date(scheduledCallAt).toISOString();

      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: profileParsed,
          bda_whatsapp: bdaPhone.trim(),
          evaluator_phone: evaluatorPhone.trim() || undefined,
          bda_name: bdaName.trim() || undefined,
          scheduled_call_at: isoCallAt,
          language,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);

      setResult(json as CreateLeadResult);

      // Persist evaluator phone to sessionStorage for the landing page
      const phoneToSave = evaluatorPhone.trim() || bdaPhone.trim();
      if (phoneToSave) {
        try {
          if (!sessionStorage.getItem("evaluator_phone")) {
            sessionStorage.setItem("evaluator_phone", phoneToSave);
          }
        } catch {
          // private browsing — ignore
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------
  // Fire nudge now (post-create action)
  // ------------------------------------------------------------------

  async function handleFireNow() {
    if (!result) return;
    setFiring(true);
    setFireError(null);
    setFireResult(null);
    try {
      const res = await fetch(result.fire_now_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setFireResult(
        `Sent to ${json.recipient ?? "BDA"} (sid: ${json.twilio_sid ?? "n/a"}, status: ${
          json.status ?? "ok"
        })`
      );
    } catch (e) {
      setFireError(e instanceof Error ? e.message : String(e));
    } finally {
      setFiring(false);
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  const hasProfile = profileJsonOverride.trim() ? true : !!profileFields.name.trim();
  const hasSchedule = !!scheduledCallAt;
  const hasBda = !!bdaPhone.trim() && !phoneWarning(bdaPhone);

  return (
    <form onSubmit={submit} className="space-y-8">
      {/* Prefill banner */}
      {prefillPersona && (
        <div className="flex items-center justify-between gap-3 rounded border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-700">
          <span>
            Sample loaded:{" "}
            <span className="font-medium">{prefillPersona.shortName}</span>. Edit any field
            before submitting.
          </span>
          <button
            type="button"
            onClick={handleClearPrefill}
            className="shrink-0 text-xs text-slate-500 underline hover:text-slate-800"
          >
            Clear sample
          </button>
        </div>
      )}

      {/* What you'll see explainer */}
      <p className="rounded border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
        Submitting creates the lead row in <span className="font-mono">nudge_scheduled</span>.
        The cron will fire the WhatsApp nudge to the BDA at the time computed below. You can also
        fire immediately for a demo.
      </p>

      {/* ================================================================
          Section 1 — Lead profile
      ================================================================ */}
      <section className="space-y-4">
        <SectionHeading>1. Lead profile (CRM data — no transcript yet)</SectionHeading>

        <div className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            {fieldLabel("Lead context", true, undefined, "lead-context")}
            {extractDone && (
              <button
                type="button"
                onClick={handleClearAndRepaste}
                disabled={busy}
                className="shrink-0 text-xs text-slate-500 underline hover:text-slate-700 disabled:opacity-50"
              >
                Clear and re-paste
              </button>
            )}
          </div>
          <p className="text-xs text-slate-500">
            Paste any prose describing this lead — LinkedIn bio, intake form output, sales-ops
            notes. We&apos;ll extract the structured profile automatically. You can edit before
            submitting.
          </p>
          <textarea
            id="lead-context"
            className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            rows={6}
            value={paragraphText}
            onChange={(e) => setParagraphText(e.target.value)}
            placeholder={
              "e.g. Rohan is a 4-year SDE-2 at TCS in Bangalore. B.Tech CSE, VIT 2020. Wants to move into AI engineering — built a RAG POC at work but stuck on production deployment. Concerned about the 3.5L price on his 14 LPA salary."
            }
            disabled={busy}
            aria-required="true"
          />

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleExtract}
              disabled={busy || extracting || paragraphText.trim().length < 20}
              className="rounded bg-slate-700 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-slate-600 disabled:opacity-40"
            >
              {extracting ? "Extracting…" : "Extract profile"}
            </button>
            {paragraphText.trim().length > 0 && paragraphText.trim().length < 20 && (
              <span className="text-xs text-slate-400">
                Add {20 - paragraphText.trim().length} more character
                {20 - paragraphText.trim().length === 1 ? "" : "s"} to enable
              </span>
            )}
          </div>

          {extractError && (
            <div
              role="alert"
              aria-live="assertive"
              className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-800"
            >
              {extractError}
            </div>
          )}
        </div>

        {extractMeta && (
          <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs space-y-1">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>
                <span className="font-medium text-slate-600">Confidence:</span>{" "}
                <span
                  className={
                    extractMeta.confidence === "high"
                      ? "text-emerald-700"
                      : extractMeta.confidence === "low"
                      ? "text-amber-700"
                      : "text-slate-600"
                  }
                >
                  {extractMeta.confidence}
                </span>
              </span>
              {extractMeta.missing_fields.length > 0 && (
                <span>
                  <span className="font-medium text-slate-600">Missing:</span>{" "}
                  <span className="text-amber-700">
                    [{extractMeta.missing_fields.join(", ")}]
                  </span>
                </span>
              )}
            </div>
            {extractMeta.reasoning && (
              <p className="text-slate-500 italic">{extractMeta.reasoning}</p>
            )}
          </div>
        )}

        {(showManualFields || extractDone) && (
          <div className="rounded border border-slate-200 p-4 space-y-4">
            <p className="text-xs font-medium text-slate-500">
              {extractDone ? "Extracted profile (editable)" : "Manual profile fields"}
            </p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                {fieldLabel("Lead name", true, undefined, "lead-name")}
                <input
                  id="lead-name"
                  type="text"
                  className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                  value={profileFields.name}
                  onChange={setField("name")}
                  placeholder="Rohan Sharma"
                  disabled={busy || !!profileJsonOverride.trim()}
                  aria-required="true"
                />
              </div>

              <div>
                {fieldLabel("Role / current designation", undefined, undefined, "lead-role")}
                <input
                  id="lead-role"
                  type="text"
                  className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                  value={profileFields.role}
                  onChange={setField("role")}
                  placeholder="SDE-2"
                  disabled={busy || !!profileJsonOverride.trim()}
                />
              </div>

              <div>
                {fieldLabel("Current company", undefined, undefined, "lead-company")}
                <input
                  id="lead-company"
                  type="text"
                  className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                  value={profileFields.company}
                  onChange={setField("company")}
                  placeholder="TCS"
                  disabled={busy || !!profileJsonOverride.trim()}
                />
              </div>

              <div>
                {fieldLabel("Years of experience", undefined, undefined, "lead-yoe")}
                <input
                  id="lead-yoe"
                  type="number"
                  min={0}
                  max={50}
                  className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                  value={profileFields.years_experience}
                  onChange={setField("years_experience")}
                  placeholder="4"
                  disabled={busy || !!profileJsonOverride.trim()}
                />
              </div>

              <div>
                {fieldLabel("Location", undefined, undefined, "lead-location")}
                <input
                  id="lead-location"
                  type="text"
                  className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                  value={profileFields.location}
                  onChange={setField("location")}
                  placeholder="Bangalore"
                  disabled={busy || !!profileJsonOverride.trim()}
                />
              </div>

              <div>
                {fieldLabel("Education", undefined, undefined, "lead-edu")}
                <input
                  id="lead-edu"
                  type="text"
                  className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                  value={profileFields.education}
                  onChange={setField("education")}
                  placeholder="B.Tech CSE, VIT 2020"
                  disabled={busy || !!profileJsonOverride.trim()}
                />
              </div>

              <div className="sm:col-span-2">
                {fieldLabel("Intent line", false, "one-liner from CRM (why they raised their hand)", "lead-intent")}
                <input
                  id="lead-intent"
                  type="text"
                  className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                  value={profileFields.intent}
                  onChange={setField("intent")}
                  placeholder="Wants to break into AI engineering roles in 6 months"
                  disabled={busy || !!profileJsonOverride.trim()}
                />
              </div>

              <div>
                {fieldLabel("Budget range", false, "helps persona vector", "lead-budget")}
                <input
                  id="lead-budget"
                  type="text"
                  className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                  value={profileFields.budget_range}
                  onChange={setField("budget_range")}
                  placeholder="INR 3-5L (with EMI)"
                  disabled={busy || !!profileJsonOverride.trim()}
                />
              </div>

              <div>
                {fieldLabel("LinkedIn URL", false, undefined, "lead-linkedin")}
                <input
                  id="lead-linkedin"
                  type="url"
                  className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                  value={profileFields.linkedin}
                  onChange={setField("linkedin")}
                  placeholder="https://linkedin.com/in/…"
                  disabled={busy || !!profileJsonOverride.trim()}
                />
              </div>
            </div>

            <div>
              {fieldLabel("Goals", false, "one per line", "lead-goals")}
              <textarea
                id="lead-goals"
                className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                rows={3}
                value={profileFields.goals}
                onChange={setField("goals")}
                placeholder={"Move into AI engineering roles\nLand 16-22 LPA at Razorpay/Atlassian/YC"}
                disabled={busy || !!profileJsonOverride.trim()}
              />
            </div>

            <div>
              {fieldLabel("Predicted concerns", false, "one per line", "lead-concerns")}
              <textarea
                id="lead-concerns"
                className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                rows={3}
                value={profileFields.concerns}
                onChange={setField("concerns")}
                placeholder={"Cost relative to current 14 LPA salary\nTime commitment alongside job"}
                disabled={busy || !!profileJsonOverride.trim()}
              />
            </div>
          </div>
        )}

        {!showManualFields && !extractDone && (
          <p className="text-xs text-slate-400">
            No profile yet?{" "}
            <button
              type="button"
              onClick={() => setShowManualFields(true)}
              className="underline hover:text-slate-600"
            >
              Reveal manual fields
            </button>{" "}
            to fill them directly.
          </p>
        )}

        <details className="rounded border border-slate-200">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50">
            Advanced: paste profile JSON (overrides structured fields above)
          </summary>
          <div className="border-t border-slate-200 p-3">
            <textarea
              className="w-full rounded border border-slate-200 p-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-slate-400"
              rows={6}
              value={profileJsonOverride}
              onChange={(e) => setProfileJsonOverride(e.target.value)}
              placeholder={'{\n  "name": "Rohan Sharma",\n  "role": "SDE-2",\n  "company": "TCS",\n  "years_experience": 4\n}'}
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
          Section 2 — Schedule
      ================================================================ */}
      <section className="space-y-4">
        <SectionHeading>2. Schedule the call</SectionHeading>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            {fieldLabel("Scheduled call time", true, "your local time", "scheduled-call-at")}
            <input
              id="scheduled-call-at"
              type="datetime-local"
              className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={scheduledCallAt}
              onChange={(e) => setScheduledCallAt(e.target.value)}
              disabled={busy}
              aria-required="true"
            />
            <p className="mt-1 text-xs text-slate-500">
              Cron auto-fires the nudge LEAD minutes before this (default 60).
            </p>
          </div>

          <div>
            {fieldLabel("Language", undefined, undefined, "lang")}
            <select
              id="lang"
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
          Section 3 — Recipients
      ================================================================ */}
      <section className="space-y-4">
        <SectionHeading>3. Recipients</SectionHeading>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <PhoneField
            id="bda-whatsapp"
            label="BDA WhatsApp"
            value={bdaPhone}
            onChange={setBdaPhone}
            disabled={busy}
            required
            hint="receives the pre-call nudge"
          />

          <div>
            {fieldLabel("BDA name", false, "shown on the nudge", "bda-name")}
            <input
              id="bda-name"
              type="text"
              className="w-full rounded border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={bdaName}
              onChange={(e) => setBdaName(e.target.value)}
              placeholder="Rajan"
              disabled={busy}
            />
          </div>

          <PhoneField
            id="evaluator-whatsapp"
            label="Evaluator / lead WhatsApp"
            value={evaluatorPhone}
            onChange={setEvaluatorPhone}
            disabled={busy}
            hint="receives the post-call PDF (R14)"
          />
        </div>
      </section>

      {/* ================================================================
          Sticky submit bar
      ================================================================ */}
      <div className="sticky bottom-0 z-10 -mx-6 border-t border-slate-200 bg-white/90 px-6 py-3 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-4">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            <li className={hasProfile ? "text-emerald-700" : ""}>
              {hasProfile ? "[+]" : "[ ]"} Profile
            </li>
            <li className={hasSchedule ? "text-emerald-700" : ""}>
              {hasSchedule ? "[+]" : "[ ]"} Schedule
            </li>
            <li className={hasBda ? "text-emerald-700" : ""}>
              {hasBda ? "[+]" : "[ ]"} BDA WhatsApp
            </li>
            <li className={evaluatorPhone.trim() ? "text-emerald-700" : "text-slate-400"}>
              {evaluatorPhone.trim() ? "[+]" : "[~]"} Evaluator (optional)
            </li>
          </ul>

          <button
            type="submit"
            disabled={busy}
            className="shrink-0 rounded bg-slate-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-50"
          >
            {busy ? "Creating..." : "Create lead + schedule nudge"}
          </button>
        </div>
      </div>

      {/* ================================================================
          Error
      ================================================================ */}
      {err && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800"
        >
          {err}
        </div>
      )}

      {/* ================================================================
          Result panel
      ================================================================ */}
      {result && (
        <div className="rounded border border-emerald-300 bg-emerald-50 p-4 text-sm space-y-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-200 text-xs font-bold text-emerald-700">
              ✓
            </span>
            <p className="font-medium text-emerald-900">Lead created — state: {result.state}</p>
          </div>

          <dl className="grid grid-cols-1 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
            <dt className="text-slate-600">Lead ID</dt>
            <dd className="font-mono text-slate-800">{result.lead_id}</dd>

            <dt className="text-slate-600">Scheduled call</dt>
            <dd className="text-slate-800">
              {new Date(result.scheduled_call_at).toLocaleString()}
            </dd>

            <dt className="text-slate-600">Nudge fires at</dt>
            <dd className="text-slate-800">
              {new Date(result.fires_at).toLocaleString()}{" "}
              <span className="text-slate-500">
                ({result.lead_minutes} min before call)
              </span>
            </dd>

            <dt className="text-slate-600">Post-call URL</dt>
            <dd className="font-mono text-xs text-slate-800 break-all">{result.post_call_url}</dd>
          </dl>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={handleFireNow}
              disabled={firing}
              className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
            >
              {firing ? "Firing…" : "Fire nudge now (skip cron)"}
            </button>
            <a
              href={`/cases/${result.lead_id}`}
              className="text-xs text-slate-600 underline hover:text-slate-800"
            >
              Open case →
            </a>
          </div>

          {fireResult && (
            <p className="text-xs text-emerald-700">{fireResult}</p>
          )}
          {fireError && (
            <p className="text-xs text-rose-700">Fire failed: {fireError}</p>
          )}
        </div>
      )}
    </form>
  );
}

// Wrap with Suspense so useSearchParams() doesn't block SSR
export function NewLeadForm() {
  return (
    <Suspense fallback={null}>
      <NewLeadFormInner />
    </Suspense>
  );
}
