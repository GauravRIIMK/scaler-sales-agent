/**
 * /cases/new — intake form for evaluators.
 *
 * Collects lead profile (structured fields), call transcript or audio,
 * and recipient details (lead + BDA), then creates a case and runs the
 * full pipeline in one shot.
 */
import { NewCaseForm } from "./NewCaseForm";

export const dynamic = "force-dynamic";

export default function NewCasePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">New case</h1>
        <p className="mt-2 text-sm text-slate-600">
          Fill in the lead profile, attach the post-call transcript or audio, and set
          recipient details. We will extract questions, infer the persona, retrieve grounding,
          generate the evaluator PDF, and queue the BDA nudge — all without further input.
        </p>
      </header>
      <NewCaseForm />
    </main>
  );
}
