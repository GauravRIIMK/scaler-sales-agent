/**
 * /leads/new — Stage-A onboarding form for the two-stage flow.
 *
 * The evaluator (or a sales ops user) creates a lead row that will sit in
 * 'nudge_scheduled' until the pre-call cron fires the BDA nudge LEAD minutes
 * before scheduled_call_at. The post-call transcript ingest happens at a
 * different surface (/cases/[id], or the BDA's WhatsApp UX layer).
 *
 * Why a separate page from /cases/new:
 *   /cases/new is the legacy single-shot path (profile + transcript bundled).
 *   /leads/new is the assignment-correct two-stage entry point — it asks
 *   ONLY for the data the BDA actually has before the call.
 */
import { NewLeadForm } from "./NewLeadForm";

export const dynamic = "force-dynamic";

export default function NewLeadPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">New lead (Stage A — pre-call)</h1>
        <p className="mt-2 text-sm text-slate-600">
          Add a lead and schedule the call. We&apos;ll auto-fire a profile-only
          WhatsApp nudge to the BDA at <span className="font-mono">T &minus; 1h</span>{" "}
          (configurable via <span className="font-mono">NUDGE_LEAD_MINUTES</span>) so they
          walk in prepared. The post-call PDF flow takes over once you upload a
          transcript or audio at <span className="font-mono">/cases/[id]</span>.
        </p>
      </header>
      <NewLeadForm />
    </main>
  );
}
