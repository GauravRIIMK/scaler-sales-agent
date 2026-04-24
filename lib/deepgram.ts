/**
 * Task 2.2 — Deepgram Nova-3 STT wrapper.
 *
 * Two entry points:
 *   transcribeAudioFromUrl(url)       — Deepgram pulls the audio itself
 *   transcribeAudioFromBytes(buffer)  — we push a prerecorded buffer
 *
 * Both return:
 *   {
 *     transcript: string,     // diarised, LEAD/BDA labelled, newline-separated
 *     turns: Turn[],          // machine-readable turn list compatible with lib/extract
 *     language: string,
 *     duration_sec: number,
 *     model: string,
 *     raw_alternatives_count: number
 *   }
 *
 * Diarisation rule of thumb: speaker 0 is usually the BDA (they start the
 * call with a scripted greeting) but sales calls vary. We expose a
 * `leadIsSpeaker` override when callers have ground truth, and default
 * to heuristic: the speaker with the FEWER words is the LEAD (BDAs talk
 * more on post-call calls). Works well enough for our 30 req/day volume.
 *
 * Fallback: if Nova-3 fails (rare 5xx), retry once with Nova-2. If both
 * fail we surface the error to the caller — the generate route will mark
 * the case failed rather than silently proceed.
 */
import { createClient, type DeepgramClient } from "@deepgram/sdk";
import { log } from "./log";
import type { Turn, SpeakerLabel } from "./extract";

let _client: DeepgramClient | null = null;

export function deepgram(): DeepgramClient {
  if (_client) return _client;
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error("DEEPGRAM_API_KEY missing — audio path disabled");
  _client = createClient(key);
  return _client;
}

export function isDeepgramConfigured(): boolean {
  return Boolean(process.env.DEEPGRAM_API_KEY);
}

export interface STTResult {
  transcript: string;
  turns: Turn[];
  language: string;
  duration_sec: number;
  model: string;
  raw_alternatives_count: number;
}

export interface STTOpts {
  caseId?: string;
  component?: string;
  /** Hint which diarisation speaker index is the LEAD. If omitted, heuristic. */
  leadIsSpeaker?: number;
  /** BCP-47 language code. Default "en-IN" for Scaler's market. */
  language?: string;
}

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  punctuated_word?: string;
  speaker?: number;
}

interface DeepgramChannel {
  alternatives?: {
    transcript?: string;
    words?: DeepgramWord[];
    confidence?: number;
  }[];
}

interface DeepgramResult {
  metadata?: { duration?: number; model_info?: Record<string, unknown> };
  results?: {
    channels?: DeepgramChannel[];
    utterances?: {
      start: number;
      end: number;
      transcript: string;
      speaker: number;
      confidence?: number;
    }[];
  };
}

const PRIMARY_MODEL = "nova-3";
const FALLBACK_MODEL = "nova-2";

function buildTurns(result: DeepgramResult, leadIsSpeaker?: number): Turn[] {
  const utts = result.results?.utterances ?? [];
  if (utts.length === 0) {
    // Fall back to single-alternative transcript as one LEAD turn.
    const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    if (!transcript.trim()) return [];
    return [{ idx: 0, speaker: "LEAD", text: transcript.trim() }];
  }

  let leadIdx = leadIsSpeaker;
  if (leadIdx == null) {
    // Heuristic: the LEAD usually talks less than the BDA in a recording
    // submitted for this take-home (BDA is asking scripted questions).
    // Count characters per speaker and pick the shorter one.
    const perSpeaker = new Map<number, number>();
    for (const u of utts) {
      perSpeaker.set(u.speaker, (perSpeaker.get(u.speaker) ?? 0) + u.transcript.length);
    }
    if (perSpeaker.size <= 1) leadIdx = [...perSpeaker.keys()][0] ?? 0;
    else {
      const sorted = [...perSpeaker.entries()].sort((a, b) => a[1] - b[1]);
      leadIdx = sorted[0][0];
    }
  }

  return utts.map((u, i) => {
    const speaker: SpeakerLabel = u.speaker === leadIdx ? "LEAD" : "BDA";
    return {
      idx: i,
      speaker,
      start: u.start,
      end: u.end,
      text: u.transcript.trim(),
    };
  });
}

