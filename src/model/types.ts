// Shared types for the pi-rescue model router.

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** A role from `.pi/rescue.yaml` routing.roles, e.g. "diagnostician" or "triage". */
export type ModelRole = string;

export interface CompletionResult {
  text: string;
  /** Which provider actually answered — useful for the report footer and for tests. */
  provider: "metabolomics" | "local";
  model: string;
  /** Set when the preferred provider was tried and failed before falling back. */
  failedOver: boolean;
}

/** The minimal shape of `fetch` the router needs, so tests can inject a stub. */
export type FetchLike = (url: string, init?: RequestInitLike) => Promise<ResponseLike>;

export interface RequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
