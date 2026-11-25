import { useEffect, useState } from 'react';
import { RefreshCw, Save, Trash2 } from 'lucide-react';
import { formatBytesToGb, formatDuration } from '../../shared/networkMath';
import type { AppSettings, ServerHealthResponse } from '../../shared/types';
import { ConfirmModal } from '../components/ConfirmModal';
import { clearAllHistory, getStorageEstimate } from '../database/indexedDb';

interface SettingsPageProps {
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => Promise<void>;
  serverHealth: ServerHealthResponse | null;
  onRefreshHealth: () => Promise<void>;
  onHistoryCleared: () => Promise<void>;
}

export function SettingsPage({
  settings,
  onUpdateSettings,
  serverHealth,
  onRefreshHealth,
  onHistoryCleared,
}: SettingsPageProps) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [savedNotice, setSavedNotice] = useState(false);
  const [storageInfo, setStorageInfo] = useState<{ usageBytes: number; quotaBytes: number } | null>(
    null
  );
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const loadStorage = async () => {
    const est = await getStorageEstimate();
    setStorageInfo(est);
  };

  useEffect(() => {
    void loadStorage();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await onUpdateSettings(draft);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2500);
  };

  const handleClearAll = async () => {
    await clearAllHistory();
    await onHistoryCleared();
    await loadStorage();
    setConfirmClearOpen(false);
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="font-display text-2xl font-semibold text-slate-100">Settings</h1>
        <p className="text-sm text-slate-400 mt-1">
          Configure monitoring behavior, reconnection backoff, IndexedDB storage, and inspect
          server limits.
        </p>
      </div>

      {/* Client Preferences Form */}
      <form
        onSubmit={handleSave}
        className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5 space-y-5"
      >
        <h2 className="font-display text-sm font-semibold text-slate-100">
          Client Engine &amp; Interface Preferences
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <label className="flex items-start justify-between gap-4 p-3.5 bg-[#060A12] border border-slate-800 rounded-md cursor-pointer">
            <div>
              <div className="text-xs font-semibold text-slate-200">
                Keep Screen Awake by Default
              </div>
              <div className="text-xs text-slate-400 mt-1">
                Automatically request Screen Wake Lock when starting soak tests.
              </div>
            </div>
            <input
              type="checkbox"
              checked={draft.keepScreenAwakeDefault}
              onChange={(e) =>
                setDraft({ ...draft, keepScreenAwakeDefault: e.target.checked })
              }
              className="mt-1 h-4 w-4 accent-cyan-500"
            />
          </label>

          <label className="flex items-start justify-between gap-4 p-3.5 bg-[#060A12] border border-slate-800 rounded-md cursor-pointer">
            <div>
              <div className="text-xs font-semibold text-slate-200">
                Background Priority Keep-Alive by Default
              </div>
              <div className="text-xs text-slate-400 mt-1">
                Hold Web Lock and silent audio keep-alive to preserve full throughput when switching tabs or applications.
              </div>
            </div>
            <input
              type="checkbox"
              checked={draft.backgroundKeepAliveDefault}
              onChange={(e) =>
                setDraft({ ...draft, backgroundKeepAliveDefault: e.target.checked })
              }
              className="mt-1 h-4 w-4 accent-cyan-500"
            />
          </label>

          <label className="flex items-start justify-between gap-4 p-3.5 bg-[#060A12] border border-slate-800 rounded-md cursor-pointer">
            <div>
              <div className="text-xs font-semibold text-slate-200">Auto-Scroll Event Log</div>
              <div className="text-xs text-slate-400 mt-1">
                Keep live session event log pinned to latest timestamped entries.
              </div>
            </div>
            <input
              type="checkbox"
              checked={draft.autoScrollEventLog}
              onChange={(e) => setDraft({ ...draft, autoScrollEventLog: e.target.checked })}
              className="mt-1 h-4 w-4 accent-cyan-500"
            />
          </label>

          <div>
            <label htmlFor="initial-backoff" className="block text-xs font-medium text-slate-300 mb-1.5">
              Initial Reconnection Delay (seconds)
            </label>
            <input
              id="initial-backoff"
              type="number"
              min={2}
              max={60}
              value={draft.initialReconnectDelaySeconds}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  initialReconnectDelaySeconds: Math.max(2, Math.min(60, Number(e.target.value) || 5)),
                })
              }
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#060A12] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div>
            <label htmlFor="max-backoff" className="block text-xs font-medium text-slate-300 mb-1.5">
              Maximum Exponential Backoff (seconds)
            </label>
            <input
              id="max-backoff"
              type="number"
              min={10}
              max={300}
              value={draft.maxReconnectDelaySeconds}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  maxReconnectDelaySeconds: Math.max(
                    10,
                    Math.min(300, Number(e.target.value) || 60)
                  ),
                })
              }
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#060A12] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div>
            <label htmlFor="fluctuation-pct" className="block text-xs font-medium text-slate-300 mb-1.5">
              Speed Fluctuation Alert Threshold (%)
            </label>
            <input
              id="fluctuation-pct"
              type="number"
              min={10}
              max={90}
              value={draft.fluctuationThresholdPercent}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  fluctuationThresholdPercent: Math.max(
                    10,
                    Math.min(90, Number(e.target.value) || 35)
                  ),
                })
              }
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#060A12] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div>
            <label htmlFor="default-chart-range" className="block text-xs font-medium text-slate-300 mb-1.5">
              Default Live Chart Window
            </label>
            <select
              id="default-chart-range"
              value={draft.defaultChartRange}
              onChange={(e) =>
                setDraft({ ...draft, defaultChartRange: e.target.value as '60s' | 'full' })
              }
              className="w-full px-3 py-2 text-sm bg-[#060A12] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
            >
              <option value="60s">Last 60 Seconds (Rolling)</option>
              <option value="full">Full Session (Downsampled)</option>
            </select>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-emerald-400">
            {savedNotice ? 'Settings persisted to IndexedDB.' : ''}
          </span>
          <button
            type="submit"
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md cursor-pointer"
          >
            <Save className="h-3.5 w-3.5" />
            <span>Save Preferences</span>
          </button>
        </div>
      </form>

      {/* Server Health & Safety Limits */}
      <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-slate-100">
            Backend Server Health &amp; Safety Limits
          </h2>
          <button
            type="button"
            onClick={() => void onRefreshHealth()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-md cursor-pointer"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Refresh</span>
          </button>
        </div>

        {serverHealth ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs">
            <div className="bg-[#060A12] border border-slate-800 rounded-md p-3">
              <div className="text-slate-400">Server Uptime</div>
              <div className="mt-1 font-mono tabular-nums text-sm text-emerald-400">
                {formatDuration(serverHealth.uptimeSeconds)}
              </div>
            </div>
            <div className="bg-[#060A12] border border-slate-800 rounded-md p-3">
              <div className="text-slate-400">Process Memory (RSS)</div>
              <div className="mt-1 font-mono tabular-nums text-sm text-slate-100">
                {serverHealth.memoryMb.rss} MB (Heap {serverHealth.memoryMb.heapUsed} MB)
              </div>
            </div>
            <div className="bg-[#060A12] border border-slate-800 rounded-md p-3">
              <div className="text-slate-400">Active Streams</div>
              <div className="mt-1 font-mono tabular-nums text-sm text-slate-100">
                {serverHealth.activeStreams} across {serverHealth.activeSessions} session(s)
              </div>
            </div>
            <div className="bg-[#060A12] border border-slate-800 rounded-md p-3">
              <div className="text-slate-400">Max Duration Cap</div>
              <div className="mt-1 font-mono tabular-nums text-sm text-slate-100">
                {formatDuration(serverHealth.limits.maxDurationSeconds)}
              </div>
            </div>
            <div className="bg-[#060A12] border border-slate-800 rounded-md p-3">
              <div className="text-slate-400">Max Bandwidth Cap</div>
              <div className="mt-1 font-mono tabular-nums text-sm text-cyan-300">
                {serverHealth.limits.maxBandwidthMbps === 0
                  ? 'Uncapped'
                  : `${serverHealth.limits.maxBandwidthMbps} Mbps`}
              </div>
            </div>
            <div className="bg-[#060A12] border border-slate-800 rounded-md p-3">
              <div className="text-slate-400">Sessions / Client IP</div>
              <div className="mt-1 font-mono tabular-nums text-sm text-slate-100">
                Max {serverHealth.limits.maxActiveSessionsPerClient}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-400">Server health unavailable.</p>
        )}
      </div>

      {/* Browser Storage Management */}
      <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-sm font-semibold text-slate-100">
            IndexedDB Local Storage
          </h2>
          <p className="text-xs text-slate-400 mt-1 font-mono tabular-nums">
            {storageInfo
              ? `Estimated usage: ${formatBytesToGb(storageInfo.usageBytes)} of ${formatBytesToGb(storageInfo.quotaBytes)} browser quota`
              : 'Storage quota estimation unavailable in this browser.'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setConfirmClearOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-red-600/20 hover:bg-red-600/30 border border-red-500/40 text-red-300 rounded-md cursor-pointer"
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span>Clear All History</span>
        </button>
      </div>

      <ConfirmModal
        open={confirmClearOpen}
        title="Clear All IndexedDB History"
        description="This permanently removes all recorded soak test sessions, telemetry samples, and event logs from this browser. Saved preferences are retained."
        confirmLabel="Clear All Data"
        confirmTone="danger"
        onCancel={() => setConfirmClearOpen(false)}
        onConfirm={() => void handleClearAll()}
      />
    </div>
  );
}
