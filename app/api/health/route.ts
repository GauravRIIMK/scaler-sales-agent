import { NextResponse } from "next/server";
import { envHealth } from "@/lib/env";
import { isSupabaseConfigured } from "@/lib/supabase";
import { isDeepgramConfigured } from "@/lib/deepgram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const env = envHealth();

  const body = {
    status: env.status,
    env,
    services: {
      supabase: isSupabaseConfigured() ? "configured" : "pending",
      deepgram: isDeepgramConfigured() ? "configured" : "pending",
      twilio_whatsapp_from: process.env.TWILIO_WHATSAPP_FROM ? "configured" : "pending",
    },
    build: {
      node_env: process.env.NODE_ENV ?? "development",
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    },
    timestamp: new Date().toISOString(),
  };

  const httpStatus = env.status === "missing_required" ? 503 : 200;
  return NextResponse.json(body, { status: httpStatus });
}
