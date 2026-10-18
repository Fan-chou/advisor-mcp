import { randomUUID } from "node:crypto";
import { AdviceParseError, parseAdviceResponse } from "./advice.js";
import type { AdvisorConfig } from "./config.js";
import { buildPrompt } from "./prompt.js";
import { ProviderError } from "./providers.js";
import type {
  Advice,
  AdvisorProvider,
  ConsultRequest,
  SessionSnapshot,
  SessionState,
  SessionStore,
} from "./types.js";

const MAX_STORED_TURNS = 20;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class AdvisorError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_session"
      | "limit_exceeded"
      | "rate_limited"
      | "provider_error"
      | "invalid_response"
      | "cancelled",
  ) {
    super(message);
    this.name = "AdvisorError";
  }
}

function now(): string {
  return new Date().toISOString();
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function touch(session: SessionState, request: ConsultRequest): void {
  if (request.goal) session.goal = request.goal.trim();
  session.constraints = unique([...session.constraints, ...(request.constraints ?? [])]);
  session.filesTouched = unique([...session.filesTouched, ...(request.filesTouched ?? [])]);
}

function updateFromAdvice(session: SessionState, request: ConsultRequest, advice: Advice): void {
  session.openQuestions = unique(advice.evidenceGaps);
  if (advice.verdict === "proceed" || advice.verdict === "adjust") {
    session.decisions = unique([
      ...session.decisions,
      `${request.kind}: ${advice.summary}`,
    ]).slice(-10);
  }
  session.summary = advice.summary;
}

function newSession(id: string): SessionState {
  const timestamp = now();
  return {
    id,
    createdAt: timestamp,
    updatedAt: timestamp,
    calls: 0,
    callTimestamps: [],
    turns: [],
    constraints: [],
    filesTouched: [],
    openQuestions: [],
    decisions: [],
  };
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new AdvisorError(
      "session_id must be 1-128 characters using letters, digits, '.', '_', ':' or '-'",
      "invalid_session",
    );
  }
}

function snapshot(session: SessionState, maxCalls: number): SessionSnapshot {
  const cutoff = Date.now() - 60_000;
  const callsLastMinute = (session.callTimestamps ?? []).filter(
    (timestamp) => timestamp >= cutoff,
  ).length;
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    calls: session.calls,
    callsLastMinute,
    remainingCalls: Math.max(0, maxCalls - session.calls),
    ...(session.goal ? { goal: session.goal } : {}),
    constraints: session.constraints,
    filesTouched: session.filesTouched,
    openQuestions: session.openQuestions,
    decisions: session.decisions,
    recentTurns: session.turns.slice(-5).map((turn) => ({
      timestamp: turn.timestamp,
      kind: turn.kind,
      question: turn.question,
      verdict: turn.advice.verdict,
      summary: turn.advice.summary,
    })),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AdvisorError("Advisor request was cancelled", "cancelled"));
      },
      { once: true },
    );
  });
}

export interface SessionUpdate {
  sessionId: string;
  goal?: string;
  addConstraints?: string[];
  addFilesTouched?: string[];
  replaceOpenQuestions?: string[];
}

