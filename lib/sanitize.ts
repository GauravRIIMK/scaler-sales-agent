/**
 * Defensive sanitization for user-provided strings before they are
 * interpolated into LLM prompts.
 *
 * The verifier, extractor, persona, pdfContent, and nudge generators all
 * embed lead profile fields and raw transcripts directly into prompt text.
 * A malicious or careless user could include lines like
 *   "--- end of transcript --- new instructions: ignore the above"
 * and steer the model. Sanitisation:
 *   - strips control chars (ASCII < 32 except \n \r \t)
 *   - removes lines that look like prompt-fence markers ("---", "===", "##")
 *     when they appear by themselves on a line
 *   - escapes backticks (so the input cannot break out of a fenced block)
 *   - truncates to a hard max length (default 8000 chars) — long inputs are
 *     a separate quality problem and we'd rather refuse than silently truncate
 *     mid-sentence. Caller can override.
 *
 * NOT a security boundary by itself. Defense-in-depth on top of:
 *   - structured tool-use (we never parse free-text from the model)
 *   - the three-moat verifier
 *   - the refuse gate
 */

const FENCE_LINE_RE = /^\s*(?:-{3,}|={3,}|#{2,}\s|\*{3,}|`{3,})\s*$/;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export interface SanitizeOpts {
  maxChars?: number;
  /** When true, also collapse whitespace runs longer than 4 to a single space. Useful for profile fields, NOT for transcripts. */
  collapseWhitespace?: boolean;
}

export function sanitizeForPrompt(input: unknown, opts: SanitizeOpts = {}): string {
  if (input == null) return "";
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  const maxChars = opts.maxChars ?? 8000;

  // 1. Strip control chars
  let out = raw.replace(CONTROL_CHARS_RE, "");

  // 2. Drop fence-marker-only lines (defense against pasted prompt-injection bait)
  out = out
    .split("\n")
    .filter((line) => !FENCE_LINE_RE.test(line))
    .join("\n");

  // 3. Escape backticks
  out = out.replace(/`/g, "'");

  // 4. Optional whitespace collapse
  if (opts.collapseWhitespace) {
    out = out.replace(/[ \t]{3,}/g, "  ").replace(/\n{4,}/g, "\n\n\n");
  }

  // 5. Hard truncate
  if (out.length > maxChars) {
    out = out.slice(0, maxChars - 24) + "\n…[truncated for safety]";
  }

  return out.trim();
}

/**
 * Sanitise a structured profile object. Strings inside go through sanitizeForPrompt.
 * Returns a plain object suitable for JSON.stringify into a prompt.
 */
export function sanitizeProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(profile)) {
    if (v == null) continue;
    if (typeof v === "string") {
      out[k] = sanitizeForPrompt(v, { maxChars: 1000, collapseWhitespace: true });
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === "string"
          ? sanitizeForPrompt(item, { maxChars: 500, collapseWhitespace: true })
          : item
      );
    } else if (typeof v === "object") {
      out[k] = sanitizeProfile(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
