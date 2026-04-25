import { isSupabaseConfigured, supabaseServer } from "./supabase";

const PII_KEY_RE = /(phone|whatsapp|email|address|password|api[_-]?key|token|secret|sid|auth|otp)/i;

function redactPayload(p: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  if (!p) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (PII_KEY_RE.test(k)) {
      if (v == null) { out[k] = null; continue; }
      const s = typeof v === "string" ? v : JSON.stringify(v);
      out[k] = s.length <= 4 ? "****" : `${s.slice(0, 2)}…${s.slice(-2)}`;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactPayload(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

export interface LogRow {
  case_id?: string | null;
  task_id?: string;
  component?: string;
  level?: LogLevel;
  event: string;
  provider?: string;
  model?: string;
  prompt_version?: string;
  tokens_in?: number;
  tokens_out?: number;
  latency_ms?: number;
  attempt?: number;
  fallback_of?: string;
  error_code?: string;
  error_message?: string;
  payload?: Record<string, unknown>;
}

/**
 * Primary logger. Writes to Supabase `agent_logs` when configured; always mirrors to stdout.
 * Never throws — a failing log must not break the hot path.
 */
export async function log(row: LogRow): Promise<void> {
  const level = row.level ?? "INFO";
  const line = formatConsole({ ...row, level });

  if (level === "ERROR" || level === "FATAL") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);

  if (!isSupabaseConfigured()) return;

  try {
    const sb = supabaseServer();
    await sb.from("agent_logs").insert({
      case_id: row.case_id ?? null,
      task_id: row.task_id ?? null,
      component: row.component ?? null,
      level,
      event: row.event,
      provider: row.provider ?? null,
      model: row.model ?? null,
      prompt_version: row.prompt_version ?? null,
      tokens_in: row.tokens_in ?? null,
      tokens_out: row.tokens_out ?? null,
      latency_ms: row.latency_ms ?? null,
      attempt: row.attempt ?? 1,
      fallback_of: row.fallback_of ?? null,
      error_code: row.error_code ?? null,
      error_message: row.error_message ?? null,
      payload: redactPayload(row.payload) ?? null,
    });
  } catch (e) {
    console.error("[log] insert failed (non-fatal):", String(e).slice(0, 200));
  }
}

function formatConsole(row: LogRow & { level: LogLevel }): string {
  const ts = new Date().toISOString();
  const parts = [
    `[${ts}]`,
    `[${row.level}]`,
    row.task_id ? `[${row.task_id}]` : "",
    row.component ? `[${row.component}]` : "",
    row.event,
    row.provider ? `provider=${row.provider}` : "",
    row.model ? `model=${row.model}` : "",
    row.attempt && row.attempt > 1 ? `attempt=${row.attempt}` : "",
    row.fallback_of ? `fallback_of=${row.fallback_of}` : "",
    row.latency_ms ? `lat=${row.latency_ms}ms` : "",
    row.tokens_in ? `tin=${row.tokens_in}` : "",
    row.tokens_out ? `tout=${row.tokens_out}` : "",
    row.case_id ? `case=${row.case_id.slice(0, 8)}` : "",
    row.error_message ? `err="${row.error_message.slice(0, 180)}"` : "",
  ].filter(Boolean);
  return parts.join(" ");
}
