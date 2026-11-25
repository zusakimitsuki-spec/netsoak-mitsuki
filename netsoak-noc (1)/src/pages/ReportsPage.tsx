import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import {
  formatBytesToGb,
  formatDuration,
  formatMbps,
} from '../../shared/networkMath';
import type {
  StoredSessionSummary,
  TelemetrySample,
  TestEvent,
} from '../../shared/types';
import { EventLogPanel } from '../components/EventLogPanel';
import { ThroughputChart } from '../components/ThroughputChart';
import {
  getSessionEvents,
  getSessionSamplesDownsampled,
} from '../database/indexedDb';

interface ReportsPageProps {
  history: StoredSessionSummary[];
  selectedSessionId: string | null;
  onSelectSessionId: (id: string) => void;
  onExportCsv: (sessionId: string, createdAt: number) => void;
  onGoToNewTest: () => void;
}

export function ReportsPage({
  history,
  selectedSessionId,
  onSelectSessionId,
  onExportCsv,
  onGoToNewTest,
}: ReportsPageProps) {
  const activeSummary =
    history.find((h) => h.session_id === selectedSessionId) || history[0] || null;

  const [samples, setSamples] = useState<TelemetrySample[]>([]);
  const [events, setEvents] = useState<TestEvent[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activeSummary) {
      setSamples([]);
      setEvents([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void Promise.all([
      getSessionSamplesDownsampled(activeSummary.session_id, 300),
      getSessionEvents(activeSummary.session_id),
    ])
      .then(([loadedSamples, loadedEvents]) => {
        if (!cancelled) {
          setSamples(loadedSamples);
          setEvents(loadedEvents);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSummary?.session_id]);

  if (!activeSummary) {
    return (
      <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-12 text-center">
        <h1 className="font-display text-lg font-semibold text-slate-100">
          No Session Reports Available
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Complete a soak test to inspect its full-session performance chart, event timeline, and CSV
          report.
        </p>
        <button
          type="button"
          onClick={onGoToNewTest}
          className="mt-5 px-4 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md cursor-pointer"
        >
          Configure New Test
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-100">
            Session Diagnostic Report
          </h1>
          <p className="text-xs text-slate-400 mt-1 font-mono tabular-nums">
            {activeSummary.session_id} · Started {new Date(activeSummary.started_at).toLocaleString()}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Select session report"
            value={activeSummary.session_id}
            onChange={(e) => onSelectSessionId(e.target.value)}
            className="px-3 py-2 text-xs font-mono bg-[#0B1120] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
          >
            {history.map((h) => (
              <option key={h.session_id} value={h.session_id}>
                {h.session_id} ({h.config.direction} · {new Date(h.started_at).toLocaleDateString()})
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => onExportCsv(activeSummary.session_id, activeSummary.created_at)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md cursor-pointer whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Download CSV Report</span>
          </button>
        </div>
      </div>

      {/* Summary Statistics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5 space-y-3">
          <div className="text-xs font-semibold text-cyan-400">Download Summary</div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-slate-400">Average</div>
              <div className="font-mono tabular-nums text-base font-semibold text-slate-100">
                {activeSummary.config.direction === 'upload'
                  ? '—'
                  : `${formatMbps(activeSummary.avg_download_mbps)} Mbps`}
              </div>
            </div>
            <div>
              <div className="text-slate-400">Peak Observed</div>
              <div className="font-mono tabular-nums text-base font-semibold text-slate-100">
                {activeSummary.config.direction === 'upload'
                  ? '—'
                  : `${formatMbps(activeSummary.max_download_mbps)} Mbps`}
              </div>
            </div>
            <div>
              <div className="text-slate-400">Minimum</div>
              <div className="font-mono tabular-nums text-sm text-slate-200">
                {activeSummary.config.direction === 'upload'
                  ? '—'
                  : `${formatMbps(activeSummary.min_download_mbps)} Mbps`}
              </div>
            </div>
            <div>
              <div className="text-slate-400">Total Downloaded</div>
              <div className="font-mono tabular-nums text-sm text-slate-200">
                {formatBytesToGb(activeSummary.total_download_bytes)}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5 space-y-3">
          <div className="text-xs font-semibold text-emerald-400">Upload Summary</div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-slate-400">Average</div>
              <div className="font-mono tabular-nums text-base font-semibold text-slate-100">
                {activeSummary.config.direction === 'download'
                  ? '—'
                  : `${formatMbps(activeSummary.avg_upload_mbps)} Mbps`}
              </div>
            </div>
            <div>
              <div className="text-slate-400">Peak Observed</div>
              <div className="font-mono tabular-nums text-base font-semibold text-slate-100">
                {activeSummary.config.direction === 'download'
                  ? '—'
                  : `${formatMbps(activeSummary.max_upload_mbps)} Mbps`}
              </div>
            </div>
            <div>
              <div className="text-slate-400">Minimum</div>
              <div className="font-mono tabular-nums text-sm text-slate-200">
                {activeSummary.config.direction === 'download'
                  ? '—'
                  : `${formatMbps(activeSummary.min_upload_mbps)} Mbps`}
              </div>
            </div>
            <div>
              <div className="text-slate-400">Total Uploaded</div>
              <div className="font-mono tabular-nums text-sm text-slate-200">
                {formatBytesToGb(activeSummary.total_upload_bytes)}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5 space-y-3">
          <div className="text-xs font-semibold text-slate-300">Stability &amp; Configuration</div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-slate-400">Active / Outage</div>
              <div className="font-mono tabular-nums text-sm font-semibold text-slate-100">
                {formatDuration(activeSummary.active_seconds)} /{' '}
                {formatDuration(activeSummary.outage_seconds)}
              </div>
            </div>
            <div>
              <div className="text-slate-400">Uptime</div>
              <div className="font-mono tabular-nums text-sm font-semibold text-emerald-400">
                {activeSummary.uptime_percent.toFixed(2)}%
              </div>
            </div>
            <div>
              <div className="text-slate-400">Disconnects</div>
              <div className="font-mono tabular-nums text-sm text-slate-200">
                {activeSummary.disconnect_count} ({activeSummary.reconnect_attempts} retries)
              </div>
            </div>
            <div>
              <div className="text-slate-400">Target / Streams</div>
              <div className="font-mono tabular-nums text-sm text-slate-200">
                {activeSummary.config.targetMbps === 0
                  ? 'Uncapped'
                  : `${activeSummary.config.targetMbps}M`}{' '}
                · {activeSummary.config.parallelStreams} WS
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Full-Session Downsampled Chart */}
      <ThroughputChart
        samples={samples}
        showDownload={
          activeSummary.config.direction === 'download' ||
          activeSummary.config.direction === 'bidirectional'
        }
        showUpload={
          activeSummary.config.direction === 'upload' ||
          activeSummary.config.direction === 'bidirectional'
        }
        rangeMode="full"
        allowRangeToggle={false}
        loadingFull={loading}
        targetMbps={activeSummary.config.targetMbps}
      />

      {/* Event Log Inspector */}
      <EventLogPanel events={events} autoScroll={false} maxHeightClass="max-h-[380px]" />
    </div>
  );
}
