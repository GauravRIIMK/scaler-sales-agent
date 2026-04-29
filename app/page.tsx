"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SAMPLE_PERSONAS, type SamplePersona } from "@/lib/samplePersonas";

// ---------------------------------------------------------------------------
// Phone capture helpers
// ---------------------------------------------------------------------------

const SESSION_KEY = "evaluator_phone";

function readSessionPhone(): string {
  if (typeof window === "undefined") return "";
  try {
    return sessionStorage.getItem(SESSION_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeSessionPhone(phone: string) {
  try {
    sessionStorage.setItem(SESSION_KEY, phone);
  } catch {
    // ignore — private browsing
  }
}

function clearSessionPhone() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

function isValidE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DemoModePill() {
  const [showTip, setShowTip] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800 border border-amber-300 cursor-default"
        onMouseEnter={() => setShowTip(true)}
        onMouseLeave={() => setShowTip(false)}
        onFocus={() => setShowTip(true)}
        onBlur={() => setShowTip(false)}
        aria-label="Demo mode: Pre-loaded examples; real PDFs delivered via Twilio sandbox"
      >
        Demo mode
      </button>
      {showTip && (
        <div
          role="tooltip"
          className="absolute right-0 top-8 z-20 w-64 rounded border border-slate-200 bg-white p-2 text-xs text-slate-600 shadow-lg"
        >
          Pre-loaded examples; real PDFs delivered via Twilio sandbox.
        </div>
      )}
    </div>
  );
}

function PhoneCaptureCard({
  onSave,
}: {
  onSave: (phone: string) => void;
}) {
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);

  const warn =
    touched && value.trim().length > 0 && !isValidE164(value)
      ? "Use E.164 format, e.g. +91XXXXXXXXXX"
      : null;

  function handleSave() {
    setTouched(true);
    if (!isValidE164(value)) return;
    writeSessionPhone(value.trim());
    onSave(value.trim());
  }

  return (
    <div className="mx-auto max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold text-slate-800">
        First, where should test messages land?
      </h2>
      <p className="mb-4 text-xs text-slate-500">
        Enter your WhatsApp number. All demo sends (nudge + PDF) route here.
      </p>
      <label htmlFor="eval-phone" className="sr-only">
        Your WhatsApp number
      </label>
      <input
        id="eval-phone"
        type="tel"
        className={`mb-3 w-full rounded border p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 ${
          warn ? "border-amber-400 bg-amber-50" : "border-slate-300"
        }`}
        placeholder="+91XXXXXXXXXX"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setTouched(false);
        }}
        onBlur={() => setTouched(true)}
        autoFocus
      />
      {warn && <p className="mb-2 text-xs text-amber-700">{warn}</p>}
      <button
        type="button"
        onClick={handleSave}
        className="w-full rounded bg-slate-900 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-40"
        disabled={value.trim().length === 0}
      >
        Save &amp; continue
      </button>
    </div>
  );
}

function PhoneSetBar({
  phone,
  onClear,
}: {
  phone: string;
  onClear: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-lg items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600">
      <span>
        Demo sends will go to{" "}
        <span className="font-mono font-medium text-slate-900">{phone}</span>.
      </span>
      <button
        type="button"
        onClick={onClear}
        className="shrink-0 text-xs font-medium text-slate-500 underline hover:text-slate-800"
      >
        Change
      </button>
    </div>
  );
}

function PersonaCard({ persona }: { persona: SamplePersona }) {
  return (
    <Link
      href={"/leads/new?prefill=" + persona.slug}
      className="group flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-400 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-400"
    >
      <div className="flex-1">
        <p className="text-base font-medium text-slate-900">{persona.shortName}</p>
        <p className="mt-0.5 text-sm text-slate-600">{persona.role}</p>
        <p className="mt-2 text-sm text-slate-500 line-clamp-2">{persona.oneLiner}</p>
      </div>
      <div className="mt-4 flex justify-end">
        <span className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-xs text-slate-500">
          {persona.archetypeHint}
        </span>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function HomePage() {
  const [phone, setPhone] = useState<string>("");
  const [hydrated, setHydrated] = useState(false);

  // Read sessionStorage after mount to avoid SSR mismatch
  useEffect(() => {
    const stored = readSessionPhone();
    if (stored) setPhone(stored);
    setHydrated(true);
  }, []);

  function handleSave(p: string) {
    setPhone(p);
  }

  function handleClear() {
    clearSessionPhone();
    setPhone("");
  }

  const phoneSet = hydrated && phone.length > 0;

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-3">
          <span className="text-sm font-semibold tracking-tight text-slate-900">
            Scaler Sales Agent
          </span>
          <DemoModePill />
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12 space-y-12">
        {/* Hero */}
        <section className="text-center space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
            Pre-call briefs and post-call PDFs for sales teams
          </h1>
          <p className="mx-auto max-w-xl text-base text-slate-600">
            Turns a lead profile and call transcript into a persona-tailored BDA WhatsApp nudge
            before the call, and a PDF delivered to the lead over WhatsApp after.
          </p>
        </section>

        {/* Phone capture / status strip */}
        <section>
          {!hydrated ? null : phoneSet ? (
            <PhoneSetBar phone={phone} onClear={handleClear} />
          ) : (
            <PhoneCaptureCard onSave={handleSave} />
          )}
        </section>

        {/* Persona picker — only shown after phone capture */}
        {phoneSet && (
          <section className="space-y-6">
            <h2 className="text-base font-semibold text-slate-800">
              Try a pre-built scenario
            </h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {SAMPLE_PERSONAS.map((persona) => (
                <PersonaCard key={persona.slug} persona={persona} />
              ))}
            </div>

            {/* "Or create your own" row */}
            <div className="border-t border-slate-200 pt-6 space-y-2">
              <h3 className="text-sm font-semibold text-slate-800">
                Or create a novel persona (AT-01)
              </h3>
              <p className="text-sm text-slate-500">
                Custom profile + transcript or audio. Same pipeline, persona vector inferred live.
              </p>
              <Link
                href="/leads/new"
                className="mt-3 inline-block rounded bg-slate-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
              >
                Create custom lead
              </Link>
            </div>
          </section>
        )}

        {/* Footer utilities */}
        <footer className="border-t border-slate-200 pt-4">
          <nav className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-500">
            <Link href="/cases" className="hover:text-slate-800 underline">
              Recent cases
            </Link>
            <a
              href="/api/health"
              target="_blank"
              rel="noreferrer"
              className="hover:text-slate-800 underline"
            >
              API health
            </a>
          </nav>
        </footer>
      </main>
    </div>
  );
}
