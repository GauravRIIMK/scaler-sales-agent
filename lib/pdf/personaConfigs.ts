/**
 * Task 3.4a — compositional persona-style resolver for the PDF.
 *
 * The BUILD_PLAN calls for a `persona_configs.json` keyed by archetype, with a
 * neutral fallback. We implement it as a compositional merge over the 5 axes
 * instead of enumerating ~243 archetype tuples — this is the whole point of
 * the P3 vector: no hardcoded class switch.
 *
 * The resolver:
 *   start from DEFAULT
 *   → overlay the axis-specific overrides in a fixed precedence order
 *   → return a fully-populated PDFStyleConfig
 *
 * Any axis value "unknown" contributes no overlay — the default carries.
 *
 * Updated (redesign): accent default changed to teal-green #0F766E,
 * background_tint to #F0FDFA, and cta_tagline added per persona axis.
 */
import type { PersonaVector } from "../persona";

export interface PDFStyleConfig {
  primary_color: string;           // text & rule colour
  accent: string;                   // section-heading underline, chunk cite ticks
  background_tint: string;          // page-side rail colour
  font_family: string;
  font_size_body: number;
  font_size_heading: number;
  font_size_meta: number;
  line_height: number;
  page_margin: number;
  density: "compact" | "comfortable" | "spacious";
  tone_header: string;              // one-line sub-title printed below the H1
  section_order_priority: string[]; // concern_types to surface first
  include_emi_callout: boolean;
  include_salary_chart: boolean;
  include_household_angle: boolean;
  include_team_rollout: boolean;
  include_technical_appendix: boolean;
  include_honest_uncertainty_first: boolean;
  fetched_age_in_footer: boolean;
  /** Persona-aware one-liner for the closing CTA banner. */
  cta_tagline: string;
}

const DEFAULT_CTA_TAGLINE =
  "Lock your cohort seat with the Scaler Entrance Test — 90 minutes, free to attempt, results in 24 hours.";

const DEFAULT: PDFStyleConfig = {
  primary_color: "#0F172A",
  accent: "#0F766E",
  background_tint: "#F0FDFA",
  font_family: "Helvetica",
  font_size_body: 10.5,
  font_size_heading: 14,
  font_size_meta: 8.5,
  line_height: 1.45,
  page_margin: 44,
  density: "comfortable",
  tone_header: "A brief we built from your call.",
  section_order_priority: ["outcome", "curriculum", "cost", "placement", "credibility"],
  include_emi_callout: false,
  include_salary_chart: false,
  include_household_angle: false,
  include_team_rollout: false,
  include_technical_appendix: false,
  include_honest_uncertainty_first: false,
  fetched_age_in_footer: true,
  cta_tagline: DEFAULT_CTA_TAGLINE,
};

type Overlay = Partial<PDFStyleConfig>;

const BY_CAREER_STAGE: Record<string, Overlay> = {
  early: {
    density: "comfortable",
    tone_header: "A starter brief based on what we discussed.",
    section_order_priority: ["cost", "prereq", "curriculum", "outcome", "placement"],
    cta_tagline:
      "Start your Scaler journey today — the entrance test is free and takes 90 minutes.",
  },
  mid: {
    density: "comfortable",
    tone_header: "A brief built from the specifics you raised on our call.",
    section_order_priority: ["outcome", "curriculum", "cost", "credibility", "placement"],
    cta_tagline:
      "Your next move starts with the CET — 90 minutes to benchmark where you stand and unlock your offer.",
  },
  senior: {
    density: "compact",
    font_size_body: 10,
    page_margin: 40,
    tone_header: "A focused brief — only the specifics from our conversation.",
    section_order_priority: ["curriculum", "credibility", "outcome", "placement"],
    include_technical_appendix: true,
    cta_tagline:
      "Take the CET to validate your depth and fast-track into the senior cohort — results in 24 hours.",
  },
  unknown: {},
};

