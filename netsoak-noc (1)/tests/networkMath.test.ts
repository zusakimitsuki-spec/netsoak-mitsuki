import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_CHUNK,
  MAX_ADAPTIVE_BUFFER_BYTES,
  MIN_ADAPTIVE_BUFFER_BYTES,
  MIN_ADAPTIVE_CHUNK_BYTES,
  TokenBucket,
  calculateGbForRate,
  calculateMbps,
  computeAdaptiveBufferCapBytes,
  computeAdaptiveBurstChunks,
  computeAdaptiveChunkSize,
  downsampleTelemetry,
  escapeCsvField,
  estimateDataUsage,
} from '../shared/networkMath';
import type { TelemetrySample } from '../shared/types';

describe('networkMath unit tests', () => {
  it('calculates Mbps accurately from transferred bytes and elapsed seconds', () => {
    // 12,500,000 bytes in 1 second = 100 Mbps
    expect(calculateMbps(12_500_000, 1)).toBeCloseTo(100, 5);
    // 65,536 bytes in 0.5 seconds = ~1.048576 Mbps
    expect(calculateMbps(BYTES_PER_CHUNK, 0.5)).toBeCloseTo(1.048576, 5);
    expect(calculateMbps(0, 10)).toBe(0);
    expect(calculateMbps(1000, 0)).toBe(0);
  });

  it('estimates data consumption using exact decimal GB formula', () => {
    // 100 Mbps * 3600 seconds = 45 GB
    expect(calculateGbForRate(100, 3600)).toBeCloseTo(45, 5);

    const bi = estimateDataUsage('bidirectional', 3600, 50, 500);
    expect(bi.downloadGb).toBeCloseTo(22.5, 5);
    expect(bi.uploadGb).toBeCloseTo(22.5, 5);
    expect(bi.combinedGb).toBeCloseTo(45, 5);
    expect(bi.isHighVolume).toBe(true);
    expect(bi.isUncapped).toBe(false);

    const dlUncapped = estimateDataUsage('download', 60, 0, 500);
    expect(dlUncapped.isUncapped).toBe(true);
    expect(dlUncapped.downloadGb).toBeCloseTo(3.75, 5);
    expect(dlUncapped.uploadGb).toBe(0);
  });

  it('enforces token-bucket throughput rate limiting over monotonic time without decay', () => {
    // 10 Mbps = 1,250,000 bytes/sec
    let nowMs = 1000;
    const bucket = new TokenBucket(10, nowMs, 0.25);

    let consumedBytes = 0;
    // Simulate 2 seconds in 20ms steps
    for (let step = 0; step < 100; step++) {
      nowMs += 20;
      while (bucket.tryConsume(BYTES_PER_CHUNK, nowMs)) {
        consumedBytes += BYTES_PER_CHUNK;
      }
    }

    const measuredMbps = calculateMbps(consumedBytes, 2);
    expect(measuredMbps).toBeGreaterThan(8.5);
    expect(measuredMbps).toBeLessThan(12.0);

    // Verify 20 Mbps sustained pacing across 10 seconds stays tightly locked near 20 Mbps
    let t = 5000;
    const steadyBucket = new TokenBucket(20, t, 1.0);
    const chunk = computeAdaptiveChunkSize(20);
    let firstSecBytes = 0;
    let lastSecBytes = 0;
    for (let step = 0; step < 1000; step++) {
      t += 10;
      while (steadyBucket.tryConsume(chunk, t)) {
        if (step < 100) firstSecBytes += chunk;
        if (step >= 900) lastSecBytes += chunk;
      }
    }
    const firstSecMbps = calculateMbps(firstSecBytes, 1);
    const lastSecMbps = calculateMbps(lastSecBytes, 1);
    expect(firstSecMbps).toBeGreaterThan(19.0);
    expect(firstSecMbps).toBeLessThan(21.5);
    expect(lastSecMbps).toBeGreaterThan(19.5);
    expect(lastSecMbps).toBeLessThan(20.5);
  });

  it('scales chunk sizes and BDP buffer caps smoothly from 20 Mbps to Gigabit+', () => {
    expect(computeAdaptiveChunkSize(20)).toBe(MIN_ADAPTIVE_CHUNK_BYTES);
    expect(computeAdaptiveChunkSize(1000)).toBe(BYTES_PER_CHUNK);

    const cap20 = computeAdaptiveBufferCapBytes(20, 6, 1.0);
    expect(cap20).toBe(MIN_ADAPTIVE_BUFFER_BYTES);
    expect(computeAdaptiveBurstChunks(cap20, MIN_ADAPTIVE_CHUNK_BYTES)).toBeLessThanOrEqual(4);

    const cap20Inflated = computeAdaptiveBufferCapBytes(20, 6, 1.8);
    expect(cap20Inflated).toBe(BYTES_PER_CHUNK);

    const capGig = computeAdaptiveBufferCapBytes(2500, 6, 1.0);
    expect(capGig).toBe(MAX_ADAPTIVE_BUFFER_BYTES);
    expect(computeAdaptiveBurstChunks(capGig, BYTES_PER_CHUNK)).toBe(32);
  });

  it('downsamples long sessions while preserving null outage gaps', () => {
    const samples: TelemetrySample[] = [];
    for (let i = 0; i < 1000; i++) {
      samples.push({
        session_id: 'ns_test',
        timestamp: 1_700_000_000_000 + i * 1000,
        elapsed_seconds: i,
        download_mbps: i >= 500 && i < 520 ? null : 50 + (i % 10),
        upload_mbps: null,
        download_bytes: i * 1000,
        upload_bytes: 0,
        status: i >= 500 && i < 520 ? 'reconnecting' : 'running',
        connection_state: i >= 500 && i < 520 ? 'reconnecting' : 'connected',
        active_streams: i >= 500 && i < 520 ? 0 : 2,
      });
    }

    const downsampled = downsampleTelemetry(samples, 100);
    expect(downsampled.length).toBe(100);
    const hasOutageBucket = downsampled.some((s) => s.download_mbps === null);
    expect(hasOutageBucket).toBe(true);
  });

  it('properly escapes RFC-4180 CSV fields', () => {
    expect(escapeCsvField('plain')).toBe('plain');
    expect(escapeCsvField('with,comma')).toBe('"with,comma"');
    expect(escapeCsvField('quote"here')).toBe('"quote""here"');
    expect(escapeCsvField(null)).toBe('');
  });
});
