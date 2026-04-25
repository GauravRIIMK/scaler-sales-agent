import { NextResponse } from "next/server";
import { envHealth } from "@/lib/env";
import { isSupabaseConfigured } from "@/lib/supabase";
import { isDeepgramConfigured } from "@/lib/deepgram";
import { claudeMessage } from "@/lib/anthropic";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const env = envHealth();
  const { searchParams } = new URL(req.url);
  const live = searchParams.get("live") === "1";

  const services: Record<string, string> = {
    supabase: isSupabaseConfigured() ? "configured" : "pending",
    deepgram: isDeepgramConfigured() ? "configured" : "pending",
    twilio_whatsapp_from: process.env.TWILIO_WHATSAPP_FROM ? "configured" : "pending",
  };

  // Fix 4: optional live Anthropic probe — only when ?live=1 is present.
  // Uses a minimal 1-token Haiku call. On any error the health endpoint
  // returns status "degraded" (not 503) so the page itself stays green.
  if (live) {
    try {
      await claudeMessage({
        tier: "haiku",
        system: "Respond with the single word 'ok'.",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 10,
        temperature: 0,
        taskId: "health",
        component: "health",
      });
      services.anthropic_live = "ok";
    } catch (e) {
      services.anthropic_live = `error: ${String(e).slice(0, 200)}`;
    }
  }

  const degraded = live && services.anthropic_live?.startsWith("error");
  const overallStatus = degraded ? "degraded" : env.status;

  const body = {
    status: overallStatus,
    env,
    services,
    build: {
      node_env: process.env.NODE_ENV ?? "development",
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    },
    timestamp: new Date().toISOString(),
  };

  // Keep HTTP 200 even when degraded — health pings should not break pages.
  const httpStatus = env.status === "missing_required" ? 503 : 200;
  return NextResponse.json(body, { status: httpStatus });
}
