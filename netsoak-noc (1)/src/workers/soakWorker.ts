import {
  BYTES_PER_CHUNK,
  TokenBucket,
  calculateMbps,
  computeAdaptiveBufferCapBytes,
  computeAdaptiveBurstChunks,
  computeAdaptiveChunkSize,
} from '../../shared/networkMath';
import type {
  AppSettings,
  ConnectionState,
  EventSeverity,
  LiveMetricsSnapshot,
  SessionStatus,
  TelemetrySample,
  TestConfig,
} from '../../shared/types';

export type WorkerInboundMessage =
  | {
      type: 'START';
      payload: {
        sessionId: string;
        wsToken: string;
        wsBaseUrl: string;
        config: TestConfig;
        settings: AppSettings;
        initialActiveSeconds?: number;
        initialDownloadBytes?: number;
        initialUploadBytes?: number;
      };
    }
  | { type: 'STOP'; reason?: 'stopped' | 'completed' }
  | { type: 'UPDATE_SETTINGS'; settings: AppSettings }
  | { type: 'VISIBILITY_CHANGE'; hidden: boolean; keepAliveActive?: boolean };

export type WorkerOutboundMessage =
  | { type: 'METRICS'; metrics: LiveMetricsSnapshot }
  | { type: 'SAMPLE'; sample: TelemetrySample }
  | {
      type: 'EVENT';
      event: {
        session_id: string;
        timestamp: number;
        severity: EventSeverity;
        code: string;
        message: string;
      };
    }
  | { type: 'FINISHED'; metrics: LiveMetricsSnapshot; reason: 'completed' | 'stopped' | 'error' };

// Reusable 64 KB incompressible random payload buffer
const UPLOAD_PAYLOAD_BUFFER = new Uint8Array(BYTES_PER_CHUNK);
crypto.getRandomValues(UPLOAD_PAYLOAD_BUFFER);

interface StreamSocketState {
  index: number;
  ws: WebSocket | null;
  connected: boolean;
  lastBufferedBytes: number;
  uploadPumpTimer: ReturnType<typeof setTimeout> | null;
  uploadPumpQueuedImmediate: boolean;
}

class WorkerSoakEngine {
  private sessionId = '';
  private wsToken = '';
  private wsBaseUrl = '';
  private config: TestConfig | null = null;
  private settings: AppSettings | null = null;

  private status: SessionStatus = 'initializing';
  private connectionState: ConnectionState = 'connecting';
  private streams: StreamSocketState[] = [];

  private wallStartedAt = 0;
  private activeTestingMs = 0;
  private outageMs = 0;
  private lastTickMono = 0;
  private lastSampleMono = 0;
  private currentOutageStartMs: number | null = null;

  private disconnectCount = 0;
  private reconnectAttempts = 0;
  private currentBackoffMs = 5000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private metricTimer: ReturnType<typeof setInterval> | null = null;
  private uploadWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pumpChannel: MessageChannel | null = null;

  // Byte counters
  private totalDownloadBytes = 0;
  private intervalDownloadBytes = 0;
  private totalUploadQueuedWireBytes = 0;
  private intervalUploadWireBytes = 0;
  private serverReportedUploadBytes = 0;

  // Adaptive BDP & RTT pacing state
  private observedUploadMbps = 0;
  private lastUlRateSampleAt = 0;
  private lastUlRateSampleBytes = 0;
  private baselineRttMs: number | null = null;
  private rttInflationFactor = 1.0;
  private lastReportedInflation = 1.0;

  // Stats accumulators
  private dlAvgSum = 0;
  private dlSampleCount = 0;
  private dlMin: number | null = null;
  private dlMax = 0;
  private currentDlMbps = 0;
  private lastSteadyDlMbps = 0;

  private ulAvgSum = 0;
  private ulSampleCount = 0;
  private ulMin: number | null = null;
  private ulMax = 0;
  private currentUlMbps = 0;
  private lastSteadyUlMbps = 0;

  private targetReachedLogged = false;
  private uploadBucket: TokenBucket | null = null;
  private stopping = false;

