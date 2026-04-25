/**
 * Task 4.2 — recent-cases index.
 *
 * Lightweight listing: state badge, name, created time. Used to navigate
 * between cases during the demo. Links the BDA to /cases/[id] for
 * approve/edit/skip.
 */
import Link from "next/link";
import { supabaseServer } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Row {
  id: string;
  state: string;
  lead_profile: Record<string, unknown> | null;
  created_at: string;
  delivered_at: string | null;
}

async function loadRecent(): Promise<Row[]> {
  const sb = supabaseServer();
  const { data, error } = await sb
    .from("lead_cases")
    .select("id, state, lead_profile, created_at, delivered_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`list cases failed: ${error.message}`);
  return (data as Row[]) ?? [];
}

function stateClasses(state: string): string {
  if (state === "delivered") return "bg-emerald-100 text-emerald-800";
  if (state === "skipped" || state === "failed") return "bg-rose-100 text-rose-800";
  if (state === "awaiting_approval" || state === "approved" || state === "edited")
    return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-700";
}

export default async function CasesIndex() {
  const rows = await loadRecent();

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Recent cases</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/leads/new"
            className="rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
          >
            + New lead (Stage A)
          </Link>
          <Link
            href="/cases/new"
            className="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            + Single-shot case
          </Link>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-slate-300 p-6 text-center text-slate-500">
          No cases yet. Create one with +New case.
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {rows.map((r) => {
            const name = (r.lead_profile?.name as string | undefined) ?? "(no name)";
            const company = r.lead_profile?.company as string | undefined;
            return (
              <li key={r.id}>
                <Link
                  href={`/cases/${r.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-slate-50"
                >
                  <div>
                    <div className="font-medium">{name}</div>
                    {company && <div className="text-sm text-slate-500">{company}</div>}
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${stateClasses(
                        r.state
                      )}`}
                    >
                      {r.state}
                    </span>
                    <span className="text-slate-400">
                      {new Date(r.created_at).toLocaleString()}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
