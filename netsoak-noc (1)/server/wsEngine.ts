import crypto from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  BYTES_PER_CHUNK,
  calculateMbps,
  computeAdaptiveBufferCapBytes,
  computeAdaptiveBurstChunks,
  computeAdaptiveChunkSize,
} from '../shared/networkMath';
import type { ServerConfig } from './config';
import type { SessionManager, SessionRecord } from './sessionManager';

// Reusable 64 KB incompressible random payload buffer (never reallocated per frame)
const DOWNLOAD_PAYLOAD_BUFFER = new Uint8Array(BYTES_PER_CHUNK);
crypto.randomFillSync(DOWNLOAD_PAYLOAD_BUFFER);

interface UpgradeRateEntry {
  count: number;
  resetAt: number;
}

export function extractClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

export function attachWebSocketEngine(
  httpServer: HttpServer,
  sessionManager: SessionManager,
  config: ServerConfig
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: config.limits.maxMessageSizeBytes,
  });

  const upgradeRateMap = new Map<string, UpgradeRateEntry>();

  function rejectUpgrade(socket: Duplex, statusCode: number, reason: string): void {
    try {
      socket.write(
        `HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${reason}`
      );
    } catch {
      // Ignore write error
    }
    socket.destroy();
  }

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reqUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (reqUrl.pathname !== '/ws') {
      // Let any non-/ws upgrade close cleanly
      socket.destroy();
      return;
    }

    const clientIp = extractClientIp(request);
    const now = Date.now();
    const rateEntry = upgradeRateMap.get(clientIp);
    if (!rateEntry || now > rateEntry.resetAt) {
      upgradeRateMap.set(clientIp, { count: 1, resetAt: now + config.rateLimitWindowMs });
    } else {
      rateEntry.count += 1;
      if (rateEntry.count > config.wsUpgradeMaxPerWindow) {
        rejectUpgrade(socket, 429, 'Too Many WebSocket Connections');
        return;
      }
    }

    const sessionId = reqUrl.searchParams.get('sessionId') || '';
    const token = reqUrl.searchParams.get('token') || '';
    const streamParam = Number(reqUrl.searchParams.get('stream') || '1');

    const session = sessionManager.verifyToken(sessionId, token);
    if (!session) {
      rejectUpgrade(socket, 401, 'Unauthorized Session');
      return;
    }

    if (session.status === 'completed' || session.status === 'stopped' || session.status === 'error') {
      rejectUpgrade(socket, 409, 'Session Already Ended');
      return;
    }

    if (session.activeSeconds >= session.config.durationSeconds || now > session.expiresAt) {
      sessionManager.stopSession(session.sessionId, 'completed');
      rejectUpgrade(socket, 410, 'Session Expired');
      return;
    }

    if (!Number.isInteger(streamParam) || streamParam < 1 || streamParam > session.config.parallelStreams) {
      rejectUpgrade(socket, 400, 'Invalid Stream Index');
      return;
    }

    if (session.sockets.size >= session.config.parallelStreams) {
      rejectUpgrade(socket, 429, 'Maximum Parallel Streams Active');
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, session, streamParam);
    });
  });

  wss.on(
    'connection',
    (ws: WebSocket, _request: IncomingMessage, session: SessionRecord, streamIndex: number) => {
      ws.binaryType = 'nodebuffer';
      // Disable Nagle's algorithm so paced chunks and control telemetry flush immediately
      const rawSocket = (ws as unknown as { _socket?: { setNoDelay?: (noDelay: boolean) => void } })._socket;
      rawSocket?.setNoDelay?.(true);

      session.sockets.add(ws);
      session.lastActivityAt = Date.now();
      if (!session.startedAt) {
        session.startedAt = Date.now();
      }
      if (session.status === 'initializing' || session.status === 'reconnecting' || session.status === 'paused') {
        session.status = 'running';
      }

      const supportsDownload =
        session.config.direction === 'download' || session.config.direction === 'bidirectional';
      const supportsUpload =
        session.config.direction === 'upload' || session.config.direction === 'bidirectional';

      let pumpTimer: NodeJS.Timeout | null = null;
      let pumpImmediate: NodeJS.Immediate | null = null;
      let statsTimer: NodeJS.Timeout | null = null;
      let closed = false;

      const sendJson = (payload: Record<string, unknown>) => {
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify(payload), { binary: false, compress: false });
        } catch {
          // Ignore send failures during close
        }
      };

      // Initial handshake confirmation
      sendJson({
        type: 'connected',
        sessionId: session.sessionId,
        streamIndex,
        activeSeconds: session.activeSeconds,
        remainingSeconds: Math.max(0, session.config.durationSeconds - session.activeSeconds),
        serverDownloadBytes: session.serverDownloadBytes,
        serverUploadBytes: session.serverUploadBytes,
      });

      const schedulePump = (delayMs = 0) => {
        if (closed || !supportsDownload) return;
        if (pumpTimer || pumpImmediate) return;
        if (delayMs === 0) {
          pumpImmediate = setImmediate(pumpDownload);
        } else {
          pumpTimer = setTimeout(pumpDownload, delayMs);
        }
      };

      const pumpDownload = () => {
        pumpTimer = null;
        pumpImmediate = null;
        if (closed || ws.readyState !== WebSocket.OPEN || session.status !== 'running') {
          return;
        }

        const nowMono = performance.now();
        const rateElapsedMs = nowMono - session.lastDlRateSampleAt;
        if (rateElapsedMs >= 250) {
          const bytesDelta = session.serverDownloadBytes - session.lastDlRateSampleBytes;
          const instMbps = calculateMbps(bytesDelta, rateElapsedMs / 1000);
          session.observedDownloadMbps =
            session.observedDownloadMbps === 0
              ? instMbps
              : session.observedDownloadMbps * 0.65 + instMbps * 0.35;
          session.lastDlRateSampleAt = nowMono;
          session.lastDlRateSampleBytes = session.serverDownloadBytes;
        }

        const pacingMbps =
          session.config.targetMbps > 0 ? session.config.targetMbps : session.observedDownloadMbps;
        const chunkBytes = computeAdaptiveChunkSize(pacingMbps);
        const bufferCapBytes = computeAdaptiveBufferCapBytes(
          pacingMbps,
          Math.max(1, session.sockets.size),
          session.rttInflationFactor
        );
        const maxBurstChunks = computeAdaptiveBurstChunks(bufferCapBytes, chunkBytes);

        // Adaptive BDP backpressure check prevents multi-second bufferbloat on 10-50 Mbps links
        if (ws.bufferedAmount >= bufferCapBytes) {
          schedulePump(2);
          return;
        }

        const payloadSlice =
          chunkBytes === BYTES_PER_CHUNK
            ? DOWNLOAD_PAYLOAD_BUFFER
            : DOWNLOAD_PAYLOAD_BUFFER.subarray(0, chunkBytes);

        let sentInBurst = 0;

        while (
          !closed &&
          ws.readyState === WebSocket.OPEN &&
          session.status === 'running' &&
          ws.bufferedAmount < bufferCapBytes &&
          sentInBurst < maxBurstChunks
        ) {
          const stepMono = performance.now();
          if (session.downloadBucket && !session.downloadBucket.tryConsume(chunkBytes, stepMono)) {
            const rawWait = Math.max(
              1,
              Math.min(25, session.downloadBucket.msUntilAvailable(chunkBytes, stepMono))
            );
            const staggeredWait =
              rawWait > 3 && session.sockets.size > 1
                ? rawWait + ((streamIndex - 1) % 3)
                : rawWait;
            schedulePump(staggeredWait);
            return;
          }

          try {
            ws.send(payloadSlice, { binary: true, compress: false });
            session.serverDownloadBytes += chunkBytes;
            sentInBurst++;
          } catch {
            return;
          }
        }

        if (!closed && ws.readyState === WebSocket.OPEN && session.status === 'running') {
          schedulePump(ws.bufferedAmount >= bufferCapBytes ? 2 : 0);
        }
      };

      if (supportsDownload) {
        schedulePump(0);
      }

      // Send authoritative server telemetry every 1s on stream 1 (or first open stream)
      statsTimer = setInterval(() => {
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        const firstSocket = session.sockets.values().next().value;
        if (firstSocket !== ws) return;
        sendJson({
          type: 'server_stats',
          sessionId: session.sessionId,
          status: session.status,
          activeSeconds: session.activeSeconds,
          remainingSeconds: Math.max(0, session.config.durationSeconds - session.activeSeconds),
          serverDownloadBytes: session.serverDownloadBytes,
          serverUploadBytes: session.serverUploadBytes,
          activeStreams: session.sockets.size,
        });
      }, 1000);

      ws.on('message', (data, isBinary) => {
        session.lastActivityAt = Date.now();
        if (isBinary) {
          if (!supportsUpload || session.status !== 'running') {
            return;
          }
          // Measure received binary bytes and immediately discard reference
          const byteLen = Buffer.isBuffer(data)
            ? data.byteLength
            : Array.isArray(data)
              ? data.reduce((sum, buf) => sum + buf.byteLength, 0)
              : (data as ArrayBuffer).byteLength;
          session.serverUploadBytes += byteLen;
          return;
        }

        // Handle lightweight JSON control messages (ping/pong, rtt_feedback)
        try {
          const text = typeof data === 'string' ? data : data.toString('utf8');
          if (text.length > 2048) return;
          const msg = JSON.parse(text) as { type?: string; ts?: number; inflationFactor?: number };
          if (msg.type === 'ping') {
            sendJson({ type: 'pong', ts: msg.ts, serverTime: Date.now() });
          } else if (
            msg.type === 'rtt_feedback' &&
            typeof msg.inflationFactor === 'number' &&
            Number.isFinite(msg.inflationFactor)
          ) {
            session.rttInflationFactor = Math.max(1.0, Math.min(2.5, msg.inflationFactor));
          }
        } catch {
          // Ignore malformed control frames
        }
      });

      const cleanupSocket = () => {
        if (closed) return;
        closed = true;
        if (pumpTimer) {
          clearTimeout(pumpTimer);
          pumpTimer = null;
        }
        if (pumpImmediate) {
          clearImmediate(pumpImmediate);
          pumpImmediate = null;
        }
        if (statsTimer) {
          clearInterval(statsTimer);
          statsTimer = null;
        }
        session.sockets.delete(ws);
        // Pause active testing time accumulation if all streams dropped mid-test
        if (session.sockets.size === 0 && session.status === 'running') {
          session.status = 'reconnecting';
          session.lastActivityAt = Date.now();
        }
      };

      ws.on('close', cleanupSocket);
      ws.on('error', cleanupSocket);
    }
  );

  return wss;
}