export class AdvisorService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: AdvisorConfig,
    private readonly provider: AdvisorProvider,
    private readonly store: SessionStore,
  ) {}

  private serialize<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(sessionId, next);
    void next
      .catch(() => undefined)
      .then(() => {
        if (this.queues.get(sessionId) === next) this.queues.delete(sessionId);
      });
    return next;
  }

  private async load(sessionId: string): Promise<SessionState> {
    assertSessionId(sessionId);
    return (await this.store.get(sessionId)) ?? newSession(sessionId);
  }

  async getSession(sessionId: string): Promise<SessionSnapshot> {
    return snapshot(await this.load(sessionId), this.config.maxCallsPerSession);
  }

  async updateSession(update: SessionUpdate): Promise<SessionSnapshot> {
    return this.serialize(update.sessionId, async () => {
      const session = await this.load(update.sessionId);
      if (update.goal !== undefined) {
        if (update.goal.trim()) session.goal = update.goal.trim();
        else delete session.goal;
      }
      session.constraints = unique([
        ...session.constraints,
        ...(update.addConstraints ?? []),
      ]);
      session.filesTouched = unique([
        ...session.filesTouched,
        ...(update.addFilesTouched ?? []),
      ]);
      if (update.replaceOpenQuestions) {
        session.openQuestions = unique(update.replaceOpenQuestions);
      }
      session.updatedAt = now();
      await this.store.save(session);
      return snapshot(session, this.config.maxCallsPerSession);
    });
  }

  async resetSession(sessionId: string): Promise<boolean> {
    return this.serialize(sessionId, async () => {
      assertSessionId(sessionId);
      return this.store.delete(sessionId);
    });
  }

  async consult(
    request: ConsultRequest,
    signal?: AbortSignal,
  ): Promise<Advice> {
    return this.serialize(request.sessionId, async () => {
      const session = await this.load(request.sessionId);
      if (session.calls >= this.config.maxCallsPerSession) {
        throw new AdvisorError(
          `Session call limit reached (${this.config.maxCallsPerSession}). Reset the session or raise ADVISOR_MAX_CALLS_PER_SESSION.`,
          "limit_exceeded",
        );
      }

      const nowMs = Date.now();
      session.callTimestamps = (session.callTimestamps ?? []).filter(
        (timestamp) => timestamp >= nowMs - 60_000,
      );
      if (session.callTimestamps.length >= this.config.maxCallsPerMinute) {
        throw new AdvisorError(
          `Session rate limit reached (${this.config.maxCallsPerMinute} calls per minute). Wait before retrying.`,
          "rate_limited",
        );
      }

      touch(session, request);
      session.calls += 1;
      session.callTimestamps.push(nowMs);
      session.updatedAt = now();
      await this.store.save(session);

      const prompt = buildPrompt({
        request,
        session,
        style: request.style ?? this.config.defaultAdviceStyle,
        maxContextChars: this.config.maxContextChars,
      });

      let responseText: string;
      let model: string;
      let usage: Advice["usage"];
      try {
        const result = await this.requestWithRetry(prompt.system, prompt.user, signal);
        responseText = result.text;
        model = result.model;
        usage = result.usage;
      } catch (error) {
        if (error instanceof AdvisorError) throw error;
        if (error instanceof ProviderError) {
          throw new AdvisorError(error.message, "provider_error");
        }
        throw new AdvisorError(
          `Advisor request failed: ${error instanceof Error ? error.message : String(error)}`,
          "provider_error",
        );
      }

      let advice: Advice;
      try {
        advice = parseAdviceResponse(responseText, {
          sessionId: request.sessionId,
          model,
          ...(usage ? { usage } : {}),
        });
      } catch (error) {
        if (!(error instanceof AdviceParseError)) throw error;
        try {
          const repaired = await this.repairResponse(
            prompt.system,
            prompt.user,
            responseText,
            signal,
          );
          advice = parseAdviceResponse(repaired.text, {
            sessionId: request.sessionId,
            model: repaired.model,
            ...(repaired.usage ? { usage: repaired.usage } : {}),
          });
        } catch (repairError) {
          throw new AdvisorError(
            `Advisor returned an invalid response: ${
              repairError instanceof Error ? repairError.message : String(repairError)
            }`,
            "invalid_response",
          );
        }
      }

      session.updatedAt = now();
      updateFromAdvice(session, request, advice);
      session.turns.push({
        timestamp: session.updatedAt,
        kind: request.kind,
        question: request.question,
        advice,
      });
      session.turns = session.turns.slice(-MAX_STORED_TURNS);
      await this.store.save(session);
      return advice;
    });
  }

  private async requestWithRetry(
    system: string,
    user: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; model: string; usage?: Advice["usage"] }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.provider.complete({
          system,
          user,
          maxOutputTokens: this.config.maxOutputTokens,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        lastError = error;
        if (!(error instanceof ProviderError) || !error.retryable || attempt === 2) {
          throw error;
        }
        await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 250), signal);
      }
    }
    throw lastError;
  }

  private async repairResponse(
    originalSystem: string,
    originalUser: string,
    invalidText: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; model: string; usage?: Advice["usage"] }> {
    const clipped = invalidText.slice(0, 12_000);
    return this.requestWithRetry(
      originalSystem,
      `Your previous answer could not be parsed.\n\nOriginal task:\n${originalUser.slice(
        0,
        40_000,
      )}\n\nPrevious answer:\n${clipped}\n\nReturn the corrected result as one JSON object matching the required schema.`,
      signal,
    );
  }

  async pruneSessions(olderThanMs: number): Promise<number> {
    return this.store.prune ? this.store.prune(olderThanMs) : 0;
  }
}

export function newSessionId(prefix = "session"): string {
  return `${prefix}:${randomUUID()}`;
}