  public handleMessage(msg: WorkerInboundMessage): void {
    switch (msg.type) {
      case 'START':
        this.start(msg.payload);
        break;
      case 'STOP':
        this.stop(msg.reason || 'stopped');
        break;
      case 'UPDATE_SETTINGS':
        this.settings = msg.settings;
        break;
      case 'VISIBILITY_CHANGE':
        if (this.sessionId && (this.status === 'running' || this.status === 'reconnecting')) {
          if (msg.hidden) {
            this.emitEvent(
              msg.keepAliveActive ? 'info' : 'warning',
              'TAB_HIDDEN',
              msg.keepAliveActive
                ? 'Tab moved to background. Background Priority Keep-Alive and Web Worker remain active.'
                : 'Browser tab entered background without Background Keep-Alive; OS or browser timer throttling may reduce throughput.'
            );
          } else {
            this.emitEvent('info', 'TAB_VISIBLE', 'Browser tab returned to foreground.');
          }
        }
        break;
    }
  }

  private emitEvent(severity: EventSeverity, code: string, message: string): void {
    const out: WorkerOutboundMessage = {
      type: 'EVENT',
      event: {
        session_id: this.sessionId,
        timestamp: Date.now(),
        severity,
        code,
        message,
      },
    };
    self.postMessage(out);
  }

  private start(payload: Extract<WorkerInboundMessage, { type: 'START' }>['payload']): void {
    this.cleanupInternal();
    this.stopping = false;
    this.sessionId = payload.sessionId;
    this.wsToken = payload.wsToken;
    this.wsBaseUrl = payload.wsBaseUrl;
    this.config = payload.config;
    this.settings = payload.settings;

    this.status = 'initializing';
    this.connectionState = 'connecting';
    this.wallStartedAt = Date.now();
    this.activeTestingMs = (payload.initialActiveSeconds || 0) * 1000;
    this.outageMs = 0;
    this.lastTickMono = performance.now();
    this.lastSampleMono = this.lastTickMono;
    this.currentOutageStartMs = null;

    this.disconnectCount = 0;
    this.reconnectAttempts = 0;
    this.currentBackoffMs = Math.max(1000, (payload.settings.initialReconnectDelaySeconds || 5) * 1000);

    this.totalDownloadBytes = payload.initialDownloadBytes || 0;
    this.intervalDownloadBytes = 0;
    this.totalUploadQueuedWireBytes = payload.initialUploadBytes || 0;
    this.intervalUploadWireBytes = 0;
    this.serverReportedUploadBytes = payload.initialUploadBytes || 0;

    this.observedUploadMbps = 0;
    this.lastUlRateSampleAt = performance.now();
    this.lastUlRateSampleBytes = this.totalUploadQueuedWireBytes;
    this.baselineRttMs = null;
    this.rttInflationFactor = 1.0;
    this.lastReportedInflation = 1.0;

    this.dlAvgSum = 0;
    this.dlSampleCount = 0;
    this.dlMin = null;
    this.dlMax = 0;
    this.currentDlMbps = 0;
    this.lastSteadyDlMbps = 0;

    this.ulAvgSum = 0;
    this.ulSampleCount = 0;
    this.ulMin = null;
    this.ulMax = 0;
    this.currentUlMbps = 0;
    this.lastSteadyUlMbps = 0;
    this.targetReachedLogged = false;

    const effectiveUploadRate = payload.config.targetMbps > 0 ? payload.config.targetMbps : 0;
    this.uploadBucket =
      effectiveUploadRate > 0 ? new TokenBucket(effectiveUploadRate, performance.now(), 1.0) : null;

    this.emitEvent(
      'info',
      'TEST_INITIALIZED',
      `Test initialized (${payload.config.direction}, ${payload.config.parallelStreams} stream${payload.config.parallelStreams > 1 ? 's' : ''}, ${payload.config.targetMbps === 0 ? 'Uncapped' : `${payload.config.targetMbps} Mbps target`}).`
    );

    this.pumpChannel = new MessageChannel();
    this.pumpChannel.port1.onmessage = (evt: MessageEvent<number>) => {
      const idx = evt.data;
      const stream = this.streams.find((s) => s.index === idx);
      if (stream) {
        stream.uploadPumpQueuedImmediate = false;
        this.pumpUpload(stream);
      }
    };

    this.openStreams();

    this.metricTimer = setInterval(() => {
      this.onMetricTick();
    }, 1000);

    // Lightweight 500ms RTT probe detects bufferbloat early before TCP tail-drop reduces throughput
    this.pingTimer = setInterval(() => {
      if (this.stopping || this.status !== 'running') return;
      const firstOpen = this.streams.find((s) => s.connected && s.ws && s.ws.readyState === WebSocket.OPEN);
      if (firstOpen?.ws) {
        try {
          firstOpen.ws.send(JSON.stringify({ type: 'ping', ts: performance.now() }));
        } catch {
          // ignore probe send error
        }
      }
    }, 500);

    // Watchdog ensures upload streams never stall if a background timer is delayed
    if (payload.config.direction === 'upload' || payload.config.direction === 'bidirectional') {
      this.uploadWatchdogTimer = setInterval(() => {
        if (this.stopping || this.status !== 'running') return;
        const cap = this.getCurrentUploadBufferCap();
        for (const stream of this.streams) {
          if (
            stream.connected &&
            stream.ws &&
            stream.ws.readyState === WebSocket.OPEN &&
            !stream.uploadPumpQueuedImmediate &&
            !stream.uploadPumpTimer &&
            stream.ws.bufferedAmount < cap
          ) {
            this.scheduleUploadPump(stream, 0);
          }
        }
      }, 15);
    }
  }

