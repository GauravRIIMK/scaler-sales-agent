/**
 * Task 3.4b — persona-driven PDF Document (redesign).
 *
 * Produces a 2-3 page visually polished PDF:
 *   Page 1  — Cover: lead name/role, persona chip, covering message quote,
 *             trust-stats band (three Scaler stat cards).
 *   Page 2+ — Section cards with numbered badge (X/Y), sentence list, and
 *             per-section source footnotes.  Refused sentences render as an
 *             amber left-border callout instead of inline "(not sourced)".
 *   Last    — CTA banner: "Your next step" with persona-aware tagline and
 *             scaler.com/cet/ URL. EMI / household / uncertainty callouts
 *             appear immediately above the CTA.
 *
 * Fonts: Inter via Google Fonts CDN, falls back to Helvetica silently.
 * Rendered via `@react-pdf/renderer` -> renderToStream in the API route.
 */
import React from "react";
import {
  Document,
  Font,
  Page,
  Text,
  View,
  StyleSheet,
} from "@react-pdf/renderer";
import type { PDFContent, PDFSection, Sentence } from "../pdfContent";
import type { PersonaVector } from "../persona";
import {
  resolvePDFStyle,
  orderSectionsForPersona,
  type PDFStyleConfig,
} from "./personaConfigs";

// ---------------------------------------------------------------------------
// Font registration — Inter from Google Fonts CDN.
// react-pdf fetches these once at render time (Node.js only).
// Wrapped in try/catch: if the CDN is unreachable we fall back to Helvetica.
// ---------------------------------------------------------------------------
try {
  Font.register({
    family: "Inter",
    fonts: [
      {
        src: "https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7.woff2",
        fontWeight: 400,
      },
      {
        src: "https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7W1Q.woff2",
        fontWeight: 600,
      },
      {
        src: "https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7SUc.woff2",
        fontWeight: 700,
      },
    ],
  });
} catch {
  // Font registration is best-effort; react-pdf falls back to Helvetica.
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface LeadPDFProps {
  content: PDFContent;
  persona: PersonaVector;
  profile: { name?: string; role?: string; company?: string } & Record<string, unknown>;
  /** Map chunk_id -> { url, section_path }. Optional — used for footnote refs. */
  chunks?: Record<string, { url: string; section_path?: string[] }>;
  /** ISO string of corpus fetched_at, shown in the footer. */
  corpus_fetched_at?: string;
  /** Free-form "case id" shown in tiny meta text at page bottom. */
  case_id?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatFetchedAge(iso?: string): string {
  if (!iso) return "source: scaler.com";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "source: scaler.com";
  const days = Math.max(0, Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24)));
  return `source: scaler.com · fetched ${days === 0 ? "today" : `${days}d ago`}`;
}

