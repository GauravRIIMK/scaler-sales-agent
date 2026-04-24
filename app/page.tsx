import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <header className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight">Scaler Sales Agent</h1>
        <p className="mt-2 text-slate-600">
          Upload a lead profile + post-call transcript (or audio). We infer persona,
          extract questions, retrieve grounded facts from scaler.com, and produce a
          persona-tailored PDF + BDA nudge — gated by your approval before anything
          reaches the lead.
        </p>
      </header>

      <section className="space-y-3">
        <Link
          href="/cases/new"
          className="block rounded-xl border border-slate-300 bg-white p-4 shadow-sm hover:border-slate-900 hover:shadow-md"
        >
          <div className="text-sm font-semibold">+ New case</div>
          <div className="text-sm text-slate-600">
            Start from a profile + transcript (or audio) and run the full pipeline.
          </div>
        </Link>
        <Link
          href="/cases"
          className="block rounded-xl border border-slate-300 bg-white p-4 shadow-sm hover:border-slate-900 hover:shadow-md"
        >
          <div className="text-sm font-semibold">Recent cases</div>
          <div className="text-sm text-slate-600">
            Review generated PDFs, approve / edit / skip before delivery.
          </div>
        </Link>
        <Link
          href="/api/health"
          className="block rounded-xl border border-slate-200 bg-slate-100 p-4 text-sm text-slate-600 hover:bg-slate-50"
        >
          Service health (Supabase · Deepgram · Twilio)
        </Link>
      </section>
    </main>
  );
}
