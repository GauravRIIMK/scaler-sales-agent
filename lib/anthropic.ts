import Anthropic from "@anthropic-ai/sdk";
import { log } from "./log";
import { withRetry } from "./fallback";

let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY missing");
  _client = new Anthropic({ apiKey: key });
  return _client;
}

export const MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
} as const;

export type ModelTier = keyof typeof MODELS;

/**
 * Wrapped message call with retry, logging, and token accounting.
 * All prompts inside the app go through this function so we have one logging funnel.
 */
export async function claudeMessage(args: {
  tier: ModelTier;
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  maxTokens?: number;
  temperature?: number;
  tools?: Anthropic.Tool[];
  toolChoice?: Anthropic.MessageCreateParams["tool_choice"];
  caseId?: string;
  taskId: string;
  component: string;
  promptVersion?: string;
}): Promise<Anthropic.Message> {
  const model = MODELS[args.tier];
  const started = Date.now();

  const response = await withRetry(
    () =>
      anthropic().messages.create({
        model,
        system: args.system,
        messages: args.messages,
        max_tokens: args.maxTokens ?? 2048,
        temperature: args.temperature ?? 0,
        tools: args.tools,
        tool_choice: args.toolChoice,
      }),
    {
      ctx: { caseId: args.caseId, taskId: args.taskId, component: args.component },
      providerName: "anthropic",
      attempts: 3,
    }
  );

  await log({
    case_id: args.caseId,
    task_id: args.taskId,
    component: args.component,
    event: "anthropic_message_ok",
    provider: "anthropic",
    model,
    prompt_version: args.promptVersion,
    tokens_in: response.usage.input_tokens,
    tokens_out: response.usage.output_tokens,
    latency_ms: Date.now() - started,
  });

  return response;
}

/** Pull text out of an assistant Message, concatenating text blocks. */
export function extractText(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Pull structured tool-use output from an assistant Message. */
export function extractToolUse<T = unknown>(msg: Anthropic.Message, toolName: string): T | null {
  const block = msg.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === toolName
  );
  return block ? (block.input as T) : null;
}
