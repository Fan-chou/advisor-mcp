import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createMcpHandler,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import type { AdvisorConfig } from "./config.js";
import { createAdvisorServer } from "./server.js";
import type { AdvisorService } from "./advisor.js";

const MAX_TRACKED_CLIENTS = 10_000;

interface Window {
  startedAt: number;
  count: number;
}

export interface HttpServerHandle {
  handler: McpHttpHandler;
  close(): Promise<void>;
  address(): { host: string; port: number };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function bearerMatches(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  return timingSafeEqual(digest(match[1]), digest(expected));
}

function clientKey(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.socket.remoteAddress ?? "unknown";
}

function clientRateLimiter(limit: number) {
  const windows = new Map<string, Window>();

  return (key: string): { allowed: boolean; retryAfterSeconds: number } => {
    const now = Date.now();
    let window = windows.get(key);
    if (!window || now - window.startedAt >= 60_000) {
      window = { startedAt: now, count: 0 };
      windows.set(key, window);
    }
    window.count += 1;

    if (windows.size > MAX_TRACKED_CLIENTS) {
      for (const [candidate, entry] of windows) {
        if (now - entry.startedAt >= 60_000) windows.delete(candidate);
      }
      if (windows.size > MAX_TRACKED_CLIENTS) {
        windows.delete(windows.keys().next().value as string);
      }
    }

    return {
      allowed: window.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + 60_000 - now) / 1_000)),
    };
  };
}

function pathMatches(url: string | undefined, expected: string): boolean {
  if (!url) return false;
  try {
    const pathname = new URL(url, "http://localhost").pathname;
    return pathname === expected;
  } catch {
    return false;
  }
}

function sendNodeJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendNodeNoContent(
  response: ServerResponse,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(204, {
    "cache-control": "no-store",
    ...headers,
  });
  response.end();
}

export async function startHttpServer(
  config: AdvisorConfig,
  service: AdvisorService,
): Promise<HttpServerHandle> {
  const { http } = config;
  // The MCP session factory is intentionally fresh per HTTP exchange. Advisor
  // task state lives in AdvisorService, not in transport instances.
  const mcp = createMcpHandler(() => createAdvisorServer(config, service), {
    legacy: "stateless",
    maxRequestBodySize: http.maxBodyBytes,
    onerror: (error) => console.error(`[advisor-mcp] MCP HTTP error: ${error.message}`),
  });
  const toNode = toNodeHandler(mcp, {
    maxRequestBodySize: http.maxBodyBytes,
    onerror: (error) => console.error(`[advisor-mcp] HTTP adapter error: ${error.message}`),
  });

  const checkHost = http.allowedHosts.length
    ? hostHeaderValidation(http.allowedHosts)
    : null;
  const checkOrigin = http.allowedOrigins.length
    ? originValidation(http.allowedOrigins)
    : null;
  // Token-authenticated deployments may sit behind a reverse proxy whose Host
  // is the public domain. Only the unauthenticated loopback mode needs an
  // implicit localhost-only guard.
  const localOnlyGuards = !http.token;
  const checkLocalHost = hostHeaderValidation(localhostAllowedHostnames());
  const checkLocalOrigin = originValidation(localhostAllowedOrigins());
  const rateLimit = clientRateLimiter(http.requestsPerMinute);

  let inFlight = 0;
  let closing = false;

  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const path = pathMatches(request.url, http.path);

      if (method === "GET" && pathMatches(request.url, "/healthz")) {
        sendNodeJson(response, 200, {
          status: "ok",
          service: "advisor-mcp",
          transport: "http",
          auth: http.token ? "bearer" : "disabled-loopback-only",
        });
        return;
      }

      if (!path) {
        sendNodeJson(response, 404, { error: "Not found" });
        return;
      }

      if (closing) {
        sendNodeJson(response, 503, { error: "Server is shutting down" }, {
          connection: "close",
        });
        return;
      }

      if (checkHost) {
        if (!checkHost(request, response)) return;
      } else if (localOnlyGuards && !checkLocalHost(request, response)) {
        return;
      }

      if (checkOrigin) {
        if (!checkOrigin(request, response)) return;
      } else if (localOnlyGuards && !checkLocalOrigin(request, response)) {
        return;
      }

      const origin = request.headers.origin;
      if (typeof origin === "string" && (checkOrigin || localOnlyGuards)) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "origin");
        response.setHeader(
          "access-control-expose-headers",
          "mcp-protocol-version, mcp-session-id",
        );
      }

      if (method === "OPTIONS") {
        sendNodeNoContent(response, {
          ...(origin ? { "access-control-allow-origin": origin } : {}),
          ...(origin ? { vary: "origin" } : {}),
          "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
          "access-control-allow-headers":
            "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name",
          "access-control-max-age": "600",
        });
        return;
      }

      if (http.token && !bearerMatches(request.headers.authorization, http.token)) {
        sendNodeJson(response, 401, { error: "Unauthorized" }, {
          "www-authenticate": 'Bearer realm="advisor-mcp"',
        });
        return;
      }

      const decision = rateLimit(
        clientKey(request, http.trustProxy),
      );
      if (!decision.allowed) {
        sendNodeJson(response, 429, { error: "Too many requests" }, {
          "retry-after": String(decision.retryAfterSeconds),
        });
        return;
      }

      if (inFlight >= http.maxConcurrentRequests) {
        sendNodeJson(response, 503, { error: "Too many concurrent requests" }, {
          "retry-after": "1",
        });
        return;
      }

      inFlight += 1;
      try {
        await toNode(
          request as IncomingMessage & { method: string; url: string; headers: Record<string, string | string[] | undefined> },
          response,
        );
      } catch (error) {
        console.error(
          `[advisor-mcp] HTTP request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        sendNodeJson(response, 500, { error: "Internal server error" });
      } finally {
        inFlight -= 1;
      }
    })();
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 300_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(http.port, http.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  server.on("error", (error) => {
    console.error(`[advisor-mcp] HTTP server error: ${error.message}`);
  });

  return {
    handler: mcp,
    address: () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        return { host: http.host, port: http.port };
      }
      return { host: http.host, port: address.port };
    },
    async close() {
      closing = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(() => {
          server.closeAllConnections();
          resolve();
        }, 5_000).unref();
      });
      await mcp.close();
    },
  };
}
