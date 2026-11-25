import type { ServerLimits } from '../shared/types';
import { BYTES_PER_CHUNK, MAX_DURATION_SECONDS } from '../shared/networkMath';

export interface ServerConfig {
  port: number;
  nodeEnv: string;
  limits: ServerLimits;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  wsUpgradeMaxPerWindow: number;
  sessionIdleTimeoutMs: number;
  sessionReconnectGraceMs: number;
}

function parsePositiveInt(val: string | undefined, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (!val) return fallback;
  const parsed = Number(val);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseNonNegativeInt(val: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (val === undefined || val === '') return fallback;
  const parsed = Number(val);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(max, parsed);
}

export function loadServerConfig(): ServerConfig {
  return {
    port: parsePositiveInt(process.env.PORT, 3000, 1, 65535),
    nodeEnv: process.env.NODE_ENV || 'development',
    limits: {
      maxDurationSeconds: parsePositiveInt(process.env.MAX_DURATION_SECONDS, MAX_DURATION_SECONDS, 60, MAX_DURATION_SECONDS),
      // 0 = uncapped maximum speed; set MAX_BANDWIDTH_MBPS > 0 to enforce a server ceiling
      maxBandwidthMbps: parseNonNegativeInt(process.env.MAX_BANDWIDTH_MBPS, 0, 10000),
      maxParallelStreams: parsePositiveInt(process.env.MAX_PARALLEL_STREAMS, 6, 1, 8),
      maxActiveSessionsPerClient: parsePositiveInt(process.env.MAX_ACTIVE_SESSIONS_PER_CLIENT, 2, 1, 20),
      maxMessageSizeBytes: parsePositiveInt(process.env.MAX_MESSAGE_SIZE_BYTES, 262144, BYTES_PER_CHUNK, 1048576),
      maxTransferGb: parseNonNegativeInt(process.env.MAX_TRANSFER_GB, 0, 100000),
      chunkSizeBytes: BYTES_PER_CHUNK,
    },
    rateLimitWindowMs: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60000, 1000),
    rateLimitMaxRequests: parsePositiveInt(process.env.RATE_LIMIT_MAX_REQUESTS, 120, 10),
    wsUpgradeMaxPerWindow: parsePositiveInt(process.env.WS_UPGRADE_MAX_PER_WINDOW, 48, 4),
    sessionIdleTimeoutMs: parsePositiveInt(process.env.SESSION_IDLE_TIMEOUT_MS, 5 * 60 * 1000, 10000),
    sessionReconnectGraceMs: parsePositiveInt(process.env.SESSION_RECONNECT_GRACE_MS, 15 * 60 * 1000, 30000),
  };
}
