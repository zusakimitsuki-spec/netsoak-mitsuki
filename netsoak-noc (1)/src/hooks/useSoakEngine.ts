import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  StorageQuotaError,
  addEventsBatch,
  addSamplesBatch,
  buildSessionCsvBlob,
  deleteSessionData,
  getAllSessions,
  getSessionEvents,
  getSessionSamplesDownsampled,
  loadSettings,
  saveSessionSummary,
  saveSettings,
} from '../database/indexedDb';
import {
  createTestSession,
  fetchServerHealth,
  fetchServerSessionStatus,
  getWebSocketBaseUrl,
  startServerSession,
  stopServerSession,
} from '../services/api';
import type { WorkerInboundMessage, WorkerOutboundMessage } from '../workers/soakWorker';
import type {
  AppSettings,
  LiveMetricsSnapshot,
  ServerHealthResponse,
  StoredSessionSummary,
  TelemetrySample,
  TestConfig,
  TestEvent,
} from '../../shared/types';

export interface RecoverableSession {
  summary: StoredSessionSummary;
  remainingSeconds: number;
}

export function useSoakEngine(keepAliveActive = true) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [serverHealth, setServerHealth] = useState<ServerHealthResponse | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const [activeMetrics, setActiveMetrics] = useState<LiveMetricsSnapshot | null>(null);
  const [rollingSamples, setRollingSamples] = useState<TelemetrySample[]>([]);
  const [liveEvents, setLiveEvents] = useState<TestEvent[]>([]);
  const [history, setHistory] = useState<StoredSessionSummary[]>([]);
  const [recoverableSession, setRecoverableSession] = useState<RecoverableSession | null>(null);

  const [quotaWarning, setQuotaWarning] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const activeTokenRef = useRef<string | null>(null);
  const activeSessionMetaRef = useRef<{
    sessionId: string;
    createdAt: number;
    serverMaxBw: number;
    sampleCount: number;
  } | null>(null);

  const pendingSamplesRef = useRef<TelemetrySample[]>([]);
  const pendingEventsRef = useRef<TestEvent[]>([]);
  const lastSummaryFlushRef = useRef<number>(0);

  const refreshHistory = useCallback(async () => {
    try {
      const list = await getAllSessions();
      setHistory(list);
    } catch {
      // Ignore if IndexedDB unavailable
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const health = await fetchServerHealth();
      setServerHealth(health);
      setServerError(null);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Unable to reach NetSoak backend.');
    }
  }, []);

  const flushBatchesToDb = useCallback(async (latestMetrics?: LiveMetricsSnapshot | null) => {
    const samplesToWrite = pendingSamplesRef.current.splice(0, pendingSamplesRef.current.length);
    const eventsToWrite = pendingEventsRef.current.splice(0, pendingEventsRef.current.length);

    try {
      if (samplesToWrite.length > 0) {
        await addSamplesBatch(samplesToWrite);
        if (activeSessionMetaRef.current) {
          activeSessionMetaRef.current.sampleCount += samplesToWrite.length;
        }
      }
      if (eventsToWrite.length > 0) {
        await addEventsBatch(eventsToWrite);
      }

      if (latestMetrics && activeSessionMetaRef.current) {
        const meta = activeSessionMetaRef.current;
        const summary: StoredSessionSummary = {
          session_id: latestMetrics.sessionId,
          ws_token: activeTokenRef.current || undefined,
          created_at: meta.createdAt,
          started_at: latestMetrics.wallStartedAt,
          ended_at:
            latestMetrics.status === 'completed' ||
            latestMetrics.status === 'stopped' ||
            latestMetrics.status === 'error'
              ? Date.now()
              : null,
          config: latestMetrics.config,
          status: latestMetrics.status,
          active_seconds: latestMetrics.activeTestingSeconds,
          wall_elapsed_seconds: latestMetrics.wallElapsedSeconds,
          outage_seconds: latestMetrics.outageSeconds,
          disconnect_count: latestMetrics.disconnectCount,
          reconnect_attempts: latestMetrics.reconnectAttempts,
          uptime_percent: latestMetrics.uptimePercent,
          avg_download_mbps: latestMetrics.download.averageMbps,
          min_download_mbps: latestMetrics.download.minMbps,
          max_download_mbps: latestMetrics.download.maxMbps,
          total_download_bytes: latestMetrics.download.totalBytes,
          avg_upload_mbps: latestMetrics.upload.averageMbps,
          min_upload_mbps: latestMetrics.upload.minMbps,
          max_upload_mbps: latestMetrics.upload.maxMbps,
          total_upload_bytes: latestMetrics.upload.totalBytes,
          sample_count: meta.sampleCount,
          server_max_bandwidth_mbps: meta.serverMaxBw,
        };
        await saveSessionSummary(summary);
        await refreshHistory();
      }
    } catch (err) {
      if (err instanceof StorageQuotaError) {
        setQuotaWarning(
          'Browser IndexedDB storage quota reached. New historical samples cannot be saved until older sessions are cleared.'
        );
      }
    }
  }, [refreshHistory]);

  // Initialize settings, health polling, history, and session recovery check
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [loadedSettings, sessions] = await Promise.all([loadSettings(), getAllSessions()]);
      if (!mounted) return;
      setSettings(loadedSettings);
      setHistory(sessions);

      // Check if an interrupted session can be recovered
      const candidate = sessions.find(
        (s) =>
          (s.status === 'running' || s.status === 'reconnecting' || s.status === 'initializing') &&
          s.ws_token
      );
      if (candidate && candidate.ws_token) {
        try {
          const remoteStatus = await fetchServerSessionStatus(candidate.session_id, candidate.ws_token);
          if (
            mounted &&
            (remoteStatus.status === 'running' ||
              remoteStatus.status === 'reconnecting' ||
              remoteStatus.status === 'initializing') &&
            remoteStatus.remainingSeconds > 5
          ) {
            setRecoverableSession({
              summary: candidate,
              remainingSeconds: remoteStatus.remainingSeconds,
            });
          } else {
            await saveSessionSummary({
              ...candidate,
              status: remoteStatus.status === 'completed' ? 'completed' : 'stopped',
              ended_at: remoteStatus.endedAt || Date.now(),
              ws_token: undefined,
            });
            await refreshHistory();
          }
        } catch {
          // Server restarted or session expired; mark as interrupted/stopped
          await saveSessionSummary({
            ...candidate,
            status: 'stopped',
            ended_at: Date.now(),
            ws_token: undefined,
          });
          await refreshHistory();
        }
      }
    })();

    void refreshHealth();
    const healthTimer = setInterval(() => {
      void refreshHealth();
    }, 10000);

    return () => {
      mounted = false;
      clearInterval(healthTimer);
    };
  }, [refreshHealth, refreshHistory]);

  // Periodic IndexedDB batch flush every 2s while active
  useEffect(() => {
    const flushTimer = setInterval(() => {
      if (pendingSamplesRef.current.length > 0 || pendingEventsRef.current.length > 0) {
        const now = Date.now();
        const shouldSaveSummary = now - lastSummaryFlushRef.current >= 4000;
        if (shouldSaveSummary) lastSummaryFlushRef.current = now;
        void flushBatchesToDb(shouldSaveSummary ? activeMetrics : null);
      }
    }, 2000);
    return () => clearInterval(flushTimer);
  }, [activeMetrics, flushBatchesToDb]);

  // Visibility change forwarding to active worker
  useEffect(() => {
    const onVisibility = () => {
      if (workerRef.current) {
        const msg: WorkerInboundMessage = {
          type: 'VISIBILITY_CHANGE',
          hidden: document.visibilityState === 'hidden',
          keepAliveActive,
        };
        workerRef.current.postMessage(msg);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [keepAliveActive]);

  // Cleanup worker on unmount
  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  const spawnWorkerAndRun = useCallback(
    (params: {
      sessionId: string;
      wsToken: string;
      config: TestConfig;
      createdAt: number;
      serverMaxBw: number;
      initialActiveSeconds?: number;
      initialDownloadBytes?: number;
      initialUploadBytes?: number;
      initialSampleCount?: number;
    }) => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }

      const worker = new Worker(new URL('../workers/soakWorker.ts', import.meta.url), {
        type: 'module',
      });
      workerRef.current = worker;
      activeTokenRef.current = params.wsToken;
      activeSessionMetaRef.current = {
        sessionId: params.sessionId,
        createdAt: params.createdAt,
        serverMaxBw: params.serverMaxBw,
        sampleCount: params.initialSampleCount || 0,
      };

      worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
        const msg = event.data;
        if (msg.type === 'METRICS') {
          setActiveMetrics(msg.metrics);
        } else if (msg.type === 'SAMPLE') {
          pendingSamplesRef.current.push(msg.sample);
          setRollingSamples((prev) => {
            const next = [...prev, msg.sample];
            return next.length > 60 ? next.slice(next.length - 60) : next;
          });
        } else if (msg.type === 'EVENT') {
          const evt: TestEvent = msg.event;
          pendingEventsRef.current.push(evt);
          setLiveEvents((prev) => {
            const next = [...prev, evt];
            return next.length > 250 ? next.slice(next.length - 250) : next;
          });
        } else if (msg.type === 'FINISHED') {
          setActiveMetrics(msg.metrics);
          const token = activeTokenRef.current;
          if (token) {
            void stopServerSession(
              msg.metrics.sessionId,
              token,
              msg.reason === 'completed' ? 'completed' : 'stopped'
            ).catch(() => {});
          }
          void flushBatchesToDb(msg.metrics).then(() => {
            activeTokenRef.current = null;
            return refreshHistory();
          });
          worker.terminate();
          if (workerRef.current === worker) {
            workerRef.current = null;
          }
        }
      };

      const startCmd: WorkerInboundMessage = {
        type: 'START',
        payload: {
          sessionId: params.sessionId,
          wsToken: params.wsToken,
          wsBaseUrl: getWebSocketBaseUrl(),
          config: params.config,
          settings,
          initialActiveSeconds: params.initialActiveSeconds,
          initialDownloadBytes: params.initialDownloadBytes,
          initialUploadBytes: params.initialUploadBytes,
        },
      };
      worker.postMessage(startCmd);
    },
    [flushBatchesToDb, refreshHistory, settings]
  );

  const startNewTest = useCallback(
    async (config: TestConfig): Promise<string> => {
      setIsStarting(true);
      setQuotaWarning(null);
      try {
        const created = await createTestSession(config);
        await startServerSession(created.sessionId, created.wsToken);

        setRollingSamples([]);
        setLiveEvents([]);
        setRecoverableSession(null);

        const initialSummary: StoredSessionSummary = {
          session_id: created.sessionId,
          ws_token: created.wsToken,
          created_at: created.createdAt,
          started_at: Date.now(),
          ended_at: null,
          config: created.config,
          status: 'initializing',
          active_seconds: 0,
          wall_elapsed_seconds: 0,
          outage_seconds: 0,
          disconnect_count: 0,
          reconnect_attempts: 0,
          uptime_percent: 100,
          avg_download_mbps: 0,
          min_download_mbps: null,
          max_download_mbps: 0,
          total_download_bytes: 0,
          avg_upload_mbps: 0,
          min_upload_mbps: null,
          max_upload_mbps: 0,
          total_upload_bytes: 0,
          sample_count: 0,
          server_max_bandwidth_mbps: created.limits.maxBandwidthMbps,
        };
        await saveSessionSummary(initialSummary);

        spawnWorkerAndRun({
          sessionId: created.sessionId,
          wsToken: created.wsToken,
          config: created.config,
          createdAt: created.createdAt,
          serverMaxBw: created.limits.maxBandwidthMbps,
        });

        await refreshHistory();
        return created.sessionId;
      } finally {
        setIsStarting(false);
      }
    },
    [refreshHistory, spawnWorkerAndRun]
  );

  const stopActiveTest = useCallback(async () => {
    if (workerRef.current) {
      const cmd: WorkerInboundMessage = { type: 'STOP', reason: 'stopped' };
      workerRef.current.postMessage(cmd);
    }
    if (activeMetrics && activeTokenRef.current) {
      await stopServerSession(activeMetrics.sessionId, activeTokenRef.current, 'stopped').catch(
        () => {}
      );
    }
  }, [activeMetrics]);

  const resumeRecoveredSession = useCallback(async () => {
    if (!recoverableSession || !recoverableSession.summary.ws_token) return;
    const { summary } = recoverableSession;
    const token = summary.ws_token!;

    try {
      const serverStatus = await fetchServerSessionStatus(summary.session_id, token);
      await startServerSession(summary.session_id, token);

      const prevEvents = await getSessionEvents(summary.session_id);
      const recentSamples = await getSessionSamplesDownsampled(summary.session_id, 60);
      setLiveEvents(prevEvents.slice(-250));
      setRollingSamples(recentSamples);
      setRecoverableSession(null);

      spawnWorkerAndRun({
        sessionId: summary.session_id,
        wsToken: token,
        config: summary.config,
        createdAt: summary.created_at,
        serverMaxBw: summary.server_max_bandwidth_mbps,
        initialActiveSeconds: serverStatus.activeSeconds,
        initialDownloadBytes: Math.max(summary.total_download_bytes, serverStatus.serverDownloadBytes),
        initialUploadBytes: Math.max(summary.total_upload_bytes, serverStatus.serverUploadBytes),
        initialSampleCount: summary.sample_count,
      });
    } catch {
      await saveSessionSummary({
        ...summary,
        status: 'stopped',
        ended_at: Date.now(),
        ws_token: undefined,
      });
      setRecoverableSession(null);
      await refreshHistory();
    }
  }, [recoverableSession, refreshHistory, spawnWorkerAndRun]);

  const dismissRecoveredSession = useCallback(async () => {
    if (!recoverableSession) return;
    const { summary } = recoverableSession;
    if (summary.ws_token) {
      await stopServerSession(summary.session_id, summary.ws_token, 'stopped').catch(() => {});
    }
    await saveSessionSummary({
      ...summary,
      status: 'stopped',
      ended_at: Date.now(),
      ws_token: undefined,
    });
    setRecoverableSession(null);
    await refreshHistory();
  }, [recoverableSession, refreshHistory]);

  const updateAppSettings = useCallback(async (next: AppSettings) => {
    setSettings(next);
    await saveSettings(next);
    if (workerRef.current) {
      const msg: WorkerInboundMessage = { type: 'UPDATE_SETTINGS', settings: next };
      workerRef.current.postMessage(msg);
    }
  }, []);

  const deleteHistorySession = useCallback(
    async (sessionId: string) => {
      await deleteSessionData(sessionId);
      await refreshHistory();
    },
    [refreshHistory]
  );

  const exportSessionCsv = useCallback(async (sessionId: string, createdAt: number) => {
    const { blob } = await buildSessionCsvBlob(sessionId);
    const dateSlug = new Date(createdAt).toISOString().slice(0, 10);
    const filename = `netsoak_${sessionId}_${dateSlug}.csv`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const isRunning =
    activeMetrics?.status === 'running' ||
    activeMetrics?.status === 'initializing' ||
    activeMetrics?.status === 'reconnecting';

  return {
    settings,
    updateAppSettings,
    serverHealth,
    serverError,
    refreshHealth,
    activeMetrics,
    rollingSamples,
    liveEvents,
    history,
    refreshHistory,
    recoverableSession,
    resumeRecoveredSession,
    dismissRecoveredSession,
    quotaWarning,
    isStarting,
    isRunning,
    startNewTest,
    stopActiveTest,
    deleteHistorySession,
    exportSessionCsv,
  };
}
