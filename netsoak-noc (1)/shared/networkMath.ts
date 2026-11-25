import type { DataUsageEstimate, TelemetrySample, TestDirection } from './types';

export const BYTES_PER_CHUNK = 65536; // 64 KB
export const MIN_ADAPTIVE_CHUNK_BYTES = 16384; // 16 KB for smooth low/mid-rate pacing
export const MID_ADAPTIVE_CHUNK_BYTES = 32768; // 32 KB
export const MIN_ADAPTIVE_BUFFER_BYTES = 98304; // 96 KB
export const WARMUP_ADAPTIVE_BUFFER_BYTES = 196608; // 192 KB initial cap before rate stabilizes
export const MAX_ADAPTIVE_BUFFER_BYTES = 4 * 1024 * 1024; // 4 MB max per stream for Gigabit+ links
export const MAX_DURATION_SECONDS = 86400; // 24 hours

/**
 * Selects an optimal WebSocket frame size (<= 64 KB) based on observed or target Mbps.
 * Smaller frames at <= 35 Mbps eliminate coarse microbursts and keep TCP pacing steady.
 */
export function computeAdaptiveChunkSize(effectiveMbps: number): number {
  if (!Number.isFinite(effectiveMbps) || effectiveMbps <= 0) {
    return MID_ADAPTIVE_CHUNK_BYTES;
  }
  if (effectiveMbps <= 35) {
    return MIN_ADAPTIVE_CHUNK_BYTES;
  }
  if (effectiveMbps <= 120) {
    return MID_ADAPTIVE_CHUNK_BYTES;
  }
  return BYTES_PER_CHUNK;
}

/**
 * Computes an adaptive BDP-aware per-socket buffer cap (ws.bufferedAmount watermark).
 * Prevents multi-megabyte bufferbloat queues on 10-50 Mbps links while automatically
 * scaling up to 4 MB per socket on Gigabit+ links.
 */
export function computeAdaptiveBufferCapBytes(
  effectiveMbps: number,
  parallelStreams: number,
  rttInflationFactor = 1
): number {
  const streams = Math.max(1, parallelStreams);
  const inflation = Number.isFinite(rttInflationFactor) ? Math.max(1, rttInflationFactor) : 1;

  if (!Number.isFinite(effectiveMbps) || effectiveMbps <= 0) {
    return Math.max(BYTES_PER_CHUNK, Math.round(WARMUP_ADAPTIVE_BUFFER_BYTES / inflation));
  }

  const totalBytesPerSec = (effectiveMbps * 1_000_000) / 8;
  // Target ~120 ms of queue across all streams divided across concurrent sockets
  const rawPerStream = (totalBytesPerSec * 0.12) / streams / inflation;
  const minCap = inflation > 1.25 ? BYTES_PER_CHUNK : MIN_ADAPTIVE_BUFFER_BYTES;
  return Math.max(minCap, Math.min(MAX_ADAPTIVE_BUFFER_BYTES, Math.round(rawPerStream)));
}

/**
 * Scales synchronous burst chunk count per event-loop slice with the adaptive buffer cap.
 */
export function computeAdaptiveBurstChunks(bufferCapBytes: number, chunkSizeBytes: number): number {
  const safeChunk = Math.max(1, chunkSizeBytes);
  return Math.max(1, Math.min(32, Math.ceil(bufferCapBytes / (2 * safeChunk))));
}

/**
 * Computes application-level WebSocket throughput in Mbps.
 * Formula: Mbps = (Transferred Bytes * 8) / (Elapsed Seconds * 1,000,000)
 */
export function calculateMbps(transferredBytes: number, elapsedSeconds: number): number {
  if (!Number.isFinite(transferredBytes) || !Number.isFinite(elapsedSeconds) || transferredBytes <= 0 || elapsedSeconds <= 0) {
    return 0;
  }
  return (transferredBytes * 8) / (elapsedSeconds * 1_000_000);
}

/**
 * Estimates data transfer volume in Gigabytes (decimal GB: 1 GB = 1,000,000,000 bytes).
 * Formula: Total GB = (Mbps * Seconds * 1,000,000) / (8 * 1,000,000,000)
 */
export function calculateGbForRate(mbps: number, durationSeconds: number): number {
  if (!Number.isFinite(mbps) || !Number.isFinite(durationSeconds) || mbps <= 0 || durationSeconds <= 0) {
    return 0;
  }
  return (mbps * durationSeconds * 1_000_000) / (8 * 1_000_000_000);
}

export function estimateDataUsage(
  direction: TestDirection,
  durationSeconds: number,
  targetMbps: number,
  uncappedReferenceMbps = 500
): DataUsageEstimate {
  const isUncapped = targetMbps === 0;
  const effectiveMbps = isUncapped ? uncappedReferenceMbps : targetMbps;

  const effectiveDownloadMbps =
    direction === 'download' || direction === 'bidirectional' ? effectiveMbps : 0;
  const effectiveUploadMbps =
    direction === 'upload' || direction === 'bidirectional' ? effectiveMbps : 0;

  const downloadGb = calculateGbForRate(effectiveDownloadMbps, durationSeconds);
  const uploadGb = calculateGbForRate(effectiveUploadMbps, durationSeconds);
  const combinedGb = downloadGb + uploadGb;

  return {
    downloadGb,
    uploadGb,
    combinedGb,
    effectiveDownloadMbps,
    effectiveUploadMbps,
    isUncapped,
    isHighVolume: combinedGb >= 25 || (isUncapped && durationSeconds >= 900),
  };
}

