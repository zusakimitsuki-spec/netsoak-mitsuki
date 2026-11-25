import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { TokenBucket } from '../shared/networkMath';
import type {
  ServerSessionStatus,
  SessionStatus,
  TestConfig,
  TestDirection,
} from '../shared/types';
import type { ServerConfig } from './config';

export interface SessionRecord {
  sessionId: string;
  wsToken: string;
  clientIp: string;
  config: TestConfig;
  status: SessionStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  expiresAt: number;
  activeSeconds: number;
  lastActivityAt: number;
  serverDownloadBytes: number;
  serverUploadBytes: number;
  observedDownloadMbps: number;
  rttInflationFactor: number;
  lastDlRateSampleAt: number;
  lastDlRateSampleBytes: number;
  sockets: Set<WebSocket>;
  downloadBucket: TokenBucket | null;
}

export class SessionValidationError extends Error {
  public readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const VALID_DIRECTIONS: ReadonlySet<string> = new Set(['download', 'upload', 'bidirectional']);

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly config: ServerConfig;
  private tickInterval: NodeJS.Timeout | null = null;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  public startCleanupLoop(): void {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => {
      this.tick();
    }, 1000);
    if (this.tickInterval.unref) {
      this.tickInterval.unref();
    }
  }

  public stopCleanupLoop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  public validateAndNormalizeConfig(raw: unknown): TestConfig {
    if (!raw || typeof raw !== 'object') {
      throw new SessionValidationError('Request body must be a JSON object.');
    }
    const obj = raw as Record<string, unknown>;
    const direction = obj.direction;
    if (typeof direction !== 'string' || !VALID_DIRECTIONS.has(direction)) {
      throw new SessionValidationError('Invalid test direction. Must be download, upload, or bidirectional.');
    }

    const durationSeconds = Number(obj.durationSeconds);
    if (!Number.isFinite(durationSeconds) || !Number.isInteger(durationSeconds)) {
      throw new SessionValidationError('Duration must be an integer number of seconds.');
    }
    if (durationSeconds < 10 || durationSeconds > this.config.limits.maxDurationSeconds) {
      throw new SessionValidationError(
        `Duration must be between 10 and ${this.config.limits.maxDurationSeconds} seconds.`
      );
    }

    const parallelStreams = Number(obj.parallelStreams);
    if (!Number.isFinite(parallelStreams) || !Number.isInteger(parallelStreams)) {
      throw new SessionValidationError('Parallel streams must be an integer.');
    }
    if (parallelStreams < 1 || parallelStreams > this.config.limits.maxParallelStreams) {
      throw new SessionValidationError(
        `Parallel streams must be between 1 and ${this.config.limits.maxParallelStreams}.`
      );
    }

    const targetMbps = Number(obj.targetMbps);
    if (!Number.isFinite(targetMbps) || targetMbps < 0) {
      throw new SessionValidationError('Target bandwidth must be 0 (uncapped) or a positive number in Mbps.');
    }
    if (this.config.limits.maxBandwidthMbps > 0 && targetMbps > this.config.limits.maxBandwidthMbps) {
      throw new SessionValidationError(
        `Target bandwidth exceeds server safety cap of ${this.config.limits.maxBandwidthMbps} Mbps.`
      );
    }

    return {
      direction: direction as TestDirection,
      durationSeconds,
      targetMbps: Math.round(targetMbps * 100) / 100,
      parallelStreams,
    };
  }

  public createSession(rawConfig: unknown, clientIp: string): SessionRecord {
    const testConfig = this.validateAndNormalizeConfig(rawConfig);

    // Count active sessions for this client IP
    let activeForIp = 0;
    for (const s of this.sessions.values()) {
      if (
        s.clientIp === clientIp &&
        (s.status === 'initializing' || s.status === 'running' || s.status === 'paused' || s.status === 'reconnecting')
      ) {
        activeForIp++;
      }
    }

    if (activeForIp >= this.config.limits.maxActiveSessionsPerClient) {
      throw new SessionValidationError(
        `Maximum concurrent active sessions (${this.config.limits.maxActiveSessionsPerClient}) reached for this client.`,
        429
      );
    }

    const now = Date.now();
    const sessionId = `ns_${crypto.randomBytes(8).toString('hex')}`;
    const wsToken = crypto.randomBytes(24).toString('hex');

    // Determine effective download token-bucket rate:
    // If targetMbps > 0, pace to targetMbps.
    // If targetMbps === 0 (uncapped) and server has maxBandwidthMbps > 0, enforce server cap.
    const effectiveDownloadCap =
      testConfig.targetMbps > 0
        ? testConfig.targetMbps
        : this.config.limits.maxBandwidthMbps > 0
          ? this.config.limits.maxBandwidthMbps
          : 0;

    const downloadBucket = effectiveDownloadCap > 0 ? new TokenBucket(effectiveDownloadCap, performance.now(), 1.0) : null;

    const record: SessionRecord = {
      sessionId,
      wsToken,
      clientIp,
      config: testConfig,
      status: 'initializing',
      createdAt: now,
      startedAt: null,
      endedAt: null,
      // Give generous wall-clock envelope (duration + 6h reconnect headroom)
      expiresAt: now + (testConfig.durationSeconds + 21600) * 1000,
      activeSeconds: 0,
      lastActivityAt: now,
      serverDownloadBytes: 0,
      serverUploadBytes: 0,
      observedDownloadMbps: 0,
      rttInflationFactor: 1.0,
      lastDlRateSampleAt: performance.now(),
      lastDlRateSampleBytes: 0,
      sockets: new Set(),
      downloadBucket,
    };

    this.sessions.set(sessionId, record);
    return record;
  }

  public getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  public verifyToken(sessionId: string, token: string | undefined | null): SessionRecord | null {
    if (!sessionId || !token) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const expected = Buffer.from(session.wsToken, 'utf8');
    const provided = Buffer.from(token, 'utf8');
    if (expected.length !== provided.length) return null;
    if (!crypto.timingSafeEqual(expected, provided)) return null;
    return session;
  }

  public startSession(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionValidationError('Session not found.', 404);
    }
    if (session.status === 'completed' || session.status === 'stopped' || session.status === 'error') {
      throw new SessionValidationError(`Cannot start session in "${session.status}" state.`, 409);
    }
    const now = Date.now();
    if (!session.startedAt) {
      session.startedAt = now;
    }
    session.status = 'running';
    session.lastActivityAt = now;
    return session;
  }

  public stopSession(sessionId: string, finalStatus: 'stopped' | 'completed' | 'error' = 'stopped'): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionValidationError('Session not found.', 404);
    }
    if (session.status !== 'completed' && session.status !== 'stopped' && session.status !== 'error') {
      session.status = finalStatus;
      session.endedAt = Date.now();
    }
    for (const sock of session.sockets) {
      try {
        if (sock.readyState === sock.OPEN || sock.readyState === sock.CONNECTING) {
          sock.close(1000, finalStatus === 'completed' ? 'Test completed' : 'Test stopped');
        }
      } catch {
        // Ignore close errors
      }
    }
    session.sockets.clear();
    return session;
  }

  public toStatusDto(session: SessionRecord): ServerSessionStatus {
    const remainingSeconds = Math.max(0, session.config.durationSeconds - session.activeSeconds);
    return {
      sessionId: session.sessionId,
      status: session.status,
      config: session.config,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      activeSeconds: session.activeSeconds,
      remainingSeconds,
      serverDownloadBytes: session.serverDownloadBytes,
      serverUploadBytes: session.serverUploadBytes,
      activeStreams: session.sockets.size,
    };
  }

  public getStats(): { activeSessions: number; activeStreams: number } {
    let activeSessions = 0;
    let activeStreams = 0;
    for (const s of this.sessions.values()) {
      if (s.status === 'initializing' || s.status === 'running' || s.status === 'reconnecting' || s.status === 'paused') {
        activeSessions++;
      }
      activeStreams += s.sockets.size;
    }
    return { activeSessions, activeStreams };
  }

  public tick(now = Date.now()): void {
    const maxTransferBytes =
      this.config.limits.maxTransferGb > 0 ? this.config.limits.maxTransferGb * 1_000_000_000 : 0;

    for (const [id, session] of this.sessions.entries()) {
      // Advance activeSeconds only while actively running with >= 1 connected stream
      if (session.status === 'running' && session.sockets.size > 0) {
        session.activeSeconds += 1;
        session.lastActivityAt = now;

        const totalTransferred = session.serverDownloadBytes + session.serverUploadBytes;
        if (session.activeSeconds >= session.config.durationSeconds) {
          this.stopSession(id, 'completed');
          continue;
        }
        if (maxTransferBytes > 0 && totalTransferred >= maxTransferBytes) {
          this.stopSession(id, 'completed');
          continue;
        }
      } else if (session.status === 'initializing') {
        if (now - session.createdAt > this.config.sessionIdleTimeoutMs) {
          this.stopSession(id, 'stopped');
        }
      } else if (session.status === 'reconnecting') {
        if (now - session.lastActivityAt > this.config.sessionReconnectGraceMs || now > session.expiresAt) {
          this.stopSession(id, 'stopped');
        }
      } else if (session.endedAt && now - session.endedAt > 60 * 60 * 1000) {
        // Prune finished session metadata from server memory after 1 hour
        this.sessions.delete(id);
      }
    }
  }

  public closeAll(): void {
    this.stopCleanupLoop();
    for (const id of this.sessions.keys()) {
      this.stopSession(id, 'stopped');
    }
  }
}