  private openStreams(): void {
    if (!this.config || this.stopping) return;

    this.streams = [];
    for (let i = 1; i <= this.config.parallelStreams; i++) {
      const streamState: StreamSocketState = {
        index: i,
        ws: null,
        connected: false,
        lastBufferedBytes: 0,
        uploadPumpTimer: null,
        uploadPumpQueuedImmediate: false,
      };
      this.streams.push(streamState);
      this.connectSingleStream(streamState);
    }
  }

  private connectSingleStream(stream: StreamSocketState): void {
    if (!this.config || this.stopping) return;

    const url = `${this.wsBaseUrl}/ws?sessionId=${encodeURIComponent(this.sessionId)}&token=${encodeURIComponent(this.wsToken)}&stream=${stream.index}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    stream.ws = ws;
    stream.lastBufferedBytes = 0;

    ws.onopen = () => {
      if (this.stopping || !this.config) {
        ws.close(1000, 'Stopped');
        return;
      }

      stream.connected = true;
      const connectedCount = this.getActiveStreamCount();

      if (this.connectionState === 'reconnecting') {
        if (this.currentOutageStartMs !== null) {
          const outageDelta = Date.now() - this.currentOutageStartMs;
          this.outageMs += Math.max(0, outageDelta);
          this.currentOutageStartMs = null;
        }
        this.currentBackoffMs = Math.max(
          1000,
          ((this.settings?.initialReconnectDelaySeconds ?? 5) * 1000)
        );
        this.lastTickMono = performance.now();
        this.lastSampleMono = this.lastTickMono;
        this.emitEvent(
          'success',
          'RECONNECT_SUCCESS',
          `Reconnection successful on stream #${stream.index}. Resuming ${this.config.direction} test.`
        );
      } else if (connectedCount === 1 && this.status === 'initializing') {
        this.lastTickMono = performance.now();
        this.lastSampleMono = this.lastTickMono;
        this.emitEvent('success', 'WS_CONNECTED', 'WebSocket connected. Starting network soak streams.');
        if (this.config.direction === 'download' || this.config.direction === 'bidirectional') {
          this.emitEvent('info', 'DOWNLOAD_STARTED', 'Download binary stream started.');
        }
        if (this.config.direction === 'upload' || this.config.direction === 'bidirectional') {
          this.emitEvent('info', 'UPLOAD_STARTED', 'Upload binary stream started.');
        }
      }

      this.status = 'running';
      this.connectionState = 'connected';

      if (this.config.direction === 'upload' || this.config.direction === 'bidirectional') {
        this.scheduleUploadPump(stream, 0);
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.stopping) return;

      if (event.data instanceof ArrayBuffer) {
        const byteLen = event.data.byteLength;
        this.totalDownloadBytes += byteLen;
        this.intervalDownloadBytes += byteLen;
        // Reference is immediately discarded after accounting
        return;
      }

      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as {
            type?: string;
            ts?: number;
            status?: SessionStatus;
            activeSeconds?: number;
            remainingSeconds?: number;
            serverUploadBytes?: number;
          };
          if (msg.type === 'pong' && typeof msg.ts === 'number') {
            const rttMs = Math.max(0.5, performance.now() - msg.ts);
            if (this.baselineRttMs === null) {
              this.baselineRttMs = rttMs;
            } else {
              this.baselineRttMs = Math.min(this.baselineRttMs * 1.005, rttMs);
            }
            const inflationThreshold = Math.max(this.baselineRttMs * 1.8, this.baselineRttMs + 45);
            if (rttMs > inflationThreshold) {
              this.rttInflationFactor = Math.min(2.2, this.rttInflationFactor + 0.25);
            } else {
              this.rttInflationFactor = Math.max(1.0, this.rttInflationFactor - 0.1);
            }
            if (
              Math.abs(this.rttInflationFactor - this.lastReportedInflation) >= 0.15 &&
              ws.readyState === WebSocket.OPEN
            ) {
              this.lastReportedInflation = this.rttInflationFactor;
              ws.send(JSON.stringify({ type: 'rtt_feedback', inflationFactor: this.rttInflationFactor }));
            }
          } else if (msg.type === 'server_stats') {
            if (typeof msg.serverUploadBytes === 'number') {
              this.serverReportedUploadBytes = Math.max(
                this.serverReportedUploadBytes,
                msg.serverUploadBytes
              );
            }
            if (msg.status === 'completed' && !this.stopping) {
              this.stop('completed');
            }
          }
        } catch {
          // Ignore malformed control payload
        }
      }
    };

    ws.onerror = () => {
      // Close handler manages state transitions and reconnection
    };

    ws.onclose = (closeEvent: CloseEvent) => {
      if (stream.uploadPumpTimer) {
        clearTimeout(stream.uploadPumpTimer);
        stream.uploadPumpTimer = null;
      }
      stream.connected = false;
      stream.ws = null;

      if (this.stopping) return;

      // Normal completion or explicit server rejection (401/409/410)
      if (closeEvent.code === 1000 && closeEvent.reason === 'Test completed') {
        this.stop('completed');
        return;
      }
      if (closeEvent.code === 1008 || closeEvent.code === 1003) {
        this.emitEvent('error', 'SESSION_REJECTED', `Session terminated by server (${closeEvent.reason || closeEvent.code}).`);
        this.stop('error');
        return;
      }

      // Check if all streams have disconnected
      if (this.getActiveStreamCount() === 0 && this.status !== 'reconnecting') {
        this.handleNetworkDrop();
      }
    };
  }

  private scheduleUploadPump(stream: StreamSocketState, delayMs: number): void {
    if (this.stopping || !stream.connected || !stream.ws) return;
    if (delayMs <= 0) {
      if (stream.uploadPumpQueuedImmediate) return;
      if (stream.uploadPumpTimer) {
        clearTimeout(stream.uploadPumpTimer);
        stream.uploadPumpTimer = null;
      }
      if (this.pumpChannel) {
        stream.uploadPumpQueuedImmediate = true;
        this.pumpChannel.port2.postMessage(stream.index);
        return;
      }
    }
    if (stream.uploadPumpTimer || stream.uploadPumpQueuedImmediate) return;
    stream.uploadPumpTimer = setTimeout(() => {
      stream.uploadPumpTimer = null;
      this.pumpUpload(stream);
    }, Math.max(1, delayMs));
  }

  private getCurrentUploadBufferCap(): number {
    const pacingMbps =
      this.config && this.config.targetMbps > 0 ? this.config.targetMbps : this.observedUploadMbps;
    return computeAdaptiveBufferCapBytes(
      pacingMbps,
      Math.max(1, this.getActiveStreamCount()),
      this.rttInflationFactor
    );
  }

  private pumpUpload(stream: StreamSocketState): void {
    if (this.stopping || !this.config || !stream.ws || stream.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const ws = stream.ws;
    // Account for flushed bytes since last pump
    const currentBuffered = ws.bufferedAmount;
    if (currentBuffered < stream.lastBufferedBytes) {
      const flushed = stream.lastBufferedBytes - currentBuffered;
      this.intervalUploadWireBytes += flushed;
      this.totalUploadQueuedWireBytes += flushed;
    }
    stream.lastBufferedBytes = currentBuffered;

    const nowMono = performance.now();
    const rateElapsedMs = nowMono - this.lastUlRateSampleAt;
    if (rateElapsedMs >= 250) {
      const bytesDelta = this.totalUploadQueuedWireBytes - this.lastUlRateSampleBytes;
      const instMbps = calculateMbps(bytesDelta, rateElapsedMs / 1000);
      this.observedUploadMbps =
        this.observedUploadMbps === 0 ? instMbps : this.observedUploadMbps * 0.65 + instMbps * 0.35;
      this.lastUlRateSampleAt = nowMono;
      this.lastUlRateSampleBytes = this.totalUploadQueuedWireBytes;
    }

    const pacingMbps = this.config.targetMbps > 0 ? this.config.targetMbps : this.observedUploadMbps;
    const chunkBytes = computeAdaptiveChunkSize(pacingMbps);
    const activeCount = Math.max(1, this.getActiveStreamCount());
    const bufferCapBytes = computeAdaptiveBufferCapBytes(
      pacingMbps,
      activeCount,
      this.rttInflationFactor
    );
    const maxBurst = computeAdaptiveBurstChunks(bufferCapBytes, chunkBytes);

    if (currentBuffered >= bufferCapBytes) {
      this.scheduleUploadPump(stream, 2);
      return;
    }

    const payloadSlice =
      chunkBytes === BYTES_PER_CHUNK
        ? UPLOAD_PAYLOAD_BUFFER
        : UPLOAD_PAYLOAD_BUFFER.subarray(0, chunkBytes);

    let sentInBurst = 0;

    while (
      !this.stopping &&
      ws.readyState === WebSocket.OPEN &&
      ws.bufferedAmount < bufferCapBytes &&
      sentInBurst < maxBurst
    ) {
      const stepMono = performance.now();
      if (this.uploadBucket && !this.uploadBucket.tryConsume(chunkBytes, stepMono)) {
        const rawWait = Math.max(
          1,
          Math.min(25, this.uploadBucket.msUntilAvailable(chunkBytes, stepMono))
        );
        const staggeredWait =
          rawWait > 3 && activeCount > 1 ? rawWait + ((stream.index - 1) % 3) : rawWait;
        this.scheduleUploadPump(stream, staggeredWait);
        return;
      }

      try {
        const prevBuf = ws.bufferedAmount;
        ws.send(payloadSlice);
        const nextBuf = ws.bufferedAmount;
        // Bytes accepted synchronously by kernel/socket without queuing
        const immediateWireBytes = Math.max(0, prevBuf + chunkBytes - nextBuf);
        this.intervalUploadWireBytes += immediateWireBytes;
        this.totalUploadQueuedWireBytes += immediateWireBytes;
        stream.lastBufferedBytes = nextBuf;
        sentInBurst++;
      } catch {
        return;
      }
    }

    if (!this.stopping && ws.readyState === WebSocket.OPEN) {
      this.scheduleUploadPump(stream, ws.bufferedAmount >= bufferCapBytes ? 2 : 0);
    }
  }

  private handleNetworkDrop(): void {
    if (this.stopping || !this.config) return;

    const nowMono = performance.now();
    this.lastTickMono = nowMono;
    this.status = 'reconnecting';
    this.connectionState = 'reconnecting';
    this.disconnectCount += 1;
    this.currentOutageStartMs = Date.now();

    this.emitEvent(
      'error',
      'NETWORK_INTERRUPTION',
      `Network interruption detected (#${this.disconnectCount}). Active timer paused; attempting recovery.`
    );

    this.emitMetricsSnapshot();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || !this.config) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const activeSeconds = this.activeTestingMs / 1000;
    if (activeSeconds >= this.config.durationSeconds) {
      this.stop('completed');
      return;
    }

    const delayMs = this.currentBackoffMs;
    const maxDelayMs = Math.max(5000, (this.settings?.maxReconnectDelaySeconds ?? 60) * 1000);

    this.emitEvent(
      'warning',
      'RECONNECT_SCHEDULED',
      `Scheduling reconnection attempt #${this.reconnectAttempts + 1} in ${(delayMs / 1000).toFixed(0)}s.`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping || !this.config) return;
      this.reconnectAttempts += 1;
      this.currentBackoffMs = Math.min(maxDelayMs, this.currentBackoffMs * 2);

      this.emitEvent(
        'info',
        'RECONNECT_ATTEMPT',
        `Attempting reconnection (#${this.reconnectAttempts}) for session ${this.sessionId}...`
      );

      this.openStreams();
      // If still not connected after 8 seconds, schedule next exponential attempt
      setTimeout(() => {
        if (!this.stopping && this.status === 'reconnecting' && this.getActiveStreamCount() === 0) {
          for (const s of this.streams) {
            try {
              s.ws?.close();
            } catch {
              // ignore
            }
          }
          this.scheduleReconnect();
        }
      }, 8000);
    }, delayMs);
  }

  private getActiveStreamCount(): number {
    let count = 0;
    for (const s of this.streams) {
      if (s.connected && s.ws && s.ws.readyState === WebSocket.OPEN) {
        count++;
      }
    }
    return count;
  }

  private onMetricTick(): void {
    if (!this.config || this.stopping) return;

    const nowMono = performance.now();
    const nowWall = Date.now();
    const tickElapsedSec = Math.max(0.05, (nowMono - this.lastSampleMono) / 1000);
    this.lastSampleMono = nowMono;

    const activeStreams = this.getActiveStreamCount();
    const isActivelyConnected = this.status === 'running' && activeStreams > 0;

    if (isActivelyConnected) {
      const deltaMs = Math.max(0, nowMono - this.lastTickMono);
      this.activeTestingMs += deltaMs;
      this.lastTickMono = nowMono;

      // Flush any remaining bufferedAmount delta on open upload sockets
      for (const stream of this.streams) {
        if (stream.ws && stream.ws.readyState === WebSocket.OPEN) {
          const curBuf = stream.ws.bufferedAmount;
          if (curBuf < stream.lastBufferedBytes) {
            const flushed = stream.lastBufferedBytes - curBuf;
            this.intervalUploadWireBytes += flushed;
            this.totalUploadQueuedWireBytes += flushed;
          }
          stream.lastBufferedBytes = curBuf;
        }
      }

      const supportsDl = this.config.direction === 'download' || this.config.direction === 'bidirectional';
      const supportsUl = this.config.direction === 'upload' || this.config.direction === 'bidirectional';

      if (supportsDl) {
        this.currentDlMbps = calculateMbps(this.intervalDownloadBytes, tickElapsedSec);
        this.dlAvgSum += this.currentDlMbps;
        this.dlSampleCount += 1;
        this.dlMin = this.dlMin === null ? this.currentDlMbps : Math.min(this.dlMin, this.currentDlMbps);
        this.dlMax = Math.max(this.dlMax, this.currentDlMbps);
        this.checkFluctuation('Download', this.currentDlMbps, this.lastSteadyDlMbps);
        if (this.currentDlMbps > 0.5) {
          this.lastSteadyDlMbps =
            this.lastSteadyDlMbps === 0 ? this.currentDlMbps : this.lastSteadyDlMbps * 0.7 + this.currentDlMbps * 0.3;
        }
      } else {
        this.currentDlMbps = 0;
      }

      if (supportsUl) {
        this.currentUlMbps = calculateMbps(this.intervalUploadWireBytes, tickElapsedSec);
        this.ulAvgSum += this.currentUlMbps;
        this.ulSampleCount += 1;
        this.ulMin = this.ulMin === null ? this.currentUlMbps : Math.min(this.ulMin, this.currentUlMbps);
        this.ulMax = Math.max(this.ulMax, this.currentUlMbps);
        this.checkFluctuation('Upload', this.currentUlMbps, this.lastSteadyUlMbps);
        if (this.currentUlMbps > 0.5) {
          this.lastSteadyUlMbps =
            this.lastSteadyUlMbps === 0 ? this.currentUlMbps : this.lastSteadyUlMbps * 0.7 + this.currentUlMbps * 0.3;
        }
      } else {
        this.currentUlMbps = 0;
      }

      // Check target reached milestone
      if (this.config.targetMbps > 0 && !this.targetReachedLogged) {
        const dlReady = !supportsDl || this.currentDlMbps >= this.config.targetMbps * 0.9;
        const ulReady = !supportsUl || this.currentUlMbps >= this.config.targetMbps * 0.9;
        if (dlReady && ulReady) {
          this.targetReachedLogged = true;
          this.emitEvent(
            'success',
            'TARGET_REACHED',
            `Configured target bandwidth (${this.config.targetMbps} Mbps) reached.`
          );
        }
      }

      // Emit real measurement sample (never fake 0 during outage)
      const sample: TelemetrySample = {
        session_id: this.sessionId,
        timestamp: nowWall,
        elapsed_seconds: Math.round(this.activeTestingMs / 1000),
        download_mbps: supportsDl ? Number(this.currentDlMbps.toFixed(2)) : null,
        upload_mbps: supportsUl ? Number(this.currentUlMbps.toFixed(2)) : null,
        download_bytes: this.totalDownloadBytes,
        upload_bytes: Math.max(this.totalUploadQueuedWireBytes, this.serverReportedUploadBytes),
        status: this.status,
        connection_state: this.connectionState,
        active_streams: activeStreams,
      };

      const sampleMsg: WorkerOutboundMessage = { type: 'SAMPLE', sample };
      self.postMessage(sampleMsg);
    }

    this.intervalDownloadBytes = 0;
    this.intervalUploadWireBytes = 0;

    this.emitMetricsSnapshot();

    // Enforce configured duration on active testing time
    if (this.activeTestingMs / 1000 >= this.config.durationSeconds) {
      this.stop('completed');
    }
  }

  private checkFluctuation(label: 'Download' | 'Upload', current: number, baseline: number): void {
    if (baseline < 2 || this.dlSampleCount + this.ulSampleCount < 5) return;
    const threshold = (this.settings?.fluctuationThresholdPercent ?? 35) / 100;
    const dropRatio = (baseline - current) / baseline;
    if (dropRatio >= threshold) {
      this.emitEvent(
        'warning',
        'SPEED_FLUCTUATION',
        `${label} throughput dropped ${(dropRatio * 100).toFixed(0)}% (${current.toFixed(2)} Mbps vs ${baseline.toFixed(2)} Mbps baseline).`
      );
      // Dampen baseline to avoid spamming every second
      if (label === 'Download') this.lastSteadyDlMbps = current;
      else this.lastSteadyUlMbps = current;
    }
  }

  private buildMetricsSnapshot(): LiveMetricsSnapshot {
    const nowWall = Date.now();
    const wallElapsedSeconds = this.wallStartedAt > 0 ? Math.max(0, Math.floor((nowWall - this.wallStartedAt) / 1000)) : 0;
    const activeTestingSeconds = Math.floor(this.activeTestingMs / 1000);
    const currentOutageExtra = this.currentOutageStartMs !== null ? Math.max(0, nowWall - this.currentOutageStartMs) : 0;
    const totalOutageSeconds = Math.floor((this.outageMs + currentOutageExtra) / 1000);
    const remainingSeconds = this.config
      ? Math.max(0, this.config.durationSeconds - activeTestingSeconds)
      : 0;

    const totalAccounted = activeTestingSeconds + totalOutageSeconds;
    const uptimePercent =
      totalAccounted > 0 ? Number(((activeTestingSeconds / totalAccounted) * 100).toFixed(2)) : 100;

    const effectiveUploadBytes = Math.max(this.totalUploadQueuedWireBytes, this.serverReportedUploadBytes);

    return {
      sessionId: this.sessionId,
      status: this.status,
      connectionState: this.connectionState,
      config: this.config!,
      wallStartedAt: this.wallStartedAt,
      wallElapsedSeconds,
      activeTestingSeconds,
      outageSeconds: totalOutageSeconds,
      remainingSeconds,
      activeStreams: this.getActiveStreamCount(),
      disconnectCount: this.disconnectCount,
      reconnectAttempts: this.reconnectAttempts,
      uptimePercent,
      download: {
        currentMbps: Number(this.currentDlMbps.toFixed(2)),
        averageMbps:
          this.dlSampleCount > 0 ? Number((this.dlAvgSum / this.dlSampleCount).toFixed(2)) : 0,
        minMbps: this.dlMin !== null ? Number(this.dlMin.toFixed(2)) : null,
        maxMbps: Number(this.dlMax.toFixed(2)),
        totalBytes: this.totalDownloadBytes,
      },
      upload: {
        currentMbps: Number(this.currentUlMbps.toFixed(2)),
        averageMbps:
          this.ulSampleCount > 0 ? Number((this.ulAvgSum / this.ulSampleCount).toFixed(2)) : 0,
        minMbps: this.ulMin !== null ? Number(this.ulMin.toFixed(2)) : null,
        maxMbps: Number(this.ulMax.toFixed(2)),
        totalBytes: effectiveUploadBytes,
      },
      lastUpdatedAt: nowWall,
    };
  }

  private emitMetricsSnapshot(): void {
    if (!this.config) return;
    const msg: WorkerOutboundMessage = {
      type: 'METRICS',
      metrics: this.buildMetricsSnapshot(),
    };
    self.postMessage(msg);
  }

  private stop(reason: 'completed' | 'stopped' | 'error'): void {
    if (this.stopping) return;
    this.stopping = true;
    this.status = reason;
    this.connectionState = 'closed';

    if (this.currentOutageStartMs !== null) {
      this.outageMs += Math.max(0, Date.now() - this.currentOutageStartMs);
      this.currentOutageStartMs = null;
    }

    this.emitEvent(
      reason === 'completed' ? 'success' : reason === 'error' ? 'error' : 'info',
      reason === 'completed' ? 'TEST_COMPLETED' : reason === 'error' ? 'TEST_ERROR' : 'TEST_STOPPED',
      reason === 'completed'
        ? 'Soak test completed configured duration.'
        : reason === 'error'
          ? 'Soak test terminated due to connection/server error.'
          : 'Test stopped immediately by operator.'
    );

    const finalMetrics = this.buildMetricsSnapshot();
    this.cleanupInternal();

    const finishedMsg: WorkerOutboundMessage = {
      type: 'FINISHED',
      metrics: finalMetrics,
      reason,
    };
    self.postMessage(finishedMsg);
  }

  private cleanupInternal(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.metricTimer) {
      clearInterval(this.metricTimer);
      this.metricTimer = null;
    }
    if (this.uploadWatchdogTimer) {
      clearInterval(this.uploadWatchdogTimer);
      this.uploadWatchdogTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pumpChannel) {
      this.pumpChannel.port1.close();
      this.pumpChannel.port2.close();
      this.pumpChannel = null;
    }
    for (const stream of this.streams) {
      if (stream.uploadPumpTimer) {
        clearTimeout(stream.uploadPumpTimer);
        stream.uploadPumpTimer = null;
      }
      stream.uploadPumpQueuedImmediate = false;
      if (stream.ws) {
        try {
          if (stream.ws.readyState === WebSocket.OPEN || stream.ws.readyState === WebSocket.CONNECTING) {
            stream.ws.close(1000, 'Client terminated');
          }
        } catch {
          // ignore
        }
        stream.ws = null;
      }
    }
    this.streams = [];
  }
}

const engine = new WorkerSoakEngine();

self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  engine.handleMessage(event.data);
};