/**
 * Token-bucket rate limiter operating in bytes/sec with monotonic clock timestamps (ms).
 * Uses a modest initial token credit to avoid t=0 spikes while preserving a 1.0s credit
 * ceiling so timer jitter never permanently drops sustained throughput below target.
 */
export class TokenBucket {
  private bytesPerSecond: number;
  private capacityBytes: number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    targetMbps: number,
    nowMs: number,
    burstSeconds = 1.0,
    initialTokensBytes = BYTES_PER_CHUNK * 2
  ) {
    this.bytesPerSecond = Math.max(0, (targetMbps * 1_000_000) / 8);
    this.capacityBytes = Math.max(BYTES_PER_CHUNK * 2, this.bytesPerSecond * burstSeconds);
    this.tokens = Math.min(this.capacityBytes, Math.max(BYTES_PER_CHUNK, initialTokensBytes));
    this.lastRefillMs = nowMs;
  }

  public setTargetMbps(targetMbps: number, nowMs: number, burstSeconds = 1.0): void {
    this.refill(nowMs);
    this.bytesPerSecond = Math.max(0, (targetMbps * 1_000_000) / 8);
    this.capacityBytes = Math.max(BYTES_PER_CHUNK * 2, this.bytesPerSecond * burstSeconds);
    if (this.tokens > this.capacityBytes) {
      this.tokens = this.capacityBytes;
    }
  }

  public getTargetMbps(): number {
    return (this.bytesPerSecond * 8) / 1_000_000;
  }

  private refill(nowMs: number): void {
    if (nowMs <= this.lastRefillMs) return;
    const elapsedSec = (nowMs - this.lastRefillMs) / 1000;
    this.lastRefillMs = nowMs;
    if (this.bytesPerSecond <= 0) return;
    this.tokens = Math.min(this.capacityBytes, this.tokens + elapsedSec * this.bytesPerSecond);
  }

  /**
   * Attempts to consume `bytes` tokens. Returns true if allowed, false otherwise.
   */
  public tryConsume(bytes: number, nowMs: number): boolean {
    if (this.bytesPerSecond <= 0) return true;
    this.refill(nowMs);
    if (this.tokens >= bytes) {
      this.tokens -= bytes;
      return true;
    }
    return false;
  }

  /**
   * Returns milliseconds until `bytes` tokens will be available.
   */
  public msUntilAvailable(bytes: number, nowMs: number): number {
    if (this.bytesPerSecond <= 0) return 0;
    this.refill(nowMs);
    if (this.tokens >= bytes) return 0;
    const deficit = bytes - this.tokens;
    return Math.ceil((deficit / this.bytesPerSecond) * 1000);
  }
}

/**
 * Downsamples long time-series sample arrays into at most `maxPoints` buckets
 * while preserving numeric precision and keeping null gaps (disconnections) visible.
 */
export function downsampleTelemetry(
  samples: TelemetrySample[],
  maxPoints = 240
): TelemetrySample[] {
  if (samples.length <= maxPoints || maxPoints <= 2) {
    return samples;
  }

  const bucketSize = samples.length / maxPoints;
  const result: TelemetrySample[] = [];

  for (let i = 0; i < maxPoints; i++) {
    const startIdx = Math.floor(i * bucketSize);
    const endIdx = Math.min(samples.length, Math.floor((i + 1) * bucketSize));
    if (startIdx >= endIdx) continue;

    let dlSum = 0;
    let dlCount = 0;
    let ulSum = 0;
    let ulCount = 0;
    let hasDisconnection = false;
    const representative = samples[endIdx - 1];

    for (let j = startIdx; j < endIdx; j++) {
      const s = samples[j];
      if (s.download_mbps !== null) {
        dlSum += s.download_mbps;
        dlCount++;
      }
      if (s.upload_mbps !== null) {
        ulSum += s.upload_mbps;
        ulCount++;
      }
      if (s.connection_state === 'reconnecting' || s.connection_state === 'disconnected') {
        hasDisconnection = true;
      }
    }

    result.push({
      ...representative,
      download_mbps: dlCount > 0 ? Number((dlSum / dlCount).toFixed(2)) : null,
      upload_mbps: ulCount > 0 ? Number((ulSum / ulCount).toFixed(2)) : null,
      connection_state: hasDisconnection && dlCount === 0 && ulCount === 0 ? 'reconnecting' : representative.connection_state,
    });
  }

  return result;
}

export function formatBytesToGb(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  if (gb >= 100) return `${gb.toFixed(1)} GB`;
  if (gb >= 10) return `${gb.toFixed(2)} GB`;
  if (gb >= 0.01) return `${gb.toFixed(3)} GB`;
  const mb = bytes / 1_000_000;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1_000;
  return `${kb.toFixed(0)} KB`;
}

export function formatMbps(mbps: number | null): string {
  if (mbps === null || !Number.isFinite(mbps)) return '—';
  if (mbps >= 100) return mbps.toFixed(1);
  return mbps.toFixed(2);
}

export function formatDuration(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  return [hrs, mins, secs].map((n) => String(n).padStart(2, '0')).join(':');
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
