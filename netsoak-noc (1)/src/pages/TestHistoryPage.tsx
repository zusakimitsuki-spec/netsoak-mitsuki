import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Download, FileBarChart2, Search, Trash2 } from 'lucide-react';
import {
  formatBytesToGb,
  formatDuration,
  formatMbps,
} from '../../shared/networkMath';
import type { SessionStatus, StoredSessionSummary, TestDirection } from '../../shared/types';
import { ConfirmModal } from '../components/ConfirmModal';

interface TestHistoryPageProps {
  history: StoredSessionSummary[];
  onOpenReport: (sessionId: string) => void;
  onExportCsv: (sessionId: string, createdAt: number) => void;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onGoToNewTest: () => void;
}

export function TestHistoryPage({
  history,
  onOpenReport,
  onExportCsv,
  onDeleteSession,
  onGoToNewTest,
}: TestHistoryPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [directionFilter, setDirectionFilter] = useState<'all' | TestDirection>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | SessionStatus>('all');
  const [deleteTarget, setDeleteTarget] = useState<StoredSessionSummary | null>(null);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return history.filter((item) => {
      if (q && !item.session_id.toLowerCase().includes(q)) return false;
      if (directionFilter !== 'all' && item.config.direction !== directionFilter) return false;
      if (statusFilter !== 'all' && item.status !== statusFilter) return false;
      return true;
    });
  }, [history, searchQuery, directionFilter, statusFilter]);

  const totals = useMemo(() => {
    let downloadBytes = 0;
    let uploadBytes = 0;
    let activeSeconds = 0;
    for (const item of filtered) {
      downloadBytes += item.total_download_bytes || 0;
      uploadBytes += item.total_upload_bytes || 0;
      activeSeconds += item.active_seconds || 0;
    }
    return {
      downloadBytes,
      uploadBytes,
      combinedBytes: downloadBytes + uploadBytes,
      activeSeconds,
    };
  }, [filtered]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-100">Test History</h1>
          <p className="text-sm text-slate-400 mt-1">
            Persistent client-side session archive &amp; data transfer totals stored in IndexedDB ({history.length} total).
          </p>
        </div>
      </div>

      {/* Cumulative Data Transfer History Totals */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Total Downloaded</span>
            <ArrowDown className="h-3.5 w-3.5 text-cyan-400" />
          </div>
          <div className="mt-1.5 font-mono tabular-nums text-xl font-semibold text-cyan-400">
            {formatBytesToGb(totals.downloadBytes)}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            Across {filtered.length} matching session{filtered.length === 1 ? '' : 's'}
          </div>
        </div>

        <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Total Uploaded</span>
            <ArrowUp className="h-3.5 w-3.5 text-emerald-400" />
          </div>
          <div className="mt-1.5 font-mono tabular-nums text-xl font-semibold text-emerald-400">
            {formatBytesToGb(totals.uploadBytes)}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            Across {filtered.length} matching session{filtered.length === 1 ? '' : 's'}
          </div>
        </div>

        <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-4">
          <div className="text-xs text-slate-400">Combined Data Transferred</div>
          <div className="mt-1.5 font-mono tabular-nums text-xl font-semibold text-slate-100">
            {formatBytesToGb(totals.combinedBytes)}
          </div>
          <div className="mt-1 text-xs text-slate-500">Download + Upload total</div>
        </div>

        <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-4">
          <div className="text-xs text-slate-400">Cumulative Active Soak Time</div>
          <div className="mt-1.5 font-mono tabular-nums text-xl font-semibold text-slate-100">
            {formatDuration(totals.activeSeconds)}
          </div>
          <div className="mt-1 text-xs text-slate-500">Excludes outage intervals</div>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="h-4 w-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by Session ID..."
            className="w-full pl-9 pr-3 py-2 text-xs bg-[#060A12] border border-slate-800 rounded-md text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
          />
        </div>

        <select
          aria-label="Filter by direction"
          value={directionFilter}
          onChange={(e) => setDirectionFilter(e.target.value as 'all' | TestDirection)}
          className="px-3 py-2 text-xs bg-[#060A12] border border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-cyan-500"
        >
          <option value="all">All Directions</option>
          <option value="download">Download</option>
          <option value="upload">Upload</option>
          <option value="bidirectional">Bidirectional</option>
        </select>

        <select
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | SessionStatus)}
          className="px-3 py-2 text-xs bg-[#060A12] border border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-cyan-500"
        >
          <option value="all">All Statuses</option>
          <option value="completed">Completed</option>
          <option value="stopped">Stopped</option>
          <option value="running">Running</option>
          <option value="error">Error</option>
        </select>
      </div>

      <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-slate-400">
              {history.length === 0
                ? 'No soak tests have been recorded in this browser yet.'
                : 'No sessions match the current filters.'}
            </p>
            {history.length === 0 && (
              <button
                type="button"
                onClick={onGoToNewTest}
                className="mt-4 px-4 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md cursor-pointer"
              >
                Configure First Test
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-[#080D18] text-slate-400">
                  <th className="py-3 px-4 font-medium">Session ID</th>
                  <th className="py-3 px-3 font-medium">Start Date</th>
                  <th className="py-3 px-3 font-medium">Direction</th>
                  <th className="py-3 px-3 font-medium text-right">Active / Target</th>
                  <th className="py-3 px-3 font-medium text-right">Target Rate</th>
                  <th className="py-3 px-3 font-medium text-right">Avg DL</th>
                  <th className="py-3 px-3 font-medium text-right">Avg UL</th>
                  <th className="py-3 px-3 font-medium text-right">Max Peak</th>
                  <th className="py-3 px-3 font-medium text-right">Downloaded</th>
                  <th className="py-3 px-3 font-medium text-right">Uploaded</th>
                  <th className="py-3 px-3 font-medium text-right">Total Data</th>
                  <th className="py-3 px-3 font-medium text-right">Drops</th>
                  <th className="py-3 px-3 font-medium">Status</th>
                  <th className="py-3 px-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {filtered.map((item) => {
                  const peak = Math.max(item.max_download_mbps, item.max_upload_mbps);
                  const isActive =
                    item.status === 'running' ||
                    item.status === 'initializing' ||
                    item.status === 'reconnecting';
                  return (
                    <tr key={item.session_id} className="hover:bg-slate-900/40">
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-100 whitespace-nowrap">
                        {item.session_id}
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                        {new Date(item.started_at).toLocaleString()}
                      </td>
                      <td className="py-3 px-3 capitalize text-slate-200 whitespace-nowrap">
                        {item.config.direction}
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums text-right text-slate-300 whitespace-nowrap">
                        {formatDuration(item.active_seconds)} / {formatDuration(item.config.durationSeconds)}
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums text-right text-slate-300 whitespace-nowrap">
                        {item.config.targetMbps === 0 ? 'Uncapped' : `${item.config.targetMbps} Mbps`}
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums text-right text-cyan-300 whitespace-nowrap">
                        {item.config.direction === 'upload'
                          ? '—'
                          : `${formatMbps(item.avg_download_mbps)} M`}
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums text-right text-emerald-300 whitespace-nowrap">
                        {item.config.direction === 'download'
                          ? '—'
                          : `${formatMbps(item.avg_upload_mbps)} M`}
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums text-right text-slate-200 whitespace-nowrap">
                        {formatMbps(peak)} M
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums text-right text-cyan-300 whitespace-nowrap">
                        {formatBytesToGb(item.total_download_bytes)}
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums text-right text-emerald-300 whitespace-nowrap">
                        {formatBytesToGb(item.total_upload_bytes)}
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums text-right text-slate-200 whitespace-nowrap">
                        {formatBytesToGb(item.total_download_bytes + item.total_upload_bytes)}
                      </td>
                      <td
                        className={`py-3 px-3 font-mono tabular-nums text-right ${
                          item.disconnect_count > 0 ? 'text-amber-400' : 'text-slate-400'
                        }`}
                      >
                        {item.disconnect_count}
                      </td>
                      <td className="py-3 px-3 capitalize whitespace-nowrap">
                        <span
                          className={
                            item.status === 'completed'
                              ? 'text-emerald-400'
                              : item.status === 'error'
                                ? 'text-red-400'
                                : item.status === 'reconnecting'
                                  ? 'text-amber-400'
                                  : 'text-slate-300'
                          }
                        >
                          {item.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onOpenReport(item.session_id)}
                            title="Open Detailed Report"
                            className="p-1.5 text-cyan-400 hover:text-cyan-300 hover:bg-slate-800 rounded cursor-pointer"
                          >
                            <FileBarChart2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onExportCsv(item.session_id, item.created_at)}
                            title="Export CSV Report"
                            className="p-1.5 text-slate-300 hover:text-slate-100 hover:bg-slate-800 rounded cursor-pointer"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={isActive}
                            onClick={() => setDeleteTarget(item)}
                            title={isActive ? 'Stop test before deleting' : 'Delete session'}
                            className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmModal
        open={deleteTarget !== null}
        title="Delete Session Record"
        description={`Permanently delete session ${deleteTarget?.session_id ?? ''} along with all stored telemetry samples and event logs from IndexedDB?`}
        confirmLabel="Delete Session"
        confirmTone="danger"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            void onDeleteSession(deleteTarget.session_id);
            setDeleteTarget(null);
          }
        }}
      />
    </div>
  );
}
