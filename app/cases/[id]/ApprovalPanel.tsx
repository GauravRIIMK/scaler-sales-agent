"use client";

/**
 * Task 4.2 — client-side Approve / Edit / Skip panel.
 *
 * Flow:
 *   1. POST /api/cases/[id]/decision with action + covering_msg_after
 *   2. If the action is approved/edited: POST /api/cases/[id]/pdf to (re)render
 *   3. Show the signed pdf_url and a "Send to lead" button
 *   4. On Send: POST /api/cases/[id]/deliver → show Twilio SID
 *
 * The UI stays on the page the whole time; all state transitions reflect
 * back through a fetch→setState loop. On any error we surface the backend
 * message verbatim — the BDA needs to know exactly why the send failed.
 *
 * Auth: every fetch carries x-bda-approval-code from the input at the top.
 * The code is persisted to localStorage so the BDA does not need to retype
 * it between page loads, but no default is ever seeded.
 */
import { useState, useEffect } from "react";

const LS_CODE_KEY = "scaler_bda_code";

interface Props {
  caseId: string;
  initialCoveringMsg: string;
  evaluatorPhone: string | null;
  pdfUrl: string | null;
  currentState: string;
}

type Phase =
  | "idle"
  | "deciding"
  | "rendering"
  | "ready_to_send"
  | "sending"
  | "delivered"
  | "error"
  | "skipped";

