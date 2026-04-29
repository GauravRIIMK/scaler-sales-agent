/**
 * Sample personas — UI prefill data ONLY.
 *
 * These three samples populate the evaluator landing's persona cards and
 * the /leads/new ?prefill=<slug> form prefill. The pipeline (retrieve,
 * persona inference, PDF generation, verifier) does NOT branch on them
 * — same code path as a manually-entered profile, per R17 (BLUEPRINT.md:33,
 * disqualifier). Do not import this module from anywhere except UI
 * components.
 *
 * Source: derived from scripts/seed-two-stage.mjs (the verified seed
 * fixtures used in Loom recording prep). Edits to those personas should
 * stay in sync with this module.
 */

export interface SamplePersona {
  slug: string;         // URL-safe identifier (e.g. "rohan-sharma")
  displayName: string;  // "Rohan Sharma"
  shortName: string;    // "Rohan" — for compact UI labels
  role: string;         // "SDE-2 at TCS"
  oneLiner: string;     // 1-sentence persona summary for the card
  archetypeHint: string; // Anticipated archetype label, used as a chip on the card. NOT a pipeline input — display only.
  profileText: string;  // The free-form paragraph the form will paste into Lead context
  transcript: string;   // The post-call transcript text the form will paste
}

export const SAMPLE_PERSONAS: SamplePersona[] = [
  {
    slug: "rohan-sharma",
    displayName: "Rohan Sharma",
    shortName: "Rohan",
    role: "SDE-2 at TCS",
    oneLiner:
      "4-year Java backend engineer applying to AI roles, stuck at the practical RAG gap, price-sensitive and comparison-shopping on a 14 LPA salary.",
    archetypeHint: "mid-career · high-fin · moderate-tech",
    profileText: `Rohan Sharma is a 4-year SDE-2 at TCS Bangalore, currently on a Java/Spring backend modernization engagement for a US insurance client. He graduated B.Tech CSE from VIT in 2020 and earned an AWS Solutions Architect Associate certification in late 2023. Over the past six months he's been quietly applying to AI engineering roles at Razorpay, Atlassian, and a handful of YC startups — and getting rejected at the technical screen. He can read papers, but he can't ship a RAG pipeline end-to-end, and that gap is exactly what the interview loops are testing for. His friends from VIT are doing real ML work and he's tired of writing CRUD endpoints for someone else's roadmap. The 3.5L price tag for Scaler's AI engineering track is sitting heavy: his current CTC is 14 LPA and the salary jump quoted in marketing materials (16-22 LPA for AI roles) doesn't quite math out for him after factoring in tax. He's already done two free Andrew Ng courses and feels he's hit a ceiling on YouTube/Coursera content — he wants depth on production RAG, agents, and evals, not another theoretical ML refresher. He can stretch to 3.5L if EMI is on the table, but he's actively comparison-shopping with two cheaper bootcamps.`,
    transcript: `BDA: Hi Rohan, thanks for getting on. So you mentioned the AI engineering track — what's pulling you toward it now?\n\nRohan: Honestly, I've been at TCS for 4 years writing Java backends and I want out. I've been applying to AI eng roles for 6 months and getting rejected because I can read papers but I can't actually ship a RAG pipeline. So I need that hands-on depth.\n\nBDA: Got it. That's exactly what the track is built for. What's holding you back?\n\nRohan: Two things. First — why should I pay 3.5 lakhs when Andrew Ng has put basically the same content out for free on Coursera? I've done two of his courses already.\n\nBDA: Fair question. The free content gets you the theory. The track is built around shipping production systems — real RAG with vector stores, agentic workflows, evals you'd actually run in industry.\n\nRohan: Second — the realistic salary jump. You guys quote 16-22 LPA for AI roles. I'm at 14 LPA at TCS right now. After tax, 14 to 16 doesn't really math out for me.\n\nBDA: I hear that. The 22 number is for stronger profiles — typically people who already have a year of applied ML or strong open-source work. For someone in your spot, the realistic range first year post-program is closer to 18-20.\n\nRohan: OK. And one more — is the curriculum actually RAG, agents, evals depth, or is it theoretical ML?\n\nBDA: Applied. We can walk through the syllabus.`,
  },
  {
    slug: "karthik-iyer",
    displayName: "Karthik Iyer",
    shortName: "Karthik",
    role: "Senior SWE at Google",
    oneLiner:
      "9-year IIT Madras grad on Google Search Quality rotating into LLM eval work, not price-sensitive but surgically skeptical about cohort seniority and instructor credibility.",
    archetypeHint: "senior-career · low-fin · deep-tech",
    profileText: `Karthik Iyer is a 9-year Senior SWE at Google's Bangalore office, on the Search Quality team. He graduated dual-degree CS from IIT Madras in 2016. He is not price-sensitive — Google paid him roughly $400K total comp last year — but he is intensely time-sensitive and skeptical of anything that smells like a beginner cohort. He's looking at Scaler's AI/ML track because his internal team is rotating into LLM evaluation work and he wants to skill up faster than self-study allows, but he reads every page of the curriculum before committing his weekends. His questions are surgical: which instructors have actually shipped production AI systems versus only published academic papers; whether the cohort will include peers at his seniority or whether he'll be the senior-most by 5+ years; and what he'll specifically learn here that he can't pick up by reading the original Anthropic, OpenAI, and DeepMind papers. He'll exit after the first session if it feels remedial. He's done his homework — he already knows the names of three Scaler instructors and has cross-checked one of them on Google Scholar.`,
    transcript: `BDA: Hi Karthik, thanks for the time. You're at Google Search — what brought you to looking at Scaler?\n\nKarthik: My team is rotating into LLM eval work and I want to skill up faster than self-study. But I have three questions before I commit a weekend.\n\nBDA: Sure, go ahead.\n\nKarthik: First — what would I actually learn here that I can't pick up from reading the Anthropic, OpenAI, and DeepMind papers directly? I'm already doing that.\n\nBDA: The papers give you the what. The track gives you the how — production patterns, evaluation harnesses, debugging at scale. Practitioners who've shipped these systems telling you what doesn't work.\n\nKarthik: Second — who's the cohort? If I'm the senior-most by five years, this is a waste of my time.\n\nBDA: We do filter cohorts by experience tier. Your batch would be 6+ years average, several FAANG, a few tech leads.\n\nKarthik: Third — instructors. I want people who shipped production AI systems, not academics with citations. I've already cross-checked one of your instructors on Google Scholar.\n\nBDA: Most of our AI track instructors are from Microsoft, Adobe, and Flipkart's ML platforms. I can send you their detailed profiles.`,
  },
  {
    slug: "meera-patel",
    displayName: "Meera Patel",
    shortName: "Meera",
    role: "Final-year B.Tech CSE",
    oneLiner:
      "Tier-3 college final-year student with a confirmed government job offer, self-taught on LeetCode, family income below the program fee — needs an honest placement answer before parents will consider it.",
    archetypeHint: "early-career · high-fin · moderate-tech",
    profileText: `Meera Patel is in the final year of her B.Tech (CSE) at a Tier-3 engineering college in interior Maharashtra. Her family runs a small grocery shop; combined annual household income is approximately 2.8 lakhs. She has a confirmed offer from a state government IT department — 45,000 per month, joining July, with guaranteed pension and housing allowance — and her parents are pushing her to take it for the family stability. She has no LinkedIn presence yet. She's been quietly grinding LeetCode for 14 months and has built two personal projects: a college-fest registration app and a basic content-recommendation engine she trained on movie-rating data. She found Scaler through a friend's elder brother who placed at Walmart Labs after the DSA course. The 3.5L price for the program is more than her family earns in a year, so she's asked Scaler explicitly whether placement is guaranteed — her family is willing to sell their land if needed, but only with proof. The decision is jointly made with her parents, not a single phone call. She's anxious-positive: high motivation, high household risk-aversion, parents need to see government-job-equivalent certainty. The placement-guarantee question must be answered honestly — empty marketing language will lose this lead permanently.`,
    transcript: `BDA: Hi Meera, thanks for connecting. Your friend mentioned you have a government job offer in hand?\n\nMeera: Yes, 45,000 a month, joining in July. My parents want me to take it. But I want to do something in tech — I've been doing LeetCode and small projects for over a year.\n\nBDA: That's wonderful. What's the biggest question for you?\n\nMeera: First and most important — can you guarantee I'll get a job through Scaler? Because if I turn down the government offer for this, my family loses a sure thing.\n\nBDA: I want to be honest with you. We don't guarantee jobs — what we provide is mock interviews, portfolio coaching, and referrals to our 700+ partner companies. Outcomes data is on our placements page.\n\nMeera: Second — 3.5 lakhs is more than my family earns in a year. How do other students from similar backgrounds afford this?\n\nBDA: We have an income share agreement option — you pay nothing until you're placed at 5L+ CTC, then a percentage for 3 years. Some families also use education loans.\n\nMeera: Third — what if I can't clear the entrance test? I'm from a Tier-3 college, my fundamentals might be weak.\n\nBDA: There's a free 2-week prep before the test, and you can retake it twice. We don't filter aggressively at intake.`,
  },
];

export function getSamplePersona(slug: string): SamplePersona | undefined {
  return SAMPLE_PERSONAS.find((p) => p.slug === slug);
}
