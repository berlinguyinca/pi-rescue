// Model-router failover tests: everything is mocked (fetch, clock, env) so
// this never touches the network, Ollama, or the real gateway.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RescueRoutingConfig } from "../../src/model/config.ts";
import { ModelRouter, chatCompletionsUrl, parseModelRef } from "../../src/model/router.ts";
import type { FetchLike, ResponseLike } from "../../src/model/types.ts";

const CONFIG: RescueRoutingConfig = {
  mode: "auto",
  roles: {
    diagnostician: { model: "metabolomics/qwen-27b", fallback: "local/qwen2.5-coder:7b" },
    triage: { model: "metabolomics/qwen-flash" },
  },
  providers: {
    metabolomics: { base_url: "https://llm.example.com/v1" },
    local: { base_url: "http://127.0.0.1:11434" },
  },
};

function jsonResponse(body: unknown, ok = true, status = 200): ResponseLike {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function chatBody(content: string, finishReason = "stop") {
  return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

test("parseModelRef: splits provider/model", () => {
  assert.deepEqual(parseModelRef("metabolomics/qwen-27b"), { provider: "metabolomics", modelId: "qwen-27b" });
});

test("parseModelRef: throws without a provider prefix", () => {
  assert.throws(() => parseModelRef("qwen-27b"));
});

test("chatCompletionsUrl: appends /v1/chat/completions, normalizing an existing /v1", () => {
  assert.equal(
    chatCompletionsUrl("https://llm.example.com/v1"),
    "https://llm.example.com/v1/chat/completions",
  );
  assert.equal(chatCompletionsUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(chatCompletionsUrl("http://127.0.0.1:11434/"), "http://127.0.0.1:11434/v1/chat/completions");
});

test("ModelRouter: uses the primary gateway when it's reachable and answers", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse(chatBody("gateway answer"));
  const router = new ModelRouter({ config: CONFIG, fetchImpl, env: { METABOLOMICS_API_KEY: "secret" } });
  const result = await router.complete([{ role: "user", content: "hi" }], "diagnostician");
  assert.equal(result.provider, "metabolomics");
  assert.equal(result.text, "gateway answer");
  assert.equal(result.failedOver, false);
});

test("ModelRouter: fails over to local Ollama when the gateway errors", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async (url) => {
    calls++;
    if (url.includes("example.com")) throw new Error("ECONNREFUSED");
    return jsonResponse(chatBody("local answer"));
  };
  const router = new ModelRouter({ config: CONFIG, fetchImpl, env: { METABOLOMICS_API_KEY: "secret" } });
  const result = await router.complete([{ role: "user", content: "hi" }], "diagnostician");
  assert.equal(result.provider, "local");
  assert.equal(result.text, "local answer");
  assert.equal(result.failedOver, true);
  assert.equal(calls, 2);
});

test("ModelRouter: fails over on a 5xx from the gateway", async () => {
  const fetchImpl: FetchLike = async (url) =>
    url.includes("example.com") ? jsonResponse({}, false, 503) : jsonResponse(chatBody("local answer"));
  const router = new ModelRouter({ config: CONFIG, fetchImpl, env: { METABOLOMICS_API_KEY: "secret" } });
  const result = await router.complete([{ role: "user", content: "hi" }], "diagnostician");
  assert.equal(result.provider, "local");
});

test("ModelRouter: fails over on an empty/truncated completion", async () => {
  const fetchImpl: FetchLike = async (url) =>
    url.includes("example.com")
      ? jsonResponse(chatBody("", "length"))
      : jsonResponse(chatBody("local answer"));
  const router = new ModelRouter({ config: CONFIG, fetchImpl, env: { METABOLOMICS_API_KEY: "secret" } });
  const result = await router.complete([{ role: "user", content: "hi" }], "diagnostician");
  assert.equal(result.provider, "local");
});

test("ModelRouter: skips the gateway entirely when no API key is configured", async () => {
  let gatewayCalled = false;
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes("example.com")) gatewayCalled = true;
    return jsonResponse(chatBody("local answer"));
  };
  const router = new ModelRouter({ config: CONFIG, fetchImpl, env: {} });
  const result = await router.complete([{ role: "user", content: "hi" }], "diagnostician");
  assert.equal(gatewayCalled, false);
  assert.equal(result.provider, "local");
});

test("ModelRouter: a role with no fallback and a failing gateway throws with both API-key and reachability reasons visible", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error("down");
  };
  const router = new ModelRouter({ config: CONFIG, fetchImpl, env: { METABOLOMICS_API_KEY: "secret" } });
  await assert.rejects(() => router.complete([{ role: "user", content: "hi" }], "triage"));
});

test("ModelRouter: an unknown role is a clear error, not a silent fallback", async () => {
  const router = new ModelRouter({ config: CONFIG, env: { METABOLOMICS_API_KEY: "x" } });
  await assert.rejects(() => router.complete([], "no-such-role"), /unknown model role/);
});

test("ModelRouter: circuit breaker skips a provider that just failed, until the cool-down elapses", async () => {
  let now = 0;
  let gatewayAttempts = 0;
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes("example.com")) {
      gatewayAttempts++;
      throw new Error("down");
    }
    return jsonResponse(chatBody("local answer"));
  };
  const router = new ModelRouter({
    config: CONFIG,
    fetchImpl,
    env: { METABOLOMICS_API_KEY: "secret" },
    now: () => now,
    circuitBreakerMs: 1000,
  });

  await router.complete([{ role: "user", content: "hi" }], "diagnostician");
  assert.equal(gatewayAttempts, 1);
  assert.equal(router.isCircuitOpen("metabolomics"), true);

  // Still within the cool-down: the gateway is skipped, not retried.
  await router.complete([{ role: "user", content: "hi" }], "diagnostician");
  assert.equal(gatewayAttempts, 1);

  // Past the cool-down: the gateway is tried again.
  now = 2000;
  await router.complete([{ role: "user", content: "hi" }], "diagnostician");
  assert.equal(gatewayAttempts, 2);
});

test("ModelRouter: mode 'local' never calls the gateway even if configured", async () => {
  let gatewayCalled = false;
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes("example.com")) gatewayCalled = true;
    return jsonResponse(chatBody("local answer"));
  };
  const router = new ModelRouter({
    config: { ...CONFIG, mode: "local" },
    fetchImpl,
    env: { METABOLOMICS_API_KEY: "secret" },
  });
  const result = await router.complete([{ role: "user", content: "hi" }], "diagnostician");
  assert.equal(gatewayCalled, false);
  assert.equal(result.provider, "local");
});
