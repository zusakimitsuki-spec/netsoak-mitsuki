import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../server/config';
import { SessionManager, SessionValidationError } from '../server/sessionManager';

describe('SessionManager unit tests', () => {
  it('validates session configuration against Balanced server limits', () => {
    const config = loadServerConfig();
    const mgr = new SessionManager(config);

    const created = mgr.createSession(
      {
        direction: 'bidirectional',
        durationSeconds: 300,
        targetMbps: 100,
        parallelStreams: 2,
      },
      '10.0.0.1'
    );

    expect(created.sessionId).toMatch(/^ns_/);
    expect(created.wsToken.length).toBe(48);
    expect(created.status).toBe('initializing');

    expect(() =>
      mgr.createSession(
        {
          direction: 'invalid',
          durationSeconds: 300,
          targetMbps: 10,
          parallelStreams: 1,
        },
        '10.0.0.1'
      )
    ).toThrow(SessionValidationError);

    expect(() =>
      mgr.createSession(
        {
          direction: 'download',
          durationSeconds: 999999,
          targetMbps: 10,
          parallelStreams: 1,
        },
        '10.0.0.1'
      )
    ).toThrow(SessionValidationError);

    const cappedConfig = { ...config, limits: { ...config.limits, maxBandwidthMbps: 500 } };
    const cappedMgr = new SessionManager(cappedConfig);
    expect(() =>
      cappedMgr.createSession(
        {
          direction: 'download',
          durationSeconds: 60,
          targetMbps: 900, // Exceeds explicit 500 Mbps cap
          parallelStreams: 1,
        },
        '10.0.0.2'
      )
    ).toThrow(SessionValidationError);

    // Default config permits uncapped (0 Mbps) and 6 parallel streams
    const uncapped = mgr.createSession(
      {
        direction: 'bidirectional',
        durationSeconds: 60,
        targetMbps: 0,
        parallelStreams: 6,
      },
      '10.0.0.3'
    );
    expect(uncapped.downloadBucket).toBeNull();
    expect(uncapped.config.parallelStreams).toBe(6);
  });

  it('enforces per-IP active session cap and verifies tokens safely', () => {
    const config = loadServerConfig();
    const mgr = new SessionManager(config);

    const s1 = mgr.createSession(
      { direction: 'download', durationSeconds: 120, targetMbps: 10, parallelStreams: 1 },
      '192.168.1.50'
    );
    mgr.createSession(
      { direction: 'upload', durationSeconds: 120, targetMbps: 10, parallelStreams: 1 },
      '192.168.1.50'
    );

    // 3rd active session from same IP should reject with 429
    expect(() =>
      mgr.createSession(
        { direction: 'download', durationSeconds: 120, targetMbps: 10, parallelStreams: 1 },
        '192.168.1.50'
      )
    ).toThrow(SessionValidationError);

    expect(mgr.verifyToken(s1.sessionId, s1.wsToken)).not.toBeNull();
    expect(mgr.verifyToken(s1.sessionId, 'wrong-token')).toBeNull();

    // Stopping s1 frees a slot
    mgr.stopSession(s1.sessionId, 'stopped');
    const s3 = mgr.createSession(
      { direction: 'download', durationSeconds: 120, targetMbps: 10, parallelStreams: 1 },
      '192.168.1.50'
    );
    expect(s3.sessionId).toMatch(/^ns_/);
  });
});
