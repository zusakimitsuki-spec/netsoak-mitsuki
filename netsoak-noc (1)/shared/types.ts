export type TestDirection = 'download' | 'upload' | 'bidirectional';

export type SessionStatus =
  | 'initializing'
  | 'running'
  | 'paused'
  | 'reconnecting'
  | 'completed'
  | 'stopped'
  | 'error';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'closed';

export type EventSeverity = 'info' | 'success' | 'warning' | 'error';

export type NavSection = 'dashboard' | 'new-test' | 'history' | 'reports' | 'settings' | 'about';

export interface TestConfig {
  direction: TestDirection;
  durationSeconds: number;
  targetMbps: number; // 0 = Uncapped mode (bounded by server safety cap)
  parallelStreams: number; // 1 to 6
}

export interface ServerLimits {
  maxDurationSeconds: number;
  maxBandwidthMbps: number; // 0 means truly uncapped; >0 means server safety cap in Mbps
  maxParallelStreams: number;
  maxActiveSessionsPerClient: number;
  maxMessageSizeBytes: number;
  maxTransferGb: number; // 0 means no transfer quota cap
  chunkSizeBytes: number;
}

export interface ServerHealthResponse {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  timestamp: number;
  activeSessions: number;
  activeStreams: number;
  memoryMb: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  limits: ServerLimits;
}

export interface CreateSessionResponse {
  sessionId: string;
  wsToken: string;
  config: TestConfig;
  limits: ServerLimits;
  createdAt: number;
  expiresAt: number;
}

export interface ServerSessionStatus {
  sessionId: string;
  status: SessionStatus;
  config: TestConfig;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  activeSeconds: number;
  remainingSeconds: number;
  serverDownloadBytes: number;
  serverUploadBytes: number;
  activeStreams: number;
}

export interface DirectionStats {
  currentMbps: number;
  averageMbps: number;
  minMbps: number | null;
  maxMbps: number;
  totalBytes: number;
}

export interface LiveMetricsSnapshot {
  sessionId: string;
  status: SessionStatus;
  connectionState: ConnectionState;
  config: TestConfig;
  wallStartedAt: number;
  wallElapsedSeconds: number;
  activeTestingSeconds: number;
  outageSeconds: number;
  remainingSeconds: number;
  activeStreams: number;
  disconnectCount: number;
  reconnectAttempts: number;
  uptimePercent: number;
  download: DirectionStats;
  upload: DirectionStats;
  lastUpdatedAt: number;
}

export interface TelemetrySample {
  id?: number;
  session_id: string;
  timestamp: number;
  elapsed_seconds: number;
  download_mbps: number | null;
  upload_mbps: number | null;
  download_bytes: number;
  upload_bytes: number;
  status: SessionStatus;
  connection_state: ConnectionState;
  active_streams: number;
}

export interface TestEvent {
  id?: number;
  session_id: string;
  timestamp: number;
  severity: EventSeverity;
  code: string;
  message: string;
}

export interface StoredSessionSummary {
  session_id: string;
  ws_token?: string;
  created_at: number;
  started_at: number;
  ended_at: number | null;
  config: TestConfig;
  status: SessionStatus;
  active_seconds: number;
  wall_elapsed_seconds: number;
  outage_seconds: number;
  disconnect_count: number;
  reconnect_attempts: number;
  uptime_percent: number;
  avg_download_mbps: number;
  min_download_mbps: number | null;
  max_download_mbps: number;
  total_download_bytes: number;
  avg_upload_mbps: number;
  min_upload_mbps: number | null;
  max_upload_mbps: number;
  total_upload_bytes: number;
  sample_count: number;
  server_max_bandwidth_mbps: number;
}

export interface AppSettings {
  keepScreenAwakeDefault: boolean;
  backgroundKeepAliveDefault: boolean;
  maxReconnectDelaySeconds: number;
  initialReconnectDelaySeconds: number;
  defaultChartRange: '60s' | 'full';
  fluctuationThresholdPercent: number;
  autoScrollEventLog: boolean;
}

export interface DataUsageEstimate {
  downloadGb: number;
  uploadGb: number;
  combinedGb: number;
  effectiveDownloadMbps: number;
  effectiveUploadMbps: number;
  isUncapped: boolean;
  isHighVolume: boolean;
}
