/**
 * Next.js boot hook. Runs once when the server process starts.
 * Validates env vars early so misconfigurations surface at startup, not on
 * the first user request. Failures here log + soft-warn — we do NOT throw
 * because Vercel preview branches and local dev often run without all keys.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { envHealth, redact } = await import("./lib/env");
  const status = envHealth();
  if (status.status === "missing_required") {
    console.error(
      `[boot] env status: missing_required — missing=${status.missing_required.join(",")}; the app will return 503 on /api/health.`
    );
  } else if (status.status === "degraded") {
    console.warn(
      `[boot] env status: degraded — missing optional=${status.missing_optional.join(",")}.`
    );
  } else {
    console.log("[boot] env status: ok");
  }
  console.log(`[boot] BDA_APPROVAL_CODE=${redact(process.env.BDA_APPROVAL_CODE)}`);
}
