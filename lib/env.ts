import { z } from "zod";

const EnvSchema = z.object({
  // Always required
  ANTHROPIC_API_KEY: z.string().min(20),
  VOYAGE_API_KEY: z.string().min(20),
  TWILIO_ACCOUNT_SID: z.string().startsWith("AC"),
  TWILIO_AUTH_TOKEN: z.string().min(20),

  // Supabase (required once signed up — let start-up ERROR before they block at call-site)
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_BUCKET_PDFS: z.string().default("scaler-sales-pdfs"),
  SUPABASE_BUCKET_AUDIO: z.string().default("scaler-sales-audio"),

  // Deepgram (required for audio path — warn if missing, text path still works)
  DEEPGRAM_API_KEY: z.string().optional(),

  // WhatsApp routing
  TWILIO_WHATSAPP_FROM: z.string().optional(),

  // Optional fallbacks
  OPENAI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),

  // App
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

export function getEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid or missing env vars: ${missing}`);
  }
  return parsed.data;
}

export function envHealth(): {
  status: "ok" | "degraded" | "missing_required";
  missing_required: string[];
  missing_optional: string[];
} {
  const parsed = EnvSchema.safeParse(process.env);
  const required = ["ANTHROPIC_API_KEY", "VOYAGE_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];
  const optional_next = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "DEEPGRAM_API_KEY", "TWILIO_WHATSAPP_FROM"];

  const missing_required = required.filter((k) => !process.env[k] || process.env[k]!.length < 10);
  const missing_optional = optional_next.filter((k) => !process.env[k] || process.env[k]!.length < 5);

  if (missing_required.length > 0) {
    return { status: "missing_required", missing_required, missing_optional };
  }
  if (!parsed.success) {
    return { status: "degraded", missing_required: [], missing_optional };
  }
  if (missing_optional.length > 0) {
    return { status: "degraded", missing_required: [], missing_optional };
  }
  return { status: "ok", missing_required: [], missing_optional: [] };
}

/** Redact secret to last-4 for safe logging. */
export function redact(secret: string | undefined | null): string {
  if (!secret) return "<unset>";
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}