export function ApprovalPanel({
  caseId,
  initialCoveringMsg,
  evaluatorPhone,
  pdfUrl: initialPdfUrl,
  currentState,
}: Props) {
  const [coveringMsg, setCoveringMsg] = useState(initialCoveringMsg);
  const [phone, setPhone] = useState(evaluatorPhone ?? "");
  const [phase, setPhase] = useState<Phase>(
    currentState === "delivered"
      ? "delivered"
      : currentState === "skipped"
      ? "skipped"
      : "idle"
  );
  const [pdfUrl, setPdfUrl] = useState<string | null>(initialPdfUrl);
  const [deliverySid, setDeliverySid] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  // BDA approval code — hydrated from localStorage only if already present.
  const [bdaCode, setBdaCode] = useState<string>("");

  // Hydrate from localStorage on first render (after mount, client-only).
  // Never seed a default — the code must come from the user.
  useEffect(() => {
    const stored = localStorage.getItem(LS_CODE_KEY);
    if (stored) {
      setBdaCode(stored);
    }
  }, []);

  // Persist whenever the evaluator edits the field.
  function handleCodeChange(val: string) {
    setBdaCode(val);
    localStorage.setItem(LS_CODE_KEY, val);
  }

  const addNote = (s: string) => setNotes((n) => [...n, s]);

  async function postJSON(url: string, body: Record<string, unknown>) {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bda-approval-code": bdaCode,
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    if (!r.ok) {
      const msg =
        (parsed as { error?: string } | null)?.error ??
        `HTTP ${r.status} from ${url}`;
      throw new Error(msg);
    }
    return parsed as Record<string, unknown>;
  }

  async function handleDecision(action: "approved" | "edited" | "skipped") {
    setErrMsg(null);
    setPhase("deciding");
    addNote(`action: ${action}`);
    try {
      const decision = await postJSON(`/api/cases/${caseId}/decision`, {
        action,
        covering_msg_after: action === "skipped" ? undefined : coveringMsg,
      });
      addNote(`decision recorded: state=${decision.state as string}`);

      if (action === "skipped") {
        setPhase("skipped");
        return;
      }

      setPhase("rendering");
      const pdf = await postJSON(`/api/cases/${caseId}/pdf`, {});
      const url = (pdf.pdf_url as string | undefined) ?? null;
      setPdfUrl(url);
      addNote(`pdf rendered: ${(pdf.bytes as number) ?? "?"} bytes`);
      setPhase("ready_to_send");
    } catch (e) {
      setErrMsg(String(e instanceof Error ? e.message : e));
      setPhase("error");
    }
  }

  async function handleSend() {
    if (!phone) {
      setErrMsg("no recipient phone on file — enter one above");
      setPhase("error");
      return;
    }
    setErrMsg(null);
    setPhase("sending");
    addNote(`sending to ${phone}`);
    try {
      const body: Record<string, unknown> = { to: phone };
      if (coveringMsg && coveringMsg !== initialCoveringMsg) body.override_body = coveringMsg;
      const sent = await postJSON(`/api/cases/${caseId}/deliver`, body);
      setDeliverySid((sent.sid as string) ?? null);
      addNote(`delivery sid: ${sent.sid as string}`);
      setPhase("delivered");
    } catch (e) {
      setErrMsg(String(e instanceof Error ? e.message : e));
      setPhase("error");
    }
  }

  const busy = phase === "deciding" || phase === "rendering" || phase === "sending";
  const terminal = phase === "delivered" || phase === "skipped";

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Approval gate
      </h2>

      {/* BDA approval code input */}
      <div className="mb-4">
        <label className="mb-1 block text-xs font-medium text-slate-600">
          BDA approval code
        </label>
        <input
          type="text"
          className="w-full rounded border border-slate-300 p-2 text-sm font-mono"
          value={bdaCode}
          onChange={(e) => handleCodeChange(e.target.value)}
          placeholder="paste your approval code"
          disabled={busy || terminal}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="mt-1 text-xs text-slate-400">
          Required to approve, save edits, or deliver. Ask your admin.
        </p>
      </div>

      <div className="mb-4">
        <label className="mb-1 block text-xs font-medium text-slate-600">Covering message</label>
        <textarea
          className="w-full rounded border border-slate-300 p-2 text-sm"
          rows={3}
          value={coveringMsg}
          onChange={(e) => setCoveringMsg(e.target.value)}
          disabled={busy || terminal}
          maxLength={320}
        />
        <p className="mt-1 text-xs text-slate-500">
          Edit before approving if you want a different opener to land on WhatsApp.
        </p>
        <p className="mt-1 text-xs text-slate-400">{coveringMsg.length}/320</p>
      </div>

      <div className="mb-4">
        <label className="mb-1 block text-xs font-medium text-slate-600">
          Lead WhatsApp number (E.164)
        </label>
        <input
          type="tel"
          className="w-full rounded border border-slate-300 p-2 text-sm"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={busy || terminal}
          placeholder="+91XXXXXXXXXX"
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => handleDecision("approved")}
          disabled={busy || terminal}
          className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Approve as-is
        </button>
        <button
          type="button"
          onClick={() => handleDecision("edited")}
          disabled={busy || terminal || coveringMsg === initialCoveringMsg}
          className="rounded bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Save my edits
        </button>
        <button
          type="button"
          onClick={() => handleDecision("skipped")}
          disabled={busy || terminal}
          className="rounded bg-rose-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Skip
        </button>
      </div>

      {pdfUrl && (
        <div className="mb-4 rounded border border-slate-200 p-3">
          <p className="mb-2 text-sm">
            PDF ready:{" "}
            <a className="text-sky-700 underline" href={pdfUrl} target="_blank" rel="noreferrer">
              open
            </a>
          </p>
          {phase !== "delivered" && phase !== "skipped" && (
            <button
              type="button"
              onClick={handleSend}
              disabled={busy || !phone}
              className="rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {phase === "sending" ? "Sending..." : "Send to lead on WhatsApp"}
            </button>
          )}
        </div>
      )}

      {phase === "delivered" && deliverySid && (
        <div className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">
          Delivered. Twilio SID: <code className="font-mono">{deliverySid}</code>
        </div>
      )}
      {phase === "skipped" && (
        <div className="rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">
          Skipped — nothing will be sent.
        </div>
      )}

      {errMsg && (
        <div className="mt-3 rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">
          {errMsg}
        </div>
      )}

      {notes.length > 0 && (
        <details className="mt-3 text-xs text-slate-500">
          <summary className="cursor-pointer">activity ({notes.length})</summary>
          <ul className="mt-2 space-y-1">
            {notes.map((n, i) => (
              <li key={i}>• {n}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
