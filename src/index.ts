#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AdvisorService } from "./advisor.js";
import { assertConfig, ConfigError, loadConfig } from "./config.js";
import { createProvider } from "./providers.js";
import { createAdvisorServer } from "./server.js";
import { FileSessionStore, MemorySessionStore } from "./store.js";
import { startHttpServer } from "./http.js";

async function main(): Promise<void> {
  const config = loadConfig();
  assertConfig(config);

  const store =
    config.store === "file"
      ? new FileSessionStore(config.dataDir)
      : new MemorySessionStore();
  const service = new AdvisorService(config, createProvider(config), store);
  if (config.transport === "http") {
    const handle = await startHttpServer(config, service);
    const address = handle.address();
    const shutdown = async () => {
      await handle.close().catch(() => undefined);
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());

    console.error(
      `[advisor-mcp] listening on http://${address.host}:${address.port}${config.http.path}`,
    );
    console.error(
      `[advisor-mcp] provider=${config.provider} model=${config.model} auth=${
        config.http.token ? "bearer" : "disabled-loopback-only"
      }`,
    );
    return;
  }

  const handle = serveStdio(() => createAdvisorServer(config, service), {
    onerror: (error) => console.error(`[advisor-mcp] transport error: ${error.message}`),
  });

  const shutdown = async () => {
    await handle.close().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  console.error(`[advisor-mcp] ready (provider=${config.provider}, model=${config.model})`);
  if (!config.apiKey && config.provider === "openai-compatible") {
    console.error(
      "[advisor-mcp] warning: no API key configured; use this only for a local keyless endpoint",
    );
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`[advisor-mcp] configuration error: ${error.message}`);
  } else {
    console.error(
      `[advisor-mcp] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
  process.exit(1);
});
