import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Play,
  ShieldAlert,
} from 'lucide-react';
import {
  MAX_DURATION_SECONDS,
  estimateDataUsage,
  formatDuration,
} from '../../shared/networkMath';
import type {
  ServerHealthResponse,
  TestConfig,
  TestDirection,
} from '../../shared/types';

interface NewTestPageProps {
  serverHealth: ServerHealthResponse | null;
  isRunning: boolean;
  isStarting: boolean;
  onStartTest: (config: TestConfig) => Promise<void>;
  onGoToDashboard: () => void;
}

const DURATION_PRESETS = [
  { label: '1m', seconds: 60 },
  { label: '5m', seconds: 300 },
  { label: '15m', seconds: 900 },
  { label: '30m', seconds: 1800 },
  { label: '1h', seconds: 3600 },
  { label: '6h', seconds: 21600 },
  { label: '12h', seconds: 43200 },
  { label: '24h', seconds: 86400 },
];

const BANDWIDTH_PRESETS = [0, 5, 10, 20, 25, 50, 100, 250, 500, 1000];

export function NewTestPage({
  serverHealth,
  isRunning,
  isStarting,
  onStartTest,
  onGoToDashboard,
}: NewTestPageProps) {
  const maxServerBw = serverHealth?.limits.maxBandwidthMbps ?? 0;
  const maxServerDuration = serverHealth?.limits.maxDurationSeconds ?? MAX_DURATION_SECONDS;
  const maxServerStreams = serverHealth?.limits.maxParallelStreams ?? 6;

  const [direction, setDirection] = useState<TestDirection>('bidirectional');
  const [durationMode, setDurationMode] = useState<'preset' | 'custom'>('preset');
  const [presetSeconds, setPresetSeconds] = useState<number>(300);
  const [customHours, setCustomHours] = useState<number>(0);
  const [customMinutes, setCustomMinutes] = useState<number>(10);

  const [bandwidthMode, setBandwidthMode] = useState<'preset' | 'custom'>('preset');
  const [presetMbps, setPresetMbps] = useState<number>(0);
  const [customMbpsInput, setCustomMbpsInput] = useState<string>('100');

  const [parallelStreams, setParallelStreams] = useState<number>(6);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const effectiveDurationSeconds = useMemo(() => {
    if (durationMode === 'preset') return Math.min(maxServerDuration, presetSeconds);
    const total = Math.max(0, customHours) * 3600 + Math.max(0, customMinutes) * 60;
    return Math.min(maxServerDuration, total);
  }, [durationMode, presetSeconds, customHours, customMinutes, maxServerDuration]);

  const effectiveTargetMbps = useMemo(() => {
    if (bandwidthMode === 'preset') return presetMbps;
    const parsed = Number(customMbpsInput);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
  }, [bandwidthMode, presetMbps, customMbpsInput]);

  const customDurationTooShort = durationMode === 'custom' && effectiveDurationSeconds < 60;
  const customDurationTooLong =
    durationMode === 'custom' && customHours * 3600 + customMinutes * 60 > maxServerDuration;
  const targetExceedsCap = maxServerBw > 0 && effectiveTargetMbps > maxServerBw;

  const estimate = useMemo(() => {
    const uncappedRef = maxServerBw > 0 ? maxServerBw : 1000;
    return estimateDataUsage(direction, effectiveDurationSeconds, effectiveTargetMbps, uncappedRef);
  }, [direction, effectiveDurationSeconds, effectiveTargetMbps, maxServerBw]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    if (effectiveDurationSeconds < 10 || effectiveDurationSeconds > maxServerDuration) {
      setSubmitError(`Duration must be between 1 minute and ${Math.floor(maxServerDuration / 3600)} hours.`);
      return;
    }
    if (targetExceedsCap) {
      setSubmitError(`Target bandwidth exceeds server safety cap of ${maxServerBw} Mbps.`);
      return;
    }

    try {
      await onStartTest({
        direction,
        durationSeconds: effectiveDurationSeconds,
        targetMbps: effectiveTargetMbps,
        parallelStreams: Math.min(maxServerStreams, Math.max(1, parallelStreams)),
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to initialize soak test.');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-5xl">
      <div>
        <h1 className="font-display text-2xl font-semibold text-slate-100">
          Configure Network Soak Test
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Define stream direction, duration, target rate limiting, and concurrency before starting.
        </p>
      </div>

      {isRunning && (
        <div className="bg-[#0B1120] border border-cyan-500/40 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
          <p className="text-xs text-cyan-200">
            A soak test is currently running. Stop the active session before starting a new configuration.
          </p>
          <button
            type="button"
            onClick={onGoToDashboard}
            className="px-3.5 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md cursor-pointer"
          >
            Return to Live Dashboard
          </button>
        </div>
      )}

      {/* Mandatory Safety & Authorization Warning */}
      <div className="bg-[#0B1120] border border-amber-500/40 rounded-lg p-4 flex items-start gap-3">
        <ShieldAlert className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="text-xs text-amber-200/90 leading-relaxed">
          <span className="font-semibold text-amber-300 block mb-0.5">
            Bandwidth &amp; Authorization Warning
          </span>
          Network testing can consume substantial amounts of bandwidth and data. Only run tests
          against your own server or an authorized testing endpoint. Uncapped tests may consume
          hundreds of gigabytes of data during extended sessions.
        </div>
      </div>

      {/* A. Test Direction */}
      <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-slate-100">A. Test Direction</h2>
          <span className="text-xs text-slate-400 capitalize">Selected: {direction}</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {(
            [
              {
                id: 'download' as const,
                title: 'Download Test',
                desc: 'Server streams 64 KB binary frames down to client worker.',
                Icon: ArrowDown,
                accent: 'text-cyan-400',
              },
              {
                id: 'upload' as const,
                title: 'Upload Test',
                desc: 'Client worker streams 64 KB binary frames up to server.',
                Icon: ArrowUp,
                accent: 'text-emerald-400',
              },
              {
                id: 'bidirectional' as const,
                title: 'Bidirectional (Download + Upload)',
                desc: 'Simultaneous independent download and upload streams at the same time.',
                Icon: ArrowLeftRight,
                accent: 'text-cyan-300',
              },
            ] as const
          ).map((opt) => {
            const Icon = opt.Icon;
            const active = direction === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setDirection(opt.id)}
                className={`text-left p-4 rounded-md border transition-colors cursor-pointer ${
                  active
                    ? 'bg-slate-800/90 border-cyan-500/70 text-slate-100'
                    : 'bg-[#060A12] border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm text-slate-100">{opt.title}</span>
                  <Icon className={`h-4 w-4 ${active ? opt.accent : 'text-slate-500'}`} />
                </div>
                <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">{opt.desc}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* B. Test Duration & D. Parallel Streams */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 bg-[#0B1120] border border-slate-800/90 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-slate-100">B. Test Duration</h2>
            <span className="text-xs font-mono tabular-nums text-cyan-300">
              {formatDuration(effectiveDurationSeconds)} (Max 24h)
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {DURATION_PRESETS.filter((p) => p.seconds <= maxServerDuration).map((preset) => {
              const active = durationMode === 'preset' && presetSeconds === preset.seconds;
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setDurationMode('preset');
                    setPresetSeconds(preset.seconds);
                  }}
                  className={`px-3.5 py-2 text-xs font-mono font-medium rounded-md border transition-colors cursor-pointer ${
                    active
                      ? 'bg-cyan-500/15 border-cyan-500 text-cyan-300'
                      : 'bg-[#060A12] border-slate-800 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setDurationMode('custom')}
              className={`px-3.5 py-2 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                durationMode === 'custom'
                  ? 'bg-cyan-500/15 border-cyan-500 text-cyan-300'
                  : 'bg-[#060A12] border-slate-800 text-slate-300 hover:border-slate-700'
              }`}
            >
              Custom
            </button>
          </div>

          {durationMode === 'custom' && (
            <div className="pt-2 flex flex-wrap items-end gap-4">
              <div>
                <label htmlFor="custom-hours" className="block text-xs text-slate-400 mb-1">
                  Hours (0–24)
                </label>
                <input
                  id="custom-hours"
                  type="number"
                  min={0}
                  max={24}
                  value={customHours}
                  onChange={(e) => setCustomHours(Math.max(0, Math.min(24, Number(e.target.value) || 0)))}
                  className="w-28 px-3 py-2 text-sm font-mono tabular-nums bg-[#060A12] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div>
                <label htmlFor="custom-minutes" className="block text-xs text-slate-400 mb-1">
                  Minutes (0–59)
                </label>
                <input
                  id="custom-minutes"
                  type="number"
                  min={0}
                  max={59}
                  value={customMinutes}
                  onChange={(e) =>
                    setCustomMinutes(Math.max(0, Math.min(59, Number(e.target.value) || 0)))
                  }
                  className="w-28 px-3 py-2 text-sm font-mono tabular-nums bg-[#060A12] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
                />
              </div>
              {customDurationTooShort && (
                <p className="text-xs text-red-400">Minimum duration is 1 minute.</p>
              )}
              {customDurationTooLong && (
                <p className="text-xs text-amber-400">
                  Clamped to 24-hour maximum ({Math.floor(maxServerDuration / 3600)}h).
                </p>
              )}
            </div>
          )}
        </div>

        {/* D. Parallel Connections */}
        <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-slate-100">
              D. Parallel Streams
            </h2>
            <span className="text-xs font-mono tabular-nums text-slate-300">
              {parallelStreams} WS
            </span>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {Array.from({ length: maxServerStreams }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setParallelStreams(n)}
                className={`py-2 text-sm font-mono font-semibold rounded-md border transition-colors cursor-pointer ${
                  parallelStreams === n
                    ? 'bg-cyan-500/15 border-cyan-500 text-cyan-300'
                    : 'bg-[#060A12] border-slate-800 text-slate-300 hover:border-slate-700'
                }`}
              >
                {n}
              </button>
            ))}
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Additional streams improve aggregate throughput on high-latency WAN links by mitigating
            single-TCP-window limits, at the cost of higher CPU and socket overhead.
          </p>
        </div>
      </div>

      {/* C. Target Bandwidth */}
      <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-100">
              C. Target Bandwidth (Token-Bucket Limiter)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              0 Mbps runs uncapped up to your connection or server ceiling (
              {maxServerBw === 0 ? 'Uncapped' : `${maxServerBw} Mbps max`}). Target rates never replace
              measured throughput.
            </p>
          </div>
          <span className="text-xs font-mono tabular-nums text-cyan-300">
            {effectiveTargetMbps === 0 ? 'Uncapped Mode' : `${effectiveTargetMbps} Mbps Target`}
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          {BANDWIDTH_PRESETS.filter((mbps) => mbps === 0 || maxServerBw === 0 || mbps <= maxServerBw).map(
            (mbps) => {
              const active = bandwidthMode === 'preset' && presetMbps === mbps;
              return (
                <button
                  key={mbps}
                  type="button"
                  onClick={() => {
                    setBandwidthMode('preset');
                    setPresetMbps(mbps);
                  }}
                  className={`px-3.5 py-2 text-xs font-mono font-medium rounded-md border transition-colors cursor-pointer ${
                    active
                      ? 'bg-cyan-500/15 border-cyan-500 text-cyan-300'
                      : 'bg-[#060A12] border-slate-800 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  {mbps === 0 ? '0 (Uncapped · Max Speed)' : `${mbps} Mbps`}
                </button>
              );
            }
          )}
          <button
            type="button"
            onClick={() => setBandwidthMode('custom')}
            className={`px-3.5 py-2 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
              bandwidthMode === 'custom'
                ? 'bg-cyan-500/15 border-cyan-500 text-cyan-300'
                : 'bg-[#060A12] border-slate-800 text-slate-300 hover:border-slate-700'
            }`}
          >
            Custom Mbps
          </button>
        </div>

        {bandwidthMode === 'custom' && (
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <label htmlFor="custom-mbps" className="text-xs text-slate-400">
              Custom Target (Mbps):
            </label>
            <input
              id="custom-mbps"
              type="number"
              min={0}
              max={maxServerBw > 0 ? maxServerBw : 10000}
              step={1}
              value={customMbpsInput}
              onChange={(e) => setCustomMbpsInput(e.target.value)}
              className="w-36 px-3 py-2 text-sm font-mono tabular-nums bg-[#060A12] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
            />
            {targetExceedsCap && (
              <span className="text-xs text-red-400">
                Exceeds server safety cap ({maxServerBw} Mbps).
              </span>
            )}
          </div>
        )}
      </div>

      {/* E. Data Usage Estimator */}
      <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-sm font-semibold text-slate-100">
            E. Data Usage Estimator
          </h2>
          <span className="text-xs text-slate-400 font-mono">
            {estimate.isUncapped
              ? `Estimated at ${maxServerBw > 0 ? maxServerBw : 1000} Mbps ceiling`
              : `Calculated at ${effectiveTargetMbps} Mbps`}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-[#060A12] border border-slate-800 rounded-md p-3.5">
            <div className="text-xs text-slate-400">Estimated Download Usage</div>
            <div className="mt-1 font-mono tabular-nums text-lg font-semibold text-cyan-400">
              {estimate.downloadGb.toFixed(2)} GB
            </div>
          </div>
          <div className="bg-[#060A12] border border-slate-800 rounded-md p-3.5">
            <div className="text-xs text-slate-400">Estimated Upload Usage</div>
            <div className="mt-1 font-mono tabular-nums text-lg font-semibold text-emerald-400">
              {estimate.uploadGb.toFixed(2)} GB
            </div>
          </div>
          <div className="bg-[#060A12] border border-slate-800 rounded-md p-3.5">
            <div className="text-xs text-slate-400">Combined Expected Total</div>
            <div className="mt-1 font-mono tabular-nums text-lg font-semibold text-slate-100">
              {estimate.combinedGb.toFixed(2)} GB
            </div>
          </div>
        </div>

        {estimate.isHighVolume && (
          <div className="flex items-start gap-2.5 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md p-3">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              High transfer volume projected ({estimate.combinedGb.toFixed(1)} GB). Ensure your ISP
              plan, VPN, and server egress allowance can sustain this volume.
            </span>
          </div>
        )}
      </div>

      {submitError && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/40 rounded-md p-3.5">
          {submitError}
        </div>
      )}

      <div className="flex items-center justify-end gap-4">
        <button
          type="submit"
          disabled={isRunning || isStarting || customDurationTooShort || targetExceedsCap}
          className="inline-flex items-center gap-2 px-6 py-2.5 text-sm font-semibold rounded-md bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 transition-colors cursor-pointer disabled:cursor-not-allowed"
        >
          <Play className="h-4 w-4 fill-current" />
          <span>{isStarting ? 'Initializing Session...' : 'Start Soak Test'}</span>
        </button>
      </div>
    </form>
  );
}
