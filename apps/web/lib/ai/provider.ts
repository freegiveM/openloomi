/**
 * Unified LLM provider abstraction.
 *
 * The web app historically routed AI calls through separate Anthropic and
 * OpenAI-compatible paths. This interface gives those HTTP transports, AWS
 * Bedrock Converse, and the optional agent-runtime fallback one completion
 * contract. Provider identity and wire protocol remain separate.
 *
 * Resolution lives in {@link resolveLlmProvider}. Every implementation
 * satisfies
 * {@link LlmProvider}, so a call site that talks to one of them is
 * structurally the same as a call site that talks to any other.
 */

export type ProviderKind = "anthropic_messages" | "chat_completions";

export type ProviderFlavor =
  | "anthropic_http"
  | "openai_http"
  | "bedrock"
  | "agent_runtime";

/** A single image input. Mirrors the shape Anthropic / OpenAI take. */
export interface LlmImage {
  /** Base64-encoded bytes (no data-URL prefix). */
  base64: string;
  /** MIME type, e.g. `image/png`, `image/jpeg`. */
  mediaType: string;
}

export interface LlmCompleteRequest {
  /** Optional system prompt. Prepended to user content for the agent runtime path. */
  system?: string;
  /**
   * User content. Either a single string (most chat / proxy call sites) or an
   * array of text blocks (the Anthropic Messages shape). The resolver
   * implementations flatten both shapes consistently.
   */
  userContent: string | Array<{ type: "text"; text: string }>;
  /** Optional image inputs (vision). HTTP providers pass these as base64 parts; agent runtime materializes to disk. */
  images?: LlmImage[];
  /** Optional model override. Falls back to the provider's configured default. */
  model?: string;
  /** Optional max tokens. */
  maxTokens?: number;
  /** Optional abort signal — forwarded to the underlying fetch / CLI. */
  signal?: AbortSignal;
  /** Optional timeout in ms. Defaults to 120_000. */
  timeoutMs?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmCompleteResponse {
  /** Concatenated assistant text. */
  text: string;
  /** Model that produced the response (echo of the effective model). */
  model: string;
  /** Optional token usage, when the underlying provider surfaces it. */
  usage?: LlmUsage;
}

export interface LlmProvider {
  /** Stable provider identity used for routing and usage records. */
  providerId: string;
  /** Which transport / protocol this provider speaks. */
  flavor: ProviderFlavor;
  /** Default model id (or `"agent-runtime"` if the runtime decides per call). */
  model: string;
  /**
   * Single-shot completion. Implementations buffer the underlying stream
   * (HTTP `stream:false` or agent CLI events) into a single text response.
   */
  complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse>;
}