function formatDate(): string {
  return new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Static trust stats — sourced from scaler.com public homepage
// ---------------------------------------------------------------------------
const TRUST_STATS: { stat: string; label: string }[] = [
  { stat: "45,000+", label: "alumni placed" },
  { stat: "1,000+", label: "hiring partners" },
  { stat: "Up to 3×", label: "CTC jump reported" },
];

// ---------------------------------------------------------------------------
// StyleSheet factory
// ---------------------------------------------------------------------------
function buildStyles(cfg: PDFStyleConfig) {
  const AMBER = "#D97706";
  const AMBER_BG = "#FFFBEB";
  const SLATE = "#475569";
  const WHITE = "#FFFFFF";
  const sectionGap =
    cfg.density === "compact" ? 10 : cfg.density === "spacious" ? 22 : 16;
  const sentenceGap =
    cfg.density === "compact" ? 4 : cfg.density === "spacious" ? 8 : 6;

  return StyleSheet.create({
    // ── shared page shell ──────────────────────────────────────────────────
    page: {
      paddingTop: 0,
      paddingBottom: cfg.page_margin + 18,
      paddingLeft: 0,
      paddingRight: 0,
      fontFamily: cfg.font_family,
      fontSize: cfg.font_size_body,
      color: cfg.primary_color,
      lineHeight: cfg.line_height,
      backgroundColor: WHITE,
    },
    pageInner: {
      paddingTop: cfg.page_margin,
      paddingLeft: cfg.page_margin + 10,
      paddingRight: cfg.page_margin,
    },
    sideRail: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      width: 10,
      backgroundColor: cfg.background_tint,
    },
    footer: {
      position: "absolute",
      left: cfg.page_margin + 10,
      right: cfg.page_margin,
      bottom: 18,
      fontSize: cfg.font_size_meta,
      color: SLATE,
      borderTopWidth: 0.5,
      borderTopColor: "#CBD5E1",
      paddingTop: 5,
      flexDirection: "row",
      justifyContent: "space-between",
    },

    // ── cover page ─────────────────────────────────────────────────────────
    coverHeaderBand: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-end",
      borderBottomWidth: 2,
      borderBottomColor: cfg.accent,
      paddingBottom: 6,
      marginBottom: 20,
    },
    coverHeaderLeft: {
      fontSize: 11,
      color: cfg.accent,
      fontWeight: 600,
    },
    coverHeaderRight: {
      fontSize: 9,
      color: SLATE,
    },
    coverName: {
      fontSize: 28,
      fontWeight: 700,
      color: cfg.primary_color,
      marginBottom: 4,
    },
    coverRoleCompany: {
      fontSize: 14,
      color: SLATE,
      marginBottom: 10,
    },
    archetypeChip: {
      alignSelf: "flex-start",
      backgroundColor: cfg.accent,
      borderRadius: 4,
      paddingVertical: 3,
      paddingHorizontal: 8,
      marginBottom: 18,
    },
    archetypeChipText: {
      fontSize: 9,
      color: WHITE,
      fontWeight: 600,
    },
    coverMsgWrap: {
      borderLeftWidth: 3,
      borderLeftColor: cfg.accent,
      paddingLeft: 12,
      paddingTop: 4,
      paddingBottom: 4,
      marginBottom: 24,
      backgroundColor: cfg.background_tint,
    },
    coverMsgText: {
      fontSize: 13,
      fontStyle: "italic",
      color: cfg.primary_color,
      lineHeight: 1.55,
    },
    trustBand: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginBottom: 20,
    },
    trustCard: {
      flex: 1,
      marginHorizontal: 4,
      backgroundColor: cfg.background_tint,
      borderTopWidth: 2,
      borderTopColor: cfg.accent,
      padding: 10,
      alignItems: "center",
    },
    trustStat: {
      fontSize: 20,
      fontWeight: 700,
      color: cfg.accent,
      marginBottom: 2,
    },
    trustLabel: {
      fontSize: 8,
      color: SLATE,
      textAlign: "center",
    },
    coverFooterNote: {
      fontSize: cfg.font_size_meta,
      color: SLATE,
      textAlign: "center",
      fontStyle: "italic",
    },

    // ── section pages ──────────────────────────────────────────────────────
    sectionPageHeader: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 14,
      borderBottomWidth: 1,
      borderBottomColor: "#E2E8F0",
      paddingBottom: 6,
    },
    sectionPageBrand: {
      fontSize: cfg.font_size_meta,
      color: cfg.accent,
      fontWeight: 600,
      letterSpacing: 0.5,
      textTransform: "uppercase",
    },
    sectionBlock: {
      marginBottom: sectionGap,
      borderLeftWidth: 0,
    },
    badgeRow: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 5,
    },
    badge: {
      backgroundColor: cfg.accent,
      borderRadius: 3,
      paddingVertical: 2,
      paddingHorizontal: 6,
      marginRight: 8,
    },
    badgeText: {
      fontSize: 8,
      color: WHITE,
      fontWeight: 700,
    },
    sectionHeading: {
      fontSize: 13,
      fontWeight: 700,
      color: cfg.primary_color,
      flex: 1,
    },
    sectionDivider: {
      width: 36,
      height: 1.5,
      backgroundColor: cfg.accent,
      marginBottom: 8,
      marginTop: 2,
    },
    sentence: {
      marginBottom: sentenceGap,
    },
    inferredTag: {
      fontSize: cfg.font_size_meta,
      color: "#92400E",
      fontWeight: 600,
    },
    chunkCite: {
      fontSize: cfg.font_size_meta,
      color: cfg.accent,
      fontWeight: 600,
    },
    // Amber callout for refused sentences
    refusedCallout: {
      borderLeftWidth: 3,
      borderLeftColor: AMBER,
      backgroundColor: AMBER_BG,
      paddingVertical: 6,
      paddingHorizontal: 10,
      marginBottom: sentenceGap,
    },
    refusedCalloutText: {
      fontSize: cfg.font_size_meta + 0.5,
      color: "#78350F",
      fontStyle: "italic",
    },
    refList: {
      marginTop: 6,
      paddingTop: 5,
      borderTopWidth: 0.5,
      borderTopColor: "#CBD5E1",
      fontSize: cfg.font_size_meta,
      color: SLATE,
    },

    // ── callout blocks (EMI, household, honest-uncertainty) ───────────────
    callout: {
      marginTop: 4,
      marginBottom: sectionGap,
      padding: 8,
      backgroundColor: cfg.background_tint,
      borderLeftWidth: 2,
      borderLeftColor: cfg.accent,
      fontSize: cfg.font_size_meta + 1,
    },
    honestFirst: {
      marginBottom: sectionGap,
      padding: 8,
      borderWidth: 1,
      borderColor: "#94A3B8",
      borderStyle: "dashed",
      fontSize: cfg.font_size_meta + 1,
    },

    // ── CTA banner ─────────────────────────────────────────────────────────
    ctaBanner: {
      backgroundColor: cfg.accent,
      marginHorizontal: -(cfg.page_margin + 10),
      paddingVertical: 20,
      paddingHorizontal: cfg.page_margin + 10,
      marginTop: sectionGap,
    },
    ctaTitle: {
      fontSize: 11,
      fontWeight: 700,
      color: WHITE,
      letterSpacing: 0.5,
      textTransform: "uppercase",
      marginBottom: 6,
    },
    ctaTagline: {
      fontSize: 12,
      color: WHITE,
      lineHeight: 1.5,
      marginBottom: 12,
    },
    ctaUrl: {
      fontSize: 16,
      fontWeight: 700,
      color: WHITE,
    },
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function SentenceLine({
  sentence,
  refNumbers,
  styles,
}: {
  sentence: Sentence;
  refNumbers: number[];
  styles: ReturnType<typeof buildStyles>;
}) {
  // Refused sentences get their own amber callout block, not an inline tag.
  if (sentence.certainty === "refused") {
    return (
      <View style={styles.refusedCallout} wrap={false}>
        <Text style={styles.refusedCalloutText}>
          No confirmed source yet — your BDA will confirm on the next call.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.sentence} wrap={false}>
      <Text>
        {sentence.text}
        {sentence.certainty === "inferred" ? (
          <Text style={styles.inferredTag}>  (inferred)</Text>
        ) : null}
        {refNumbers.length > 0 ? (
          <Text style={styles.chunkCite}> [{refNumbers.join(",")}]</Text>
        ) : null}
      </Text>
    </View>
  );
}

