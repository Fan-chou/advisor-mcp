import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import type { AdvisorConfig } from "../src/config.js";
import { AnthropicProvider, OpenAICompatibleProvider } from "../src/providers.js";

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function config(baseUrl: string, overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    provider: "openai-compatible",
    model: "test-model",
    apiKey: "test-key",
    baseUrl,
    apiVersion: "2023-06-01",
    tokenParam: "max_completion_tokens",
    maxOutputTokens: 800,
    timeoutMs: 5_000,
    maxContextChars: 10_000,
    maxCallsPerSession: 5,
    maxCallsPerMinute: 10,
    dataDir: "/tmp/unused",
    store: "memory",
    defaultAdviceStyle: "brief",
    http: {
      host: "127.0.0.1",
      port: 8787,
      path: "/mcp",
      token: "",
      allowUnauthenticatedLoopback: true,
      allowedOrigins: [],
      allowedHosts: [],
      maxBodyBytes: 1_048_576,
      maxConcurrentRequests: 8,
      requestsPerMinute: 120,
      trustProxy: false,
    },
    ...overrides,
  };
}

test("OpenAI-compatible provider preserves array content and usage", async () => {
  await withServer(
    (req, res, body) => {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer test-key");
      const payload = JSON.parse(body);
      assert.equal(payload.model, "test-model");
      assert.equal(payload.max_completion_tokens, 800);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  { type: "text", text: "first " },
                  { type: "text", text: "second" },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    },
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider(config(baseUrl));
      const result = await provider.complete({
        system: "system",
        user: "user",
        maxOutputTokens: 800,
      });
      assert.equal(result.text, "first second");
      assert.equal(result.usage?.totalTokens, 15);
    },
  );
});

test("OpenAI-compatible provider supports keyless local endpoints", async () => {
  await withServer(
    (req, res, body) => {
      assert.equal(req.headers.authorization, undefined);
      const payload = JSON.parse(body);
      assert.equal(payload.messages[0].role, "system");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    },
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider(config(baseUrl, { apiKey: "" }));
      const result = await provider.complete({ system: "s", user: "u", maxOutputTokens: 100 });
      assert.equal(result.text, "ok");
    },
  );
});

test("Anthropic provider sends the required headers and joins text blocks", async () => {
  await withServer(
    (req, res, body) => {
      assert.equal(req.url, "/v1/messages");
      assert.equal(req.headers["x-api-key"], "anthropic-key");
      assert.equal(req.headers["anthropic-version"], "2023-06-01");
      const payload = JSON.parse(body);
      assert.equal(payload.system, "sys");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
          ],
          usage: { input_tokens: 7, output_tokens: 3 },
        }),
      );
    },
    async (baseUrl) => {
      const provider = new AnthropicProvider(
        config(baseUrl, { provider: "anthropic", apiKey: "anthropic-key" }),
      );
      const result = await provider.complete({
        system: "sys",
        user: "usr",
        maxOutputTokens: 100,
      });
      assert.equal(result.text, "hello world");
      assert.equal(result.usage?.totalTokens, 10);
    },
  );
});

test("provider surfaces HTTP errors without leaking the key", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"unauthorized","echo":"test-key"}');
    },
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider(config(baseUrl));
      await assert.rejects(
        provider.complete({ system: "s", user: "u", maxOutputTokens: 100 }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /HTTP 401/);
          assert.doesNotMatch(error.message, /test-key/);
          return true;
        },
      );
    },
  );
});
