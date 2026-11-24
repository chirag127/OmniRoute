import test from "node:test";
import assert from "node:assert/strict";

// #FIX: regression guard for the WAF retry config. The BaseExecutor must
// expose a WAF_RETRY_CONFIG with sane defaults and a backoff multiplier
// so the executor can retry 400 content-blocked before falling through to
// the 429/401/fallback chain.

test("WAF_RETRY_CONFIG has expected shape", async () => {
  const { BaseExecutor } = await import("../../open-sse/executors/base.ts");
  const cfg = BaseExecutor.WAF_RETRY_CONFIG;
  assert.equal(typeof cfg.maxAttempts, "number");
  assert.equal(typeof cfg.delayMs, "number");
  assert.equal(typeof cfg.backoffMultiplier, "number");
  assert.ok(cfg.maxAttempts >= 1, "maxAttempts must allow at least 1 retry");
  assert.ok(cfg.maxAttempts <= 5, "maxAttempts must be bounded to avoid runaway loops");
  assert.ok(cfg.delayMs >= 500, "initial delay must be long enough to clear the WAF");
  assert.ok(cfg.backoffMultiplier >= 1);

  // Derived: the second attempt should wait at least as long as the first
  const secondAttemptWait = cfg.delayMs * cfg.backoffMultiplier;
  assert.ok(
    secondAttemptWait > cfg.delayMs || cfg.backoffMultiplier === 1,
    "backoffMultiplier should produce a longer wait on the second attempt"
  );
});

test("WAF_RETRY_CONFIG differs from generic RETRY_CONFIG (different problem)", async () => {
  const { BaseExecutor } = await import("../../open-sse/executors/base.ts");
  const generic = BaseExecutor.RETRY_CONFIG;
  const waf = BaseExecutor.WAF_RETRY_CONFIG;
  assert.ok(waf !== generic, "WAF retry config should be distinct from generic retry config");
  // The WAF needs a different starting delay (longer) than the generic 429 path
  // because the WAF's per-IP suspicion bucket relaxes more slowly.
  assert.ok(waf.delayMs >= 500, "WAF initial delay should be >= 500ms");
});

async function runContentBlocked400(provider: string, model: string) {
  const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
  const { BaseExecutor } = await import("../../open-sse/executors/base.ts");
  const { delayMs, backoffMultiplier, maxAttempts } = BaseExecutor.WAF_RETRY_CONFIG;
  const maxDelayMs = delayMs * Math.pow(backoffMultiplier, maxAttempts - 1);
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const retryDelays: number[] = [];
  let calls = 0;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
    if (typeof ms === "number" && ms >= Math.round(delayMs / 2) && ms <= maxDelayMs) {
      retryDelays.push(ms);
      return originalSetTimeout(fn, 0, ...args);
    }
    return originalSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: "content_blocked" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await new DefaultExecutor(provider).execute({
      model,
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "synthetic-key", connectionId: "conn-a" },
    });
    return { status: result.response.status, calls, retryDelays };
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
}

test("400 content-blocked is not replayed for non-agentrouter providers", async () => {
  const r = await runContentBlocked400("openai", "gpt-4o");
  assert.equal(r.status, 400);
  assert.equal(r.calls, 1);
  assert.deepEqual(r.retryDelays, []);
});

test("400 content-blocked keeps the jittered WAF retry for agentrouter", async () => {
  const { BaseExecutor } = await import("../../open-sse/executors/base.ts");
  const { maxAttempts, delayMs, backoffMultiplier } = BaseExecutor.WAF_RETRY_CONFIG;
  const r = await runContentBlocked400("agentrouter", "claude-opus-4-8");
  assert.equal(r.status, 400);
  assert.equal(r.calls, 1 + maxAttempts);
  assert.equal(r.retryDelays.length, maxAttempts);
  r.retryDelays.forEach((ms, i) => {
    const base = delayMs * Math.pow(backoffMultiplier, i);
    assert.ok(
      ms >= Math.round(base / 2) && ms <= base,
      `delay ${ms} outside [${base / 2}, ${base}]`
    );
  });
});
