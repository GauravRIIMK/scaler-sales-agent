/**
 * Task 0.4 — Scaler.com corpus crawl.
 *
 * Strategy (fallback chain per BUILD_PLAN §0.4):
 *   1. Firecrawl HTTP API (if FIRECRAWL_API_KEY set) — cleanest, handles SPAs
 *   2. native fetch + cheerio — no external dep, works for SSR pages
 *   3. cached JSON in data/scaler_corpus.json — final fallback
 *
 * Output: data/scaler_corpus.json (array of page docs)
 *
 * Run: `npx tsx scripts/crawl.ts` (or `npm run crawl`)
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as cheerio from "cheerio";

interface PageSection {
  heading: string;
  path: string[];
  text: string;
}

interface PageDoc {
  url: string;
  fetched_at: string;
  title: string;
  h1: string;
  sections: PageSection[];
  source: "firecrawl" | "fetch-cheerio" | "cache";
}

const URLS = [
  // ── Original 5 (SSR, render cleanly via fetch-cheerio) ──────────────────────
  "https://www.scaler.com/academy/",
  "https://www.scaler.com/ai-machine-learning-course/",
  "https://www.scaler.com/data-science-course/",
  "https://www.scaler.com/devops-course/",
  "https://www.scaler.com/",

  // ── Added URLs (verified April 2026) ─────────────────────────────────────────
  // NOTE: All pages below are Next.js SPAs. They return ~3.4 KB of SSR HTML
  // (nav + form only; no page body). They REQUIRE Firecrawl (with waitFor:2500)
  // to render meaningful content. They are included here so the next crawler run
  // with FIRECRAWL_API_KEY set will pick them up. Bare fetch-cheerio will fall
  // back to cache (if available) or throw; that is expected and safe.
  "https://www.scaler.com/academy/placements/",     // Placement stats per track
  "https://www.scaler.com/refund-policy/",           // Refund policy terms
  "https://www.scaler.com/cet/",                     // Scaler CET (entrance test) info
  "https://www.scaler.com/academy/mentors/",         // Mentor / faculty directory
  "https://www.scaler.com/academy/about-us/",        // About Scaler / company
  "https://www.scaler.com/academy/faq/",             // FAQ page
  "https://www.scaler.com/scaler-school-of-technology/", // Scaler School of Technology
];

async function viaFirecrawl(url: string): Promise<PageDoc | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, waitFor: 2500 }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as {
      data?: { markdown?: string; metadata?: { title?: string } };
    };
    const md = j.data?.markdown;
    if (!md) return null;
    return {
      url,
      fetched_at: new Date().toISOString(),
      title: j.data?.metadata?.title ?? "",
      h1: firstH1FromMd(md) ?? "",
      sections: splitMdToSections(md),
      source: "firecrawl",
    };
  } catch {
    return null;
  }
}

async function viaFetch(url: string): Promise<PageDoc | null> {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; scaler-sales-agent-crawler/0.1; contact: demo)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-IN,en;q=0.9",
      },
    });
    if (!r.ok) return null;
    const html = await r.text();
    const $ = cheerio.load(html);
    const title = $("title").first().text().trim() || $("meta[property='og:title']").attr("content") || "";
    const h1 = $("h1").first().text().trim();

    // Strip nav/footer/script/style noise.
    $("script, style, nav, footer, header, [role='navigation'], [aria-label='Footer']").remove();
    $("iframe, svg, img").remove();

    const sections: PageSection[] = [];
    let currentPath: string[] = [];
    let currentHeading = h1 || "Main";
    let buffer: string[] = [];

    const pushSection = () => {
      const text = buffer.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (text.length > 60) sections.push({ heading: currentHeading, path: [...currentPath], text });
      buffer = [];
    };

    // Walk the main content in document order, break on headings.
    $("body *").each((_, el) => {
      const tag = el.type === "tag" ? el.tagName.toLowerCase() : "";
      if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") {
        pushSection();
        const heading = $(el).text().trim();
        if (!heading) return;
        const depth = Number(tag.slice(1));
        currentPath = currentPath.slice(0, depth - 1);
        currentPath[depth - 1] = heading;
        currentHeading = heading;
        return;
      }
      if (tag === "p" || tag === "li" || tag === "dd" || tag === "dt" || tag === "blockquote") {
        const t = $(el).text().trim();
        if (t) buffer.push(t);
      }
    });
    pushSection();

    // Deduplicate adjacent identical sections (Scaler marquees repeat content).
    const seen = new Set<string>();
    const unique = sections.filter((s) => {
      const k = s.heading + "::" + s.text.slice(0, 100);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return {
      url,
      fetched_at: new Date().toISOString(),
      title,
      h1,
      sections: unique,
      source: "fetch-cheerio",
    };
  } catch {
    return null;
  }
}

function firstH1FromMd(md: string): string | null {
  const m = md.match(/^# (.+)$/m);
  return m ? m[1].replace(/\*\*/g, "").trim() : null;
}

