// OpenAI-compatible model router: prefers the metabolomics gateway, auto-fails
// over to local Ollama when the gateway is unreachable, erroring, unauthenticated,
// or returns an unusable (empty / truncated) response. Pi itself has no such
// failover, which is the whole point of this module (see docs/specs §Components).
import type { RescueRoutingConfig } from "./config.ts";
import type { ChatMessage, CompletionResult, FetchLike, ModelRole, ResponseLike } from "./types.ts";

interface ParsedModelRef {
  provider: string;
  modelId: string;
}

/** Splits "metabolomics/qwen3.8-27b-..." into { provider: "metabolomics", modelId: "qwen3.8-27b-..." }. */
export function parseModelRef(ref: string): ParsedModelRef {
  const idx = ref.indexOf("/");
  if (idx === -1) {
    throw new Error(`model ref "${ref}" is missing a "<provider>/<model>" prefix`);
  }
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

/** Normalizes a provider base_url (with or without a trailing /v1) to its OpenAI-compatible chat endpoint. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const withoutV1 = trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
  return `${withoutV1}/v1/chat/completions`;
}

interface Candidate {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKeyEnv: string | undefined;
}

export interface ModelRouterOptions {
  config: RescueRoutingConfig;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injectable clock for deterministic circuit-breaker tests. */
  now?: () => number;
  /** Overrides the timeout for every provider, gateway and local alike. Prefer the per-provider options below. */
  timeoutMs?: number;
  /** Timeout for the metabolomics gateway. Default 120s: a 27B+ reasoning model's full completion, not just TTFT. */
  gatewayTimeoutMs?: number;
  /** Timeout for local Ollama. Default 300s: a 7-8B model on CPU, or a loaded-but-cold GPU model, is slower still. */
  localTimeoutMs?: number;
  /** Sent as `max_tokens`. Too small and a reasoning model returns empty content with finish_reason "length" —
   *  which the router (correctly) treats as a failed completion — on every single call. Default 4096. */
  maxTokens?: number;
  /** How long a failed gateway is skipped before being retried. Default 60s. */
  circuitBreakerMs?: number;
  /** Injectable environment, defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Routes `complete()` calls to the model configured for a role in
 * `.pi/rescue.yaml`, preferring the primary (usually the metabolomics
 * gateway) and falling back to the role's `fallback` model (usually local
 * Ollama) on any failure. A short-lived circuit breaker remembers a provider
 * that just failed so an offline box pays one timeout, not one per request.
 */
export class ModelRouter {
  private readonly config: RescueRoutingConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly gatewayTimeoutMs: number;
  private readonly localTimeoutMs: number;
  private readonly maxTokens: number;
  private readonly circuitBreakerMs: number;
  private readonly env: Record<string, string | undefined>;
  private readonly downUntil = new Map<string, number>();

  constructor(options: ModelRouterOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = options.now ?? (() => Date.now());
    this.gatewayTimeoutMs = options.gatewayTimeoutMs ?? options.timeoutMs ?? 120_000;
    this.localTimeoutMs = options.localTimeoutMs ?? options.timeoutMs ?? 300_000;
    this.maxTokens = options.maxTokens ?? 4096;
    this.circuitBreakerMs = options.circuitBreakerMs ?? 60_000;
    this.env = options.env ?? process.env;
  }

  private timeoutFor(provider: string): number {
    return provider === "metabolomics" ? this.gatewayTimeoutMs : this.localTimeoutMs;
  }

  /** Whether `provider` was marked down by a recent failure and is still inside its cool-down window. */
  isCircuitOpen(provider: string): boolean {
    const until = this.downUntil.get(provider);
    return until !== undefined && this.now() < until;
  }

  private markDown(provider: string): void {
    this.downUntil.set(provider, this.now() + this.circuitBreakerMs);
  }

  private apiKeyEnvFor(providerName: string): string | undefined {
    if (providerName === "metabolomics") return "METABOLOMICS_API_KEY";
    const cfg = this.config.providers[providerName] as { api_key_env?: string } | undefined;
    return cfg?.api_key_env;
  }

  private candidatesFor(role: ModelRole): Candidate[] {
    const roleConfig = this.config.roles[role];
    if (!roleConfig) {
      throw new Error(`unknown model role "${role}" — check .pi/rescue.yaml routing.roles`);
    }
    const refs: string[] = [];
    if (this.config.mode !== "local") refs.push(roleConfig.model);
    if (this.config.mode !== "gateway" && roleConfig.fallback) refs.push(roleConfig.fallback);
    if (refs.length === 0) refs.push(roleConfig.model);

    const candidates: Candidate[] = [];
    for (const ref of refs) {
      const { provider, modelId } = parseModelRef(ref);
      const providerConfig = this.config.providers[provider];
      if (!providerConfig) continue; // unconfigured provider: skip rather than throw, another candidate may work
      candidates.push({
        provider,
        modelId,
        baseUrl: providerConfig.base_url,
        apiKeyEnv: this.apiKeyEnvFor(provider),
      });
    }
    return candidates;
  }

  /** Completes a chat for `role`, trying the primary model then the configured fallback. */
  async complete(messages: ChatMessage[], role: ModelRole): Promise<CompletionResult> {
    const candidates = this.candidatesFor(role);
    if (candidates.length === 0) {
      throw new Error(`no usable provider for role "${role}"`);
    }

    const errors: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (!candidate) continue;

      if (candidate.apiKeyEnv && !this.env[candidate.apiKeyEnv]) {
        errors.push(`${candidate.provider}: ${candidate.apiKeyEnv} is not set`);
        continue;
      }
      if (this.isCircuitOpen(candidate.provider)) {
        errors.push(`${candidate.provider}: skipped, still in cool-down after a recent failure`);
        continue;
      }

      try {
        const text = await this.callOnce(candidate, messages);
        return {
          text,
          provider: candidate.provider === "metabolomics" ? "metabolomics" : "local",
          model: candidate.modelId,
          failedOver: i > 0,
        };
      } catch (error) {
        this.markDown(candidate.provider);
        errors.push(`${candidate.provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`all model candidates for role "${role}" failed:\n${errors.join("\n")}`);
  }

  private async callOnce(candidate: Candidate, messages: ChatMessage[]): Promise<string> {
    const url = chatCompletionsUrl(candidate.baseUrl);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (candidate.apiKeyEnv) {
      const key = this.env[candidate.apiKeyEnv];
      if (key) headers.authorization = `Bearer ${key}`;
    }

    let response: ResponseLike;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = controller
      ? setTimeout(() => controller.abort(), this.timeoutFor(candidate.provider))
      : undefined;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: candidate.modelId,
          messages,
          stream: false,
          max_tokens: this.maxTokens,
        }),
        signal: controller?.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const choice = payload.choices?.[0];
    const content = choice?.message?.content?.trim();
    if (!content) {
      throw new Error(
        `empty completion from ${candidate.provider}/${candidate.modelId}${
          choice?.finish_reason ? ` (finish_reason=${choice.finish_reason})` : ""
        }`,
      );
    }
    return content;
  }
}