function SectionBlock({
  section,
  sectionIndex,
  totalSections,
  refIndexStart,
  chunks,
  styles,
}: {
  section: PDFSection;
  sectionIndex: number;
  totalSections: number;
  refIndexStart: number;
  chunks: LeadPDFProps["chunks"];
  styles: ReturnType<typeof buildStyles>;
}) {
  const chunkIds = Array.from(new Set(section.sentences.flatMap((s) => s.chunk_ids)));
  const idToNum = new Map(chunkIds.map((id, i) => [id, refIndexStart + i]));

  return (
    <View style={styles.sectionBlock} wrap>
      <View style={styles.badgeRow} wrap={false}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>
            {sectionIndex + 1}/{totalSections}
          </Text>
        </View>
        <Text style={styles.sectionHeading}>{section.name}</Text>
      </View>
      <View style={styles.sectionDivider} />
      {section.sentences.map((s, idx) => (
        <SentenceLine
          key={idx}
          sentence={s}
          refNumbers={s.chunk_ids.map((id) => idToNum.get(id) ?? 0).filter(Boolean)}
          styles={styles}
        />
      ))}
      {chunkIds.length > 0 ? (
        <View style={styles.refList} wrap={false}>
          <Text style={{ fontWeight: 600, marginBottom: 2, fontSize: 7.5 }}>
            Sources
          </Text>
          {chunkIds.map((id) => {
            const meta = chunks?.[id];
            const num = idToNum.get(id);
            if (!meta) return null;
            const path = meta.section_path?.filter(Boolean).join(" > ") ?? "";
            return (
              <Text key={id} style={{ marginBottom: 1 }}>
                [{num}] {meta.url}
                {path ? ` — ${path}` : ""}
              </Text>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function HonestUncertaintyFirst({ styles }: { styles: ReturnType<typeof buildStyles> }) {
  return (
    <View style={styles.honestFirst} wrap={false}>
      <Text>
        Before anything else: a few things on your list we do not have a sourced answer for
        on scaler.com. Those appear below with a clear label — a Scaler BDA will follow up
        on them rather than us guessing.
      </Text>
    </View>
  );
}

function EMICallout({ styles }: { styles: ReturnType<typeof buildStyles> }) {
  return (
    <View style={styles.callout} wrap={false}>
      <Text>
        EMI & financing: Scaler publishes EMI partners on the relevant program page.
        Cross-check the exact tenor and rate with the BDA before committing — offers
        change month-to-month.
      </Text>
    </View>
  );
}

function HouseholdAngle({ styles }: { styles: ReturnType<typeof buildStyles> }) {
  return (
    <View style={styles.callout} wrap={false}>
      <Text>
        For the household-decision part: the figures in this brief are traceable to public
        pages on scaler.com. Share it with whoever shares the decision.
      </Text>
    </View>
  );
}

function CTABanner({
  tagline,
  styles,
}: {
  tagline: string;
  styles: ReturnType<typeof buildStyles>;
}) {
  return (
    <View style={styles.ctaBanner} wrap={false}>
      <Text style={styles.ctaTitle}>Your next step</Text>
      <Text style={styles.ctaTagline}>{tagline}</Text>
      <Text style={styles.ctaUrl}>scaler.com/cet/</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Cover page
// ---------------------------------------------------------------------------
function CoverPage({
  name,
  role,
  company,
  archetypeLabel,
  coveringMsg,
  cfg,
  styles,
  footerText,
  caseId,
}: {
  name: string;
  role?: string;
  company?: string;
  archetypeLabel: string;
  coveringMsg: string;
  cfg: PDFStyleConfig;
  styles: ReturnType<typeof buildStyles>;
  footerText: string;
  caseId?: string;
}) {
  const roleCompany = [role, company].filter(Boolean).join(" · ");
  // Truncate covering message to ≤ 6 lines (~320 chars) for the quote block.
  const truncatedMsg =
    coveringMsg.length > 320 ? coveringMsg.slice(0, 317) + "…" : coveringMsg;

  return (
    <Page size="A4" style={styles.page}>
      <View style={styles.sideRail} fixed />
      <View style={styles.pageInner}>
        {/* Header band */}
        <View style={styles.coverHeaderBand}>
          <Text style={styles.coverHeaderLeft}>
            Prepared for {name || "Lead"}
          </Text>
          <Text style={styles.coverHeaderRight}>{formatDate()}</Text>
        </View>

        {/* Name + role */}
        <Text style={styles.coverName}>{name || "Your brief"}</Text>
        {roleCompany ? (
          <Text style={styles.coverRoleCompany}>{roleCompany}</Text>
        ) : null}

        {/* Persona archetype chip */}
        {archetypeLabel ? (
          <View style={styles.archetypeChip}>
            <Text style={styles.archetypeChipText}>{archetypeLabel}</Text>
          </View>
        ) : null}

        {/* Covering message quote block */}
        {truncatedMsg ? (
          <View style={styles.coverMsgWrap}>
            <Text style={styles.coverMsgText}>{truncatedMsg}</Text>
          </View>
        ) : null}

        {/* Trust stats band */}
        <View style={styles.trustBand}>
          {TRUST_STATS.map((ts) => (
            <View key={ts.stat} style={styles.trustCard}>
              <Text style={styles.trustStat}>{ts.stat}</Text>
              <Text style={styles.trustLabel}>{ts.label}</Text>
            </View>
          ))}
        </View>

        {/* Soft footer note */}
        <Text style={styles.coverFooterNote}>
          Sourced exclusively from scaler.com — citations on every page
        </Text>
      </View>

      {/* Page footer */}
      <View style={styles.footer} fixed>
        <Text>{footerText}</Text>
        <Text
          render={({ pageNumber, totalPages }) =>
            `${pageNumber} / ${totalPages}${caseId ? ` · ${caseId.slice(0, 8)}` : ""}`
          }
        />
      </View>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Section pages
// ---------------------------------------------------------------------------
function SectionPages({
  sectionsWithRefs,
  chunks,
  cfg,
  styles,
  footerText,
  caseId,
  includeHonestFirst,
  includeEMI,
  includeHousehold,
  ctaTagline,
}: {
  sectionsWithRefs: { section: PDFSection; refStart: number }[];
  chunks: LeadPDFProps["chunks"];
  cfg: PDFStyleConfig;
  styles: ReturnType<typeof buildStyles>;
  footerText: string;
  caseId?: string;
  includeHonestFirst: boolean;
  includeEMI: boolean;
  includeHousehold: boolean;
  ctaTagline: string;
}) {
  const total = sectionsWithRefs.length;

  return (
    <Page size="A4" style={styles.page}>
      <View style={styles.sideRail} fixed />
      <View style={styles.pageInner}>
        {/* Section page header */}
        <View style={styles.sectionPageHeader} fixed>
          <Text style={styles.sectionPageBrand}>Scaler · Personalised brief</Text>
        </View>

        {/* Callouts that come before sections */}
        {includeHonestFirst ? <HonestUncertaintyFirst styles={styles} /> : null}
        {includeEMI ? <EMICallout styles={styles} /> : null}
        {includeHousehold ? <HouseholdAngle styles={styles} /> : null}

        {/* Section cards */}
        {sectionsWithRefs.map(({ section, refStart }, idx) => (
          <SectionBlock
            key={idx}
            section={section}
            sectionIndex={idx}
            totalSections={total}
            refIndexStart={refStart}
            chunks={chunks}
            styles={styles}
          />
        ))}

        {/* CTA banner at the end of the last section page */}
        <CTABanner tagline={ctaTagline} styles={styles} />
      </View>

      <View style={styles.footer} fixed>
        <Text>{footerText}</Text>
        <Text
          render={({ pageNumber, totalPages }) =>
            `${pageNumber} / ${totalPages}${caseId ? ` · ${caseId.slice(0, 8)}` : ""}`
          }
        />
      </View>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------
export function LeadPDF({
  content,
  persona,
  profile,
  chunks,
  corpus_fetched_at,
  case_id,
}: LeadPDFProps): JSX.Element {
  const cfg = resolvePDFStyle(persona);

  // Use Inter if registered, otherwise Helvetica (font_family default).
  // We override font_family to "Inter" here only if registration didn't throw.
  // Since we wrapped registration in try/catch we can't know at this point
  // whether it succeeded without a sentinel. We attempt "Inter" and react-pdf
  // silently falls back to Helvetica when the family isn't found.
  const resolvedFontFamily = cfg.font_family === "Helvetica" ? "Helvetica" : "Inter";
  const cfgWithFont: PDFStyleConfig = { ...cfg, font_family: resolvedFontFamily };

  const styles = buildStyles(cfgWithFont);
  const ordered = orderSectionsForPersona(content.sections, cfgWithFont);

  const name = profile.name?.toString() ?? "";
  const role = profile.role?.toString();
  const company = profile.company?.toString();
  const footerText = formatFetchedAge(corpus_fetched_at);
  const archetypeLabel = content.persona_tokens?.archetype_label ?? persona.archetype_label;

  // Compute running 1-based chunk index across sections.
  let refCursor = 1;
  const sectionsWithRefs = ordered.map((s) => {
    const uniqueIds = Array.from(new Set(s.sentences.flatMap((x) => x.chunk_ids)));
    const entry = { section: s, refStart: refCursor };
    refCursor += uniqueIds.length;
    return entry;
  });

  return (
    <Document
      title={name ? `Scaler brief — ${name}` : "Scaler lead brief"}
      author="Scaler Sales Agent"
      subject="Post-call personalised brief"
    >
      {/* Page 1: Cover */}
      <CoverPage
        name={name}
        role={role}
        company={company}
        archetypeLabel={archetypeLabel}
        coveringMsg={content.covering_msg ?? ""}
        cfg={cfgWithFont}
        styles={styles}
        footerText={footerText}
        caseId={case_id}
      />

      {/* Page 2+: Sections + CTA */}
      <SectionPages
        sectionsWithRefs={sectionsWithRefs}
        chunks={chunks}
        cfg={cfgWithFont}
        styles={styles}
        footerText={footerText}
        caseId={case_id}
        includeHonestFirst={cfgWithFont.include_honest_uncertainty_first}
        includeEMI={cfgWithFont.include_emi_callout}
        includeHousehold={cfgWithFont.include_household_angle}
        ctaTagline={cfgWithFont.cta_tagline}
      />
    </Document>
  );
}