function splitMdToSections(md: string): PageSection[] {
  // Strip image syntax and noisy CTAs.
  const cleaned = md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[Watch on YouTube\]\([^)]*\)/g, "")
    .replace(/\[Talk to an Advisor\]\([^)]*\)/g, "")
    .replace(/\[Download Brochure\]\([^)]*\)/g, "")
    .replace(/\[Request a Call\]\([^)]*\)/g, "")
    .replace(/\[Talk To Advisor\]\([^)]*\)/g, "")
    .replace(/\[View Emi\]\([^)]*\)/g, "")
    .replace(/\[DOWNLOAD BROCHURE\]\([^)]*\)/g, "");

  const lines = cleaned.split("\n");
  const sections: PageSection[] = [];
  let currentPath: string[] = [];
  let currentHeading = "Intro";
  let buffer: string[] = [];

  const push = () => {
    const text = buffer.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length > 60) sections.push({ heading: currentHeading, path: [...currentPath], text });
    buffer = [];
  };

  for (const raw of lines) {
    const m = raw.match(/^(#{1,4})\s+(.+)$/);
    if (m) {
      push();
      const depth = m[1].length;
      const heading = m[2].replace(/\*\*/g, "").trim();
      currentPath = currentPath.slice(0, depth - 1);
      currentPath[depth - 1] = heading;
      currentHeading = heading;
      continue;
    }
    buffer.push(raw);
  }
  push();

  // Dedupe adjacent identical sections.
  const seen = new Set<string>();
  return sections.filter((s) => {
    const k = s.heading + "::" + s.text.slice(0, 120);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function crawlOne(url: string, cached: PageDoc | null): Promise<PageDoc> {
  const fc = await viaFirecrawl(url);
  if (fc && fc.sections.length >= 6) {
    console.log(`[crawl] ${url} via firecrawl (${fc.sections.length} sections)`);
    return fc;
  }
  const fe = await viaFetch(url);
  if (fe && fe.sections.length >= 6) {
    console.log(`[crawl] ${url} via fetch-cheerio (${fe.sections.length} sections)`);
    return fe;
  }
  if (cached) {
    console.log(`[crawl] ${url} falling back to cache`);
    return { ...cached, source: "cache" };
  }
  throw new Error(`crawl failed for ${url} — no fallback cache`);
}

async function main() {
  const dataDir = join(process.cwd(), "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const outPath = join(dataDir, "scaler_corpus.json");

  const cache: PageDoc[] = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, "utf8")) as PageDoc[])
    : [];
  const cacheByUrl = new Map(cache.map((d) => [d.url, d]));

  const results: PageDoc[] = [];
  for (const url of URLS) {
    const doc = await crawlOne(url, cacheByUrl.get(url) ?? null);
    results.push(doc);
  }

  writeFileSync(outPath, JSON.stringify(results, null, 2), "utf8");
  const totalSections = results.reduce((n, r) => n + r.sections.length, 0);
  console.log(`[crawl] wrote ${results.length} pages, ${totalSections} sections → ${outPath}`);
}

main().catch((e) => {
  console.error("[crawl] fatal:", e);
  process.exit(1);
});
