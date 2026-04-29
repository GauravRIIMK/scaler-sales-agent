/**
 * Persona-Biased Retrieval (PBR).
 *
 * Augments a retrieval query with persona-axis-specific terms BEFORE
 * embedding + BM25, so the hybrid retriever surfaces chunks that are
 * relevant to the lead's specific information needs (financing for
 * cost-sensitive leads, advanced-track content for senior leads, etc.).
 *
 * Pattern reference: "Personalize Before Retrieve" (PBR, AAAI 2026,
 * arXiv:2510.08935) — documented +10% retrieval recall on PersonaBench
 * by injecting user-specific signals into query expansion before
 * retrieval rather than only at generation-prompt time.
 *
 * Design choices for this app:
 *
 *   1. Caller-side augmentation (NOT inside retrieveGrounding). Keeps
 *      the retrieval module domain-agnostic; only callers who have
 *      already inferred a persona pass it through.
 *
 *   2. Confidence floor ≥ 0.65 per axis. Below that, the persona
 *      inference itself is unreliable; biasing on a guess would
 *      degrade recall not improve it. This matches lib/persona.ts'
 *      CONFIDENCE_FLOOR = 0.6 with a margin of safety.
 *
 *   3. Skip "unknown" axis values. By contract, any axis below the
 *      floor inside lib/persona.ts is snapped to "unknown" and gets
 *      no bias. This is the right default — persona inference uses
 *      "unknown" precisely when it has no signal.
 *
 *   4. Only the FIVE assignment-mandated axes (R16) inject terms.
 *      All five are listed; some axes (e.g. risk-tolerant) intentionally
 *      contribute the empty string when biasing isn't useful (a
 *      risk-tolerant lead doesn't need refund-policy chunks surfaced).
 *
 *   5. The augmented query is APPENDED, not REPLACED. The original
 *      question text remains the primary signal; persona terms only
 *      reweight the chunk pool. This avoids degrading recall on
 *      questions that don't match a persona axis (e.g. "what's the
 *      refund window" stays the same query for any persona).
 *
 *   6. The concatenation is plain text, separated by spaces. Both BM25
 *      (tsvector) and dense (voyage-3-large) handle this naturally.
 *      For BM25 this becomes additional tokens that boost matching
 *      chunks; for dense it nudges the embedding toward the persona's
 *      information neighborhood.
 *
 * Strict R17 compliance: this module is consumed only by retrieval
 * call sites (preCallNudge, pdfContent, generate-route). It does NOT
 * branch on lead identity or hardcoded names — it operates purely on
 * the inferred PersonaVector axis tuple, which can take any of the
 * 243 (3×3×3×3×3 + unknown) value combinations.
 */
import type { PersonaVector } from "./persona";

/**
 * Per-axis term banks. Empty string = no bias for that value (e.g. a
 * risk-tolerant lead has no specific information need to surface).
 */
const AXIS_TERMS: Record<
  | "financial_sensitivity"
  | "career_stage"
  | "risk_posture"
  | "technical_depth"
  | "stakeholder_context",
  Record<string, string>
> = {
  financial_sensitivity: {
    high: "EMI no-cost EMI financing payment plan affordability scholarship",
    medium: "ROI return on investment cost benefit",
    low: "",
    unknown: "",
  },
  career_stage: {
    "early-career": "fresher entry-level beginner foundation",
    mid: "transition career switch upskill applied projects",
    senior: "senior track advanced cohort experienced practitioners",
    unknown: "",
  },
  risk_posture: {
    "risk-averse": "placement support placement statistics refund policy outcomes alumni",
    balanced: "outcomes placements curriculum",
    "risk-tolerant": "",
    unknown: "",
  },
  technical_depth: {
    deep: "production deployment evaluation systems internals advanced",
    moderate: "applied projects capstone hands-on",
    novice: "fundamentals basics primer",
    unknown: "",
  },
  stakeholder_context: {
    team: "company sponsorship corporate training employer reimbursement",
    "family-joint": "family decision parents household",
    solo: "",
    unknown: "",
  },
};

const CONF_FLOOR = 0.65;
const AXES = [
  "financial_sensitivity",
  "career_stage",
  "risk_posture",
  "technical_depth",
  "stakeholder_context",
] as const;

interface PersonaLike {
  career_stage?: string;
  financial_sensitivity?: string;
  technical_depth?: string;
  stakeholder_context?: string;
  risk_posture?: string;
  axis_confidences?: Record<string, number | undefined>;
}

/**
 * Append persona-specific retrieval-augmenting terms to a query.
 *
 * @returns the original query when persona is null/undefined OR when no
 * axis clears the confidence floor with a non-empty term bank.
 */
export function augmentQueryWithPersona(
  query: string,
  persona: PersonaVector | PersonaLike | null | undefined
): string {
  if (!persona) return query;

  const terms: string[] = [];
  const conf = (persona as PersonaLike).axis_confidences ?? {};

  for (const axis of AXES) {
    const value = (persona as Record<string, unknown>)[axis];
    if (typeof value !== "string" || value === "unknown") continue;
    const c = conf[axis];
    if (typeof c === "number" && c < CONF_FLOOR) continue;
    const bank = AXIS_TERMS[axis];
    if (!bank) continue;
    const augment = bank[value];
    if (augment && augment.trim()) terms.push(augment.trim());
  }

  if (terms.length === 0) return query;
  return `${query} ${terms.join(" ")}`;
}

/**
 * Inspect-helper: return the axes that contributed bias terms for
 * observability/logging. Does not alter behaviour.
 */
export function describePersonaBias(
  persona: PersonaVector | PersonaLike | null | undefined
): { contributing_axes: string[]; total_term_count: number } {
  if (!persona) return { contributing_axes: [], total_term_count: 0 };
  const contributing: string[] = [];
  let totalTerms = 0;
  const conf = (persona as PersonaLike).axis_confidences ?? {};
  for (const axis of AXES) {
    const value = (persona as Record<string, unknown>)[axis];
    if (typeof value !== "string" || value === "unknown") continue;
    const c = conf[axis];
    if (typeof c === "number" && c < CONF_FLOOR) continue;
    const augment = AXIS_TERMS[axis]?.[value];
    if (augment && augment.trim()) {
      contributing.push(`${axis}=${value}`);
      totalTerms += augment.trim().split(/\s+/).length;
    }
  }
  return { contributing_axes: contributing, total_term_count: totalTerms };
}