function turnsToReadableTranscript(turns: Turn[]): string {
  return turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
}

interface PrerecordedLike {
  transcribeUrl: (
    source: { url: string },
    opts: Record<string, unknown>
  ) => Promise<{ result?: DeepgramResult; error?: unknown }>;
  transcribeFile: (
    source: ArrayBuffer | Uint8Array | Buffer,
    opts: Record<string, unknown>
  ) => Promise<{ result?: DeepgramResult; error?: unknown }>;
}

async function runPrerecorded(
  source: { kind: "url"; url: string } | { kind: "bytes"; bytes: Uint8Array },
  model: string,
  opts: STTOpts
): Promise<DeepgramResult> {
  const client = deepgram();
  const prerecorded = (client.listen as unknown as { prerecorded: PrerecordedLike }).prerecorded;
  const language = opts.language ?? "en-IN";
  const params = {
    model,
    smart_format: true,
    diarize: true,
    utterances: true,
    punctuate: true,
    language,
  };

  if (source.kind === "url") {
    const { result, error } = await prerecorded.transcribeUrl({ url: source.url }, params);
    if (error) throw new Error(String((error as Error)?.message ?? error));
    if (!result) throw new Error("deepgram returned empty result");
    return result;
  }
  const { result, error } = await prerecorded.transcribeFile(source.bytes, params);
  if (error) throw new Error(String((error as Error)?.message ?? error));
  if (!result) throw new Error("deepgram returned empty result");
  return result;
}

async function transcribeViaSource(
  source: { kind: "url"; url: string } | { kind: "bytes"; bytes: Uint8Array },
  opts: STTOpts
): Promise<STTResult> {
  const component = opts.component ?? "stt";
  const started = Date.now();
  const sourceLabel = source.kind === "url" ? `url(${source.url.slice(0, 80)})` : `bytes(${source.bytes.length}b)`;

  await log({
    case_id: opts.caseId,
    task_id: "2.2-stt",
    component,
    event: "stt_start",
    provider: "deepgram",
    model: PRIMARY_MODEL,
    payload: { source: sourceLabel, language: opts.language ?? "en-IN" },
  });

  let result: DeepgramResult;
  let modelUsed = PRIMARY_MODEL;
  try {
    result = await runPrerecorded(source, PRIMARY_MODEL, opts);
  } catch (primaryErr) {
    await log({
      case_id: opts.caseId,
      task_id: "2.2-stt",
      component,
      level: "WARN",
      event: "stt_primary_failed_falling_back",
      provider: "deepgram",
      model: PRIMARY_MODEL,
      error_message: String(primaryErr).slice(0, 500),
    });
    result = await runPrerecorded(source, FALLBACK_MODEL, opts);
    modelUsed = FALLBACK_MODEL;
  }

  const turns = buildTurns(result, opts.leadIsSpeaker);
  const transcript = turnsToReadableTranscript(turns);
  const duration = Number(result.metadata?.duration ?? 0);
  const language = opts.language ?? "en-IN";
  const altCount = result.results?.channels?.[0]?.alternatives?.length ?? 0;

  await log({
    case_id: opts.caseId,
    task_id: "2.2-stt",
    component,
    event: "stt_ok",
    provider: "deepgram",
    model: modelUsed,
    latency_ms: Date.now() - started,
    payload: {
      turn_count: turns.length,
      char_count: transcript.length,
      duration_sec: duration,
      lead_turns: turns.filter((t) => t.speaker === "LEAD").length,
    },
  });

  return {
    transcript,
    turns,
    language,
    duration_sec: duration,
    model: modelUsed,
    raw_alternatives_count: altCount,
  };
}

export async function transcribeAudioFromUrl(url: string, opts: STTOpts = {}): Promise<STTResult> {
  return transcribeViaSource({ kind: "url", url }, opts);
}

export async function transcribeAudioFromBytes(
  bytes: Uint8Array,
  opts: STTOpts = {}
): Promise<STTResult> {
  return transcribeViaSource({ kind: "bytes", bytes }, opts);
}
