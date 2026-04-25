/**
 * BDA approval code gate.
 *
 * Checks the `x-bda-approval-code` request header against the
 * `BDA_APPROVAL_CODE` environment variable.
 *
 * Returns a NextResponse (401) on mismatch so callers can do:
 *   const authErr = requireBdaCode(req, caseId);
 *   if (authErr) return authErr;
 *
 * Returns null when the check passes.
 *
 * If BDA_APPROVAL_CODE is not set, emits a WARN and allows the request
 * through (dev ergonomics — keeps local dev working without the env var).
 */
import { NextResponse } from "next/server";
import crypto from "crypto";

export function requireBdaCode(req: Request, caseId: string): NextResponse | null {
  const expected = process.env.BDA_APPROVAL_CODE;

  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        { error: "approval gate misconfigured: BDA_APPROVAL_CODE not set" },
        { status: 503 }
      );
    }
    console.warn(
      `[bdaAuth] BDA_APPROVAL_CODE not set — allowing request for case ${caseId} without auth`
    );
    return null;
  }

  const provided = req.headers.get("x-bda-approval-code") ?? "";
  const expectedBuf = Buffer.from(expected);

  if (provided.length !== expected.length) {
    // Sham comparison to keep timing consistent with the match branch.
    const shamBuf = Buffer.alloc(expectedBuf.length);
    crypto.timingSafeEqual(shamBuf, expectedBuf);
    return NextResponse.json(
      { error: "invalid BDA approval code", case_id: caseId },
      { status: 401 }
    );
  }

  if (!crypto.timingSafeEqual(Buffer.from(provided), expectedBuf)) {
    return NextResponse.json(
      { error: "invalid BDA approval code", case_id: caseId },
      { status: 401 }
    );
  }

  return null;
}
