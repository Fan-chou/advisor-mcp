import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("starts over stdio and advertises instructions", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ADVISOR_API_KEY: "not-a-real-key",
      ADVISOR_PROVIDER: "openai-compatible",
      ADVISOR_MODEL: "test-model",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    assert.match(client.getInstructions() ?? "", /before committing to a non-obvious plan/);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "consult_advisor"));
  } finally {
    await client.close();
  }
});
