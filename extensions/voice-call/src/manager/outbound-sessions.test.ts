import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compactOutboundSessions,
  createOutboundSession,
  loadOutboundSessions,
  persistOutboundSession,
  resolvePartnerFromNumber,
  type OutboundSession,
} from "./outbound-sessions.js";

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `openclaw-voice-outbound-test-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSession(overrides: Partial<OutboundSession> = {}): OutboundSession {
  return createOutboundSession({
    callId: "call-1",
    practiceId: "prac_001",
    patientPhone: "+15551112222",
    spearNumber: "+15559990001",
    shieldNumber: "+15559990002",
    ...overrides,
  });
}

describe("outbound-sessions", () => {
  describe("createOutboundSession", () => {
    it("creates a session with defaults", () => {
      const session = createOutboundSession({
        callId: "call-1",
        practiceId: "prac_001",
        patientPhone: "+15551112222",
        spearNumber: "+15559990001",
        shieldNumber: "+15559990002",
      });

      expect(session.outboundSessionId).toBeTruthy();
      expect(session.callId).toBe("call-1");
      expect(session.practiceId).toBe("prac_001");
      expect(session.patientPhone).toBe("+15551112222");
      expect(session.expiresAt).toBeGreaterThan(session.createdAt);
      // Default 24h window
      expect(session.expiresAt - session.createdAt).toBe(24 * 60 * 60 * 1000);
    });

    it("accepts optional fields", () => {
      const session = createOutboundSession({
        callId: "call-2",
        practiceId: "prac_002",
        patientPhone: "+15553334444",
        spearNumber: "+15559990003",
        shieldNumber: "+15559990004",
        campaignId: "camp_xyz",
        patientName: "John Doe",
        context: "dental exam reminder",
        callbackWindowMs: 2 * 60 * 60 * 1000, // 2 hours
      });

      expect(session.campaignId).toBe("camp_xyz");
      expect(session.patientName).toBe("John Doe");
      expect(session.context).toBe("dental exam reminder");
      expect(session.expiresAt - session.createdAt).toBe(2 * 60 * 60 * 1000);
    });
  });

  describe("persist and load", () => {
    it("round-trips sessions through JSONL", () => {
      const dir = tmpDir();
      const session = makeSession();

      persistOutboundSession(dir, session);

      // persistOutboundSession is fire-and-forget async; give it a tick
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const loaded = loadOutboundSessions(dir);
          expect(loaded).toHaveLength(1);
          expect(loaded[0]!.outboundSessionId).toBe(session.outboundSessionId);
          expect(loaded[0]!.practiceId).toBe("prac_001");
          resolve();
        }, 50);
      });
    });

    it("returns empty array when no file exists", () => {
      const dir = tmpDir();
      const loaded = loadOutboundSessions(dir);
      expect(loaded).toEqual([]);
    });

    it("prunes expired sessions on load", () => {
      const dir = tmpDir();
      const activeSession = makeSession();
      const expiredSession = makeSession({ patientPhone: "+15559999999" });
      expiredSession.expiresAt = Date.now() - 1000; // expired 1 second ago

      persistOutboundSession(dir, activeSession);
      persistOutboundSession(dir, expiredSession);

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const loaded = loadOutboundSessions(dir);
          expect(loaded).toHaveLength(1);
          expect(loaded[0]!.patientPhone).toBe("+15551112222"); // active one only
          resolve();
        }, 50);
      });
    });
  });

  describe("resolvePartnerFromNumber", () => {
    it("matches patient calling back on spear number", () => {
      const session = makeSession();
      const result = resolvePartnerFromNumber(
        "+15551112222", // patient's phone
        "+15559990001", // spear number (B)
        [session],
      );

      expect(result).not.toBeNull();
      expect(result!.practiceId).toBe("prac_001");
      expect(result!.spearNumber).toBe("+15559990001");
    });

    it("matches patient calling back on shield number", () => {
      const session = makeSession();
      const result = resolvePartnerFromNumber(
        "+15551112222", // patient's phone
        "+15559990002", // shield number (A)
        [session],
      );

      expect(result).not.toBeNull();
      expect(result!.practiceId).toBe("prac_001");
      expect(result!.shieldNumber).toBe("+15559990002");
    });

    it("returns null for unknown caller", () => {
      const session = makeSession();
      const result = resolvePartnerFromNumber(
        "+15559999999", // unknown phone
        "+15559990001",
        [session],
      );

      expect(result).toBeNull();
    });

    it("returns null for expired session", () => {
      const session = makeSession();
      // Set expiry in the past
      session.expiresAt = Date.now() - 1000;

      const result = resolvePartnerFromNumber("+15551112222", "+15559990001", [session]);

      expect(result).toBeNull();
    });

    it("returns most recent match when multiple sessions exist", () => {
      const oldSession = makeSession({ patientName: "Old" });
      const newSession = makeSession({ patientName: "New" });

      const result = resolvePartnerFromNumber("+15551112222", "+15559990001", [
        oldSession,
        newSession,
      ]);

      expect(result).not.toBeNull();
      expect(result!.patientName).toBe("New");
    });

    it("includes context and campaign in result", () => {
      const session = makeSession({
        campaignId: "camp_abc",
        patientName: "Jane Smith",
        context: "annual checkup",
      });

      const result = resolvePartnerFromNumber("+15551112222", "+15559990001", [session]);

      expect(result).not.toBeNull();
      expect(result!.campaignId).toBe("camp_abc");
      expect(result!.patientName).toBe("Jane Smith");
      expect(result!.context).toBe("annual checkup");
      expect(result!.ttlRemainingMs).toBeGreaterThan(0);
    });
  });

  describe("compactOutboundSessions", () => {
    it("removes expired sessions from JSONL file", async () => {
      const dir = tmpDir();
      const active1 = makeSession({ patientPhone: "+15551111111" });
      const active2 = makeSession({ patientPhone: "+15552222222" });
      const expired1 = makeSession({ patientPhone: "+15553333333" });
      const expired2 = makeSession({ patientPhone: "+15554444444" });
      expired1.expiresAt = Date.now() - 1000;
      expired2.expiresAt = Date.now() - 2000;

      persistOutboundSession(dir, active1);
      persistOutboundSession(dir, expired1);
      persistOutboundSession(dir, active2);
      persistOutboundSession(dir, expired2);

      // Wait for async persistence
      await new Promise((resolve) => setTimeout(resolve, 100));

      const removed = await compactOutboundSessions(dir);
      expect(removed).toBe(2);

      const loaded = loadOutboundSessions(dir);
      expect(loaded).toHaveLength(2);
      expect(loaded.map((s) => s.patientPhone).sort()).toEqual(["+15551111111", "+15552222222"]);
    });

    it("returns 0 when file does not exist", async () => {
      const dir = tmpDir();
      const removed = await compactOutboundSessions(dir);
      expect(removed).toBe(0);
    });
  });
});
