import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionState, SessionStore } from "./types.js";

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  async get(sessionId: string): Promise<SessionState | undefined> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : undefined;
  }

  async save(session: SessionState): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async delete(sessionId: string): Promise<boolean> {
    return this.sessions.delete(sessionId);
  }

  async prune(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.updatedAt) < cutoff) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

}

export class FileSessionStore implements SessionStore {
  constructor(private readonly directory: string) {}

  private pathFor(sessionId: string): string {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) {
        throw new Error("Invalid session id");
      }
    }
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return join(this.directory, `${digest}.json`);
  }

  async get(sessionId: string): Promise<SessionState | undefined> {
    try {
      const raw = await readFile(this.pathFor(sessionId), "utf8");
      return JSON.parse(raw) as SessionState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(session: SessionState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.pathFor(session.id);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(session, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temp, target);
  }

  async delete(sessionId: string): Promise<boolean> {
    try {
      await unlink(this.pathFor(sessionId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

}