const BY_FIN_SENSITIVITY: Record<string, Overlay> = {
  high: {
    accent: "#D97706",
    background_tint: "#FFFBEB",
    include_emi_callout: true,
    cta_tagline:
      "The CET is free — no commitment yet. Complete it and your BDA will walk you through every EMI option.",
  },
  medium: {
    accent: "#2563EB",
    include_emi_callout: true,
    include_salary_chart: true,
    cta_tagline:
      "Take the free CET today; salary-outcome data for your profile will be shared with your results.",
  },
  low: {
    accent: "#14B8A6",
    include_emi_callout: false,
    include_salary_chart: false,
    cta_tagline:
      "Reserve your cohort seat — complete the 90-minute CET and your BDA will confirm enrolment within 24 hours.",
  },
  unknown: {},
};

const BY_TECH_DEPTH: Record<string, Overlay> = {
  deep: {
    primary_color: "#0F172A",
    include_technical_appendix: true,
    tone_header: "Built for an engineer's skim — specifics first, marketing never.",
    cta_tagline:
      "The CET is a real engineering challenge — 90 minutes to prove your depth and earn a merit-based offer.",
  },
  moderate: {
    primary_color: "#1E293B",
  },
  novice: {
    primary_color: "#365314",
    background_tint: "#F7FEE7",
    font_size_body: 11,
    line_height: 1.55,
    density: "spacious",
    cta_tagline:
      "No prior experience needed for the CET — it's designed to show you where you stand and what Scaler can unlock.",
  },
  unknown: {},
};

const BY_STAKEHOLDER: Record<string, Overlay> = {
  solo: {},
  "family-joint": {
    include_household_angle: true,
    tone_header: "A brief you can read together at home.",
    cta_tagline:
      "The entrance test is free — share this brief at home, then take the CET so the whole picture is on the table.",
  },
  team: {
    include_team_rollout: true,
    cta_tagline:
      "Every team member can take the CET independently — free, 90 minutes, and results inform the group rollout plan.",
  },
  unknown: {},
};

const BY_RISK_POSTURE: Record<string, Overlay> = {
  "risk-averse": {
    include_honest_uncertainty_first: true,
    accent: "#475569",
    tone_header: "Here's what we can back up, and where we'd rather be honest than oversell.",
    cta_tagline:
      "The CET is zero-risk: free to attempt, no obligation, and your BDA will only follow up with verified answers.",
  },
  balanced: {},
  "risk-tolerant": {
    accent: "#DC2626",
    cta_tagline:
      "You're already betting on yourself — the CET is 90 minutes to formalise that bet with a merit offer.",
  },
  unknown: {},
};

function merge(base: PDFStyleConfig, overlay: Overlay): PDFStyleConfig {
  return { ...base, ...overlay };
}

/** Pure function — same PersonaVector always yields same config. */
export function resolvePDFStyle(persona: Pick<
  PersonaVector,
  "career_stage" | "financial_sensitivity" | "technical_depth" | "stakeholder_context" | "risk_posture"
>): PDFStyleConfig {
  let cfg = { ...DEFAULT };
  cfg = merge(cfg, BY_CAREER_STAGE[persona.career_stage] ?? {});
  cfg = merge(cfg, BY_FIN_SENSITIVITY[persona.financial_sensitivity] ?? {});
  cfg = merge(cfg, BY_TECH_DEPTH[persona.technical_depth] ?? {});
  cfg = merge(cfg, BY_STAKEHOLDER[persona.stakeholder_context] ?? {});
  cfg = merge(cfg, BY_RISK_POSTURE[persona.risk_posture] ?? {});
  return cfg;
}

/**
 * Sort PDFSections into a deterministic display order using the persona's
 * `section_order_priority` (concern_type strings). Sections whose concern_type
 * isn't in the priority list keep their input order at the tail.
 */
export function orderSectionsForPersona<T extends { section_type: string }>(
  sections: T[],
  cfg: Pick<PDFStyleConfig, "section_order_priority">
): T[] {
  const priority = cfg.section_order_priority;
  const rank = new Map(priority.map((c, i) => [c, i]));
  const decorated = sections.map((s, idx) => ({ s, idx, r: rank.get(s.section_type) ?? 1000 }));
  decorated.sort((a, b) => (a.r === b.r ? a.idx - b.idx : a.r - b.r));
  return decorated.map((d) => d.s);
}
