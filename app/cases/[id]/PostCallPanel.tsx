"use client";

/**
 * Stage-B post-call upload UI.
 *
 * Renders on /cases/[id] when the row is still in a pre-generation state:
 *   - nudge_scheduled / nudge_sent: BDA hasn't uploaded transcript/audio yet
 *   - received:                     ingest done, /generate not run yet
 *   - failed (post-generate):       allow re-run of /generate
 *
 * Two-step BDA flow on this panel:
 *   1. Upload transcript OR audio file (+ optional lead WhatsApp)
 *      → POST /api/cases/[id]/post-call
 *      → state moves to 'received'
 *   2. Click "Run agent" → POST /api/cases/[id]/generate
 *      → state moves to 'awaiting_approval' (or 'failed')
 *
 * On success of either step, the page re-fetches via router.refresh() so the
 * server component re-reads from Supabase and the Approval gate / persona /
 * sections appear inline.
 *
 * If the BDA wants to demo the nudge from this page (without bouncing back to
 * /leads/new), there's also a "Fire pre-call nudge now" button visible while
 * state='nudge_scheduled'. This hits the same /api/leads/[id]/fire-nudge-now
 * route that the Stage-A form uses.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  caseId: string;
  state: string;
  evaluatorPhone: string | null;
  bdaWhatsapp: string | null;
  hasTranscript: boolean;
  hasAudio: boolean;
}

type Tab = "transcript" | "audio";

const PRE_INGEST_STATES = new Set(["nudge_scheduled", "nudge_sent"]);
const POST_INGEST_STATES = new Set(["received", "transcribing", "failed"]);

export function PostCallPanel({
  caseId,
  state,
  evaluatorPhone,
  bdaWhatsapp,
  hasTranscript,
  hasAudio,
}: Props) {
  const router = useRouter();

  const [tab, setTab] = useState<Tab>("transcript");
  const [transcript, setTranscript] = useState("");
  const [audio, setAudio] = useState<File | null>(null);
  const [phone, setPhone] = useState(evaluatorPhone ?? "");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [firing, setFiring] = useState(false);
  const [fireMsg, setFireMsg] = useState<string | null>(null);

  const isPreIngest = PRE_INGEST_STATES.has(state);
  const isReadyToGenerate = POST_INGEST_STATES.has(state) || state === "received";

  // Validate before hitting the API
  const canIngest =
    (tab === "transcript" && transcript.trim().length > 0) ||
    (tab === "audio" && audio !== null);

  async function handleIngest(e: React.FormEvent) {
    e.preventDefault();
    if (!canIngest) {
      setErr(tab === "transcript" ? "Paste a transcript first" : "Pick an audio file first");
      return;
    }
    setErr(null);
    setInfo(null);
    setBusy(true);
    setBusyLabel(audio ? "Uploading audio…" : "Uploading transcript…");

    try {
      let res: Response;
      if (tab === "audio" && audio) {
        // Two-step direct-to-Supabase upload to bypass Vercel's 4.5 MB
        // serverless function payload cap. Real sales calls (15-30 min)
        // are 100+ MB; multipart-into-function is structurally wrong for
        // production. See app/api/cases/[id]/audio-upload-url/route.ts.

        // 1) Ask the server for a signed upload URL.
        setBusyLabel("Getting upload URL…");
        const urlRes = await fetch(`/api/cases/${caseId}/audio-upload-url`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            filename: audio.name,
            content_type: audio.type || "audio/wav",
          }),
        });
        const urlPayload = await urlRes.json();
        if (!urlRes.ok) {
          throw new Error(`upload-url failed: ${urlPayload?.error ?? `HTTP ${urlRes.status}`}`);
        }
        const { signed_upload_url, path } = urlPayload as {
          signed_upload_url: string;
          path: string;
        };

        // 2) PUT the file directly to Supabase. Browser → Supabase, no
        // Vercel function in the middle. Supabase signed-upload URLs
        // expect PUT with the file body.
        setBusyLabel(`Uploading ${(audio.size / (1024 * 1024)).toFixed(1)} MB direct to Supabase…`);
        const putRes = await fetch(signed_upload_url, {
          method: "PUT",
          headers: { "content-type": audio.type || "audio/wav" },
          body: audio,
        });
        if (!putRes.ok) {
          throw new Error(
            `direct upload failed: HTTP ${putRes.status} ${putRes.statusText}`
          );
        }

        // 3) Tell the post-call route the bucket-internal path. The route
        // signs a fresh read URL (24h) and persists it as audio_blob_url.
        setBusyLabel("Finalising…");
        res = await fetch(`/api/cases/${caseId}/post-call`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            audio_path: path,
            transcript: transcript.trim() || undefined,
            evaluator_phone: phone.trim() || undefined,
          }),
        });
      } else {
        res = await fetch(`/api/cases/${caseId}/post-call`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            transcript: transcript.trim(),
            evaluator_phone: phone.trim() || undefined,
          }),
        });
      }

      const text = await res.text();
      let parsed: { state?: string; error?: string; audio_url?: string | null } = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text.slice(0, 300) };
      }
      if (!res.ok) {
        throw new Error(parsed.error ?? `HTTP ${res.status}`);
      }
      setInfo(`Ingested. State → ${parsed.state ?? "received"}.`);
      router.refresh();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }

  async function handleGenerate() {
    setErr(null);
    setInfo(null);
    setBusy(true);
    setBusyLabel("Running pipeline (STT → extract → persona → retrieve → render)…");
    try {
      const res = await fetch(`/api/cases/${caseId}/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      let parsed: { state?: string; error?: string; questions?: number; sections?: number } = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text.slice(0, 300) };
      }
      if (!res.ok) {
        throw new Error(parsed.error ?? `HTTP ${res.status}`);
      }
      setInfo(
        `Generated. ${parsed.questions ?? "?"} questions → ${parsed.sections ?? "?"} sections. State → ${parsed.state}.`
      );
      router.refresh();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }

  async function handleFireNow() {
    setFireMsg(null);
    setFiring(true);
    try {
      const res = await fetch(`/api/leads/${caseId}/fire-nudge-now`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      let parsed: { status?: string; sid?: string; to?: string; error?: string } = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text.slice(0, 300) };
      }
      if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
      setFireMsg(`Sent to ${parsed.to ?? bdaWhatsapp ?? "BDA"} · sid=${parsed.sid ?? "?"}`);
      router.refresh();
    } catch (e) {
      setFireMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFiring(false);
    }
  }

  // ─── Layout ────────────────────────────────────────────────────────────
  return (
    <section className="mb-6 rounded-xl border border-sky-200 bg-sky-50 p-4">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-sky-800">
        Stage B — Post-call ingest
      </h2>
      <p className="mb-4 text-xs text-sky-700">
        The BDA just finished the call. Upload the recording (or paste the transcript) below, then
        run the agent to generate the persona-tailored PDF.
      </p>

      {/* Pre-call demo button — only while still in nudge_scheduled */}
      {state === "nudge_scheduled" && bdaWhatsapp && (
        <div className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-xs">
          <p className="mb-2 text-amber-900">
            Pre-call nudge has not fired yet. The cron will fire it 60 min before the scheduled
            call — or fire it now for demo:
          </p>
          <button
            type="button"
            onClick={handleFireNow}
            disabled={firing || busy}
            className="rounded bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
          >
            {firing ? "Firing…" : "Fire pre-call nudge now"}
          </button>
          {fireMsg && <p className="mt-2 text-amber-900">{fireMsg}</p>}
        </div>
      )}

      {/* Step 1: ingest (only if pre-ingest) ───────────────────────────── */}
      {isPreIngest && (
        <form onSubmit={handleIngest} className="space-y-4">
          <div className="flex gap-2">
            {(["transcript", "audio"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                disabled={busy}
                className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                  tab === t
                    ? "bg-slate-900 text-white"
                    : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {t === "transcript" ? "Transcript (paste)" : "Audio (upload file)"}
              </button>
            ))}
          </div>

          {tab === "transcript" && (
            <div>
              <label htmlFor="post-call-transcript" className="mb-1 block text-xs font-medium text-slate-700">
                Call transcript <span className="text-rose-500">*</span>
              </label>
              <textarea
                id="post-call-transcript"
                rows={8}
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                disabled={busy}
                className="w-full rounded border border-slate-300 bg-white p-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-300"
                placeholder={"BDA: Hi Rohan, thanks for getting on. So you mentioned the AI engineering track…\n\nRohan: Honestly, I've been at TCS for 4 years…"}
              />
              <p className="mt-1 text-xs text-slate-500">{transcript.length} chars</p>
            </div>
          )}

          {tab === "audio" && (
            <div>
              <label htmlFor="post-call-audio" className="mb-1 block text-xs font-medium text-slate-700">
                Audio file <span className="text-rose-500">*</span>
                <span className="ml-1 font-normal text-slate-500">
                  (mp3 / wav / m4a, max 40 MB — Deepgram Nova-3 transcribes it)
                </span>
              </label>
              <input
                id="post-call-audio"
                type="file"
                accept="audio/*"
                onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
                disabled={busy}
                className="block w-full text-sm text-slate-700 file:mr-3 file:rounded file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-slate-700"
              />
              {audio && (
                <p className="mt-1 text-xs text-slate-500">
                  Selected: {audio.name} ({(audio.size / (1024 * 1024)).toFixed(2)} MB)
                </p>
              )}
            </div>
          )}

          <div>
            <label htmlFor="post-call-phone" className="mb-1 block text-xs font-medium text-slate-700">
              Lead's WhatsApp (E.164){" "}
              <span className="font-normal text-slate-500">— receives the PDF after approval</span>
            </label>
            <input
              id="post-call-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={busy}
              className="w-full rounded border border-slate-300 bg-white p-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-300"
              placeholder="+91XXXXXXXXXX"
            />
            {evaluatorPhone && phone === evaluatorPhone && (
              <p className="mt-1 text-xs text-slate-400">Pre-filled from the lead row.</p>
            )}
          </div>

          <button
            type="submit"
            disabled={busy || !canIngest}
            className="rounded bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-600 disabled:opacity-50"
          >
            {busy ? busyLabel || "Working…" : "Upload + move to 'received'"}
          </button>
        </form>
      )}

      {/* Step 2: generate (state=received) ──────────────────────────────── */}
      {isReadyToGenerate && !isPreIngest && (
        <div className="space-y-3">
          <div className="rounded border border-emerald-300 bg-white p-3 text-xs text-slate-700">
            <p className="font-medium text-emerald-800">✓ Post-call data ingested</p>
            <ul className="mt-1 space-y-0.5 text-slate-600">
              <li>• Transcript: {hasTranscript ? "stored" : "—"}</li>
              <li>• Audio: {hasAudio ? "stored (signed URL)" : "—"}</li>
            </ul>
          </div>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={busy}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {busy ? busyLabel || "Generating…" : "Run agent → generate PDF"}
          </button>
          <p className="text-xs text-slate-500">
            ~60–120s. Pipeline: {hasAudio ? "STT → " : ""}question extraction → persona inference →
            retrieve from scaler.com → render PDF → verify.
          </p>
        </div>
      )}

      {info && (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-800"
        >
          {info}
        </div>
      )}
      {err && (
        <div
          role="alert"
          aria-live="assertive"
          className="mt-3 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-800"
        >
          {err}
        </div>
      )}
    </section>
  );
}
