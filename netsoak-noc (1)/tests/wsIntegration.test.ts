import http from 'node:http';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../server/app';
import { loadServerConfig } from '../server/config';
import { SessionManager } from '../server/sessionManager';
import { attachWebSocketEngine } from '../server/wsEngine';
import { BYTES_PER_CHUNK } from '../shared/networkMath';

describe('WebSocket streaming & reconnection integration tests', () => {
  let httpServer: http.Server;
  let sessionManager: SessionManager;
  let baseUrl: string;
  let wsBaseUrl: string;

  beforeAll(async () => {
    const config = loadServerConfig();
    config.limits.maxActiveSessionsPerClient = 10;
    sessionManager = new SessionManager(config);
    sessionManager.startCleanupLoop();

    const app = createApp(sessionManager, config);
    httpServer = http.createServer(app);
    attachWebSocketEngine(httpServer, sessionManager, config);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to resolve test server address');
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
    wsBaseUrl = `ws://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    sessionManager.closeAll();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it('streams binary download payloads and verifies health/status endpoints', async () => {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as { status: string; limits: { maxBandwidthMbps: number } };
    expect(health.status).toBe('ok');
    expect(health.limits.maxBandwidthMbps).toBe(0);

    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        direction: 'download',
        durationSeconds: 30,
        targetMbps: 25,
        parallelStreams: 1,
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { sessionId: string; wsToken: string };

    const startRes = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.wsToken}` },
    });
    expect(startRes.status).toBe(200);

    let receivedBytes = 0;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `${wsBaseUrl}/ws?sessionId=${created.sessionId}&token=${created.wsToken}&stream=1`
      );
      ws.binaryType = 'nodebuffer';

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Timed out waiting for download frames'));
      }, 4000);

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          receivedBytes += (data as Buffer).byteLength;
          if (receivedBytes >= BYTES_PER_CHUNK * 4) {
            clearTimeout(timer);
            ws.close(1000, 'Done');
            resolve();
          }
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(receivedBytes).toBeGreaterThanOrEqual(BYTES_PER_CHUNK * 4);

    const stopRes = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.wsToken}` },
    });
    expect(stopRes.status).toBe(200);
  });

  it('supports upload streaming, reconnection with same session ID, and rejects invalid tokens', async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        direction: 'upload',
        durationSeconds: 60,
        targetMbps: 20,
        parallelStreams: 1,
      }),
    });
    const created = (await createRes.json()) as { sessionId: string; wsToken: string };

    // Verify bad token is rejected on WS upgrade
    await new Promise<void>((resolve) => {
      const badWs = new WebSocket(
        `${wsBaseUrl}/ws?sessionId=${created.sessionId}&token=invalid_token&stream=1`
      );
      badWs.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve();
      });
      badWs.on('error', () => resolve());
    });

    const payload = new Uint8Array(BYTES_PER_CHUNK);
    crypto.randomFillSync(payload);

    // Connect, send 3 chunks, drop connection
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `${wsBaseUrl}/ws?sessionId=${created.sessionId}&token=${created.wsToken}&stream=1`
      );
      ws.on('open', () => {
        ws.send(payload, { binary: true });
        ws.send(payload, { binary: true });
        ws.send(payload, { binary: true });
        setTimeout(() => {
          ws.close();
        }, 80);
      });
      ws.on('close', () => {
        setTimeout(resolve, 25);
      });
      ws.on('error', reject);
    });

    // Session should transition to reconnecting when stream drops
    const midStatusRes = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/status`, {
      headers: { Authorization: `Bearer ${created.wsToken}` },
    });
    const midStatus = (await midStatusRes.json()) as { status: string; serverUploadBytes: number };
    expect(midStatus.status).toBe('reconnecting');
    expect(midStatus.serverUploadBytes).toBe(BYTES_PER_CHUNK * 3);

    // Reconnect using same session ID & token and send 2 more chunks
    await new Promise<void>((resolve, reject) => {
      const ws2 = new WebSocket(
        `${wsBaseUrl}/ws?sessionId=${created.sessionId}&token=${created.wsToken}&stream=1`
      );
      ws2.on('open', () => {
        ws2.send(payload, { binary: true });
        ws2.send(payload, { binary: true });
        setTimeout(() => {
          ws2.close();
          resolve();
        }, 120);
      });
      ws2.on('error', reject);
    });

    const finalStatusRes = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/status`, {
      headers: { Authorization: `Bearer ${created.wsToken}` },
    });
    const finalStatus = (await finalStatusRes.json()) as { serverUploadBytes: number };
    expect(finalStatus.serverUploadBytes).toBe(BYTES_PER_CHUNK * 5);

    await fetch(`${baseUrl}/api/sessions/${created.sessionId}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.wsToken}` },
    });
  });
});
