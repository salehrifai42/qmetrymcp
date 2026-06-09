import { test } from "node:test";
import assert from "node:assert/strict";
import { createQtmClient, resolveBaseUrl, QtmApiError, type Transport } from "./client.js";

/** A scripted in-memory transport adapter — the test-side counterpart to global `fetch`. */
function fakeTransport(responses: Response[]): {
  transport: Transport;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const transport: Transport = async (url, init) => {
    calls.push({ url, init });
    const res = responses[Math.min(i, responses.length - 1)];
    i++;
    return res;
  };
  return { transport, calls };
}

const noSleep = () => Promise.resolve();

test("the api key is trimmed when added to the header", async () => {
  const { transport, calls } = fakeTransport([new Response("{}", { status: 200 })]);
  const client = createQtmClient({ apiKey: "  token-with-newline\n", baseUrl: "https://api.test", transport });

  await client.fetch("/x");

  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.apiKey, "token-with-newline");
});

test("caller-supplied headers cannot clobber the auth key", async () => {
  const { transport, calls } = fakeTransport([new Response("{}", { status: 200 })]);
  const client = createQtmClient({ apiKey: "real-key", baseUrl: "https://api.test", transport });

  await client.fetch("/x", { headers: { apiKey: "attacker", "X-Trace": "1" } });

  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.apiKey, "real-key");
  assert.equal(headers["X-Trace"], "1");
});

test("resolveBaseUrl maps regions and defaults to US", () => {
  assert.equal(resolveBaseUrl("US"), "https://qtmcloud.qmetry.com/rest/api/latest");
  assert.equal(resolveBaseUrl("au"), "https://syd-qtmcloud.qmetry.com/rest/api/latest");
  assert.equal(resolveBaseUrl(undefined), "https://qtmcloud.qmetry.com/rest/api/latest");
  assert.equal(resolveBaseUrl("mars"), "https://qtmcloud.qmetry.com/rest/api/latest");
});

test("fetch parses a JSON body and injects auth + base url", async () => {
  const { transport, calls } = fakeTransport([
    new Response(JSON.stringify({ id: 7, key: "FS-TC-7" }), { status: 200 }),
  ]);
  const client = createQtmClient({ apiKey: "secret-key", baseUrl: "https://api.test", transport });

  const body = await client.fetch("/testcases/7");

  assert.deepEqual(body, { id: 7, key: "FS-TC-7" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.test/testcases/7");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.apiKey, "secret-key");
  assert.equal(headers["Content-Type"], "application/json");
});

test("a 204/empty body becomes null", async () => {
  const { transport } = fakeTransport([new Response("", { status: 200 })]);
  const client = createQtmClient({ apiKey: "k", baseUrl: "https://api.test", transport });
  assert.equal(await client.fetch("/noop"), null);
});

test("a non-2xx response throws QtmApiError carrying the parsed body", async () => {
  const { transport } = fakeTransport([
    new Response(JSON.stringify({ message: "bad" }), { status: 400, statusText: "Bad Request" }),
  ]);
  const client = createQtmClient({ apiKey: "k", baseUrl: "https://api.test", transport });

  await assert.rejects(
    () => client.fetch("/x", { method: "POST", body: "{}" }),
    (err: unknown) => {
      assert.ok(err instanceof QtmApiError);
      assert.equal(err.status, 400);
      assert.deepEqual(err.body, { message: "bad" });
      return true;
    }
  );
});

test("a 429 is retried with back-off, then succeeds", async () => {
  const { transport, calls } = fakeTransport([
    new Response("", { status: 429, headers: { "Retry-After": "1" } }),
    new Response("", { status: 429, headers: { "Retry-After": "1" } }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ]);
  const slept: number[] = [];
  const client = createQtmClient({
    apiKey: "k",
    baseUrl: "https://api.test",
    transport,
    sleep: async (ms) => void slept.push(ms),
    maxAttempts: 3,
  });

  const body = await client.fetch("/rate-limited");

  assert.deepEqual(body, { ok: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(slept, [1000, 2000]); // back-off grows with attempt
});

test("a 429 that never clears surfaces as an error after maxAttempts", async () => {
  const { transport, calls } = fakeTransport([
    new Response("nope", { status: 429, statusText: "Too Many Requests" }),
  ]);
  const client = createQtmClient({
    apiKey: "k",
    baseUrl: "https://api.test",
    transport,
    sleep: noSleep,
    maxAttempts: 3,
  });

  await assert.rejects(() => client.fetch("/always-limited"), (err: unknown) => {
    assert.ok(err instanceof QtmApiError);
    assert.equal(err.status, 429);
    return true;
  });
  assert.equal(calls.length, 3);
});
