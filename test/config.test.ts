import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, loadConfig, redactedConfigSummary } from "../src/config.js";

test("requires an explicit model id", () => {
  assert.throws(() => loadConfig({}), ConfigError);
});

test("supports a keyless local OpenAI-compatible endpoint", () => {
  const config = loadConfig({
    ADVISOR_MODEL: "local-model",
    ADVISOR_BASE_URL: "http://127.0.0.1:11434/v1",
  });
  assert.equal(config.apiKey, "");
  assert.equal(config.baseUrl, "http://127.0.0.1:11434/v1");
});

test("anthropic mode requires credentials and redacts the key from summaries", () => {
  assert.throws(
    () => loadConfig({ ADVISOR_PROVIDER: "anthropic", ADVISOR_MODEL: "claude-sonnet-4-6" }),
    ConfigError,
  );
  const config = loadConfig({
    ADVISOR_PROVIDER: "anthropic",
    ADVISOR_MODEL: "claude-sonnet-4-6",
    ANTHROPIC_API_KEY: "test-secret",
  });
  assert.doesNotMatch(JSON.stringify(redactedConfigSummary(config)), /test-secret/);
});
