import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// -----------------------------------------------------------------------------
// Outbound Session Schema & Types
// -----------------------------------------------------------------------------

export const OutboundSessionSchema = z.object({
  /** Unique session identifier */
  outboundSessionId: z.string(),
  /** Internal call ID (links to CallRecord) */
  callId: z.string(),
  /** Practice identifier */
  practiceId: z.string(),
  /** Patient phone number (E.164) */
  patientPhone: z.string(),
  /** Spear number used for outbound (Number B) */
  spearNumber: z.string(),
  /** Shield number for inbound catch-net (Number A) */
  shieldNumber: z.string(),
  /** Epoch ms when session was created */
  createdAt: z.number(),
  /** Epoch ms when session expires (callback window) */
  expiresAt: z.number(),
  /** Optional campaign batch identifier */
  campaignId: z.string().optional(),
  /** Patient name for personalized greeting */
  patientName: z.string().optional(),
  /** Optional context for the Magic Intercept greeting */
  context: z.string().optional(),
});
export type OutboundSession = z.infer<typeof OutboundSessionSchema>;

// Default callback window: 24 hours
const DEFAULT_CALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

export function persistOutboundSession(storePath: string, session: OutboundSession): void {
  const logPath = path.join(storePath, "outbound-sessions.jsonl");
  const line = `${JSON.stringify(session)}\n`;
  fsp.appendFile(logPath, line).catch((err) => {
    console.error("[voice-call] Failed to persist outbound session:", err);
  });
}

export function loadOutboundSessions(storePath: string): OutboundSession[] {
  const logPath = path.join(storePath, "outbound-sessions.jsonl");
  if (!fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, "utf-8");
  const sessions: OutboundSession[] = [];
  const now = Date.now();

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const session = OutboundSessionSchema.parse(JSON.parse(line));
      // Prune expired sessions on load — only keep active callback windows
      if (session.expiresAt >= now) {
        sessions.push(session);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return sessions;
}

// -----------------------------------------------------------------------------
// JSONL Compaction
// -----------------------------------------------------------------------------

/**
 * Compact the outbound sessions JSONL file by removing expired entries.
 * Call this periodically (e.g., daily) to prevent unbounded file growth.
 */
export async function compactOutboundSessions(storePath: string): Promise<number> {
  const logPath = path.join(storePath, "outbound-sessions.jsonl");
  if (!fs.existsSync(logPath)) {
    return 0;
  }

  const activeSessions = loadOutboundSessions(storePath);
  const beforeCount = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean).length;

  // Rewrite file with only active sessions
  const lines = activeSessions.map((s) => JSON.stringify(s)).join("\n") + "\n";
  await fsp.writeFile(logPath, lines, "utf-8");

  const afterCount = activeSessions.length;
  console.log(
    `[voice-call] Compacted outbound sessions: ${beforeCount} → ${afterCount} (removed ${beforeCount - afterCount})`,
  );

  return beforeCount - afterCount;
}

// -----------------------------------------------------------------------------
// Session Creation
// -----------------------------------------------------------------------------

export function createOutboundSession(params: {
  callId: string;
  practiceId: string;
  patientPhone: string;
  spearNumber: string;
  shieldNumber: string;
  campaignId?: string;
  patientName?: string;
  context?: string;
  callbackWindowMs?: number;
}): OutboundSession {
  const now = Date.now();
  return {
    outboundSessionId: crypto.randomUUID(),
    callId: params.callId,
    practiceId: params.practiceId,
    patientPhone: params.patientPhone,
    spearNumber: params.spearNumber,
    shieldNumber: params.shieldNumber,
    createdAt: now,
    expiresAt: now + (params.callbackWindowMs ?? DEFAULT_CALLBACK_WINDOW_MS),
    campaignId: params.campaignId,
    patientName: params.patientName,
    context: params.context,
  };
}

// -----------------------------------------------------------------------------
// Magic Intercept: resolvePartnerFromNumber
// -----------------------------------------------------------------------------

/**
 * Stateless lookup: given an inbound caller's phone number and the number they
 * called, find a matching outbound session that hasn't expired.
 *
 * Pure function — receives sessions as explicit input (no file I/O).
 */
export function resolvePartnerFromNumber(
  callerPhone: string,
  calledNumber: string,
  sessions: OutboundSession[],
  now: number = Date.now(),
): {
  practiceId: string;
  campaignId?: string;
  patientName?: string;
  context?: string;
  spearNumber: string;
  shieldNumber: string;
  ttlRemainingMs: number;
} | null {
  // Walk backwards (most recent first) for efficiency
  for (let i = sessions.length - 1; i >= 0; i--) {
    const session = sessions[i]!;

    // Match: caller was the patient we dialed, AND they're calling back
    // on either the spear (Number B) or shield (Number A) number
    if (session.expiresAt < now) continue;
    if (session.patientPhone !== callerPhone) continue;
    if (session.spearNumber !== calledNumber && session.shieldNumber !== calledNumber) continue;

    return {
      practiceId: session.practiceId,
      campaignId: session.campaignId,
      patientName: session.patientName,
      context: session.context,
      spearNumber: session.spearNumber,
      shieldNumber: session.shieldNumber,
      ttlRemainingMs: session.expiresAt - now,
    };
  }

  return null;
}
