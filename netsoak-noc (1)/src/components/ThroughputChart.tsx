import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatDuration, formatTimestamp } from '../../shared/networkMath';
import type { TelemetrySample } from '../../shared/types';

interface ThroughputChartProps {
  samples: TelemetrySample[];
  showDownload: boolean;
  showUpload: boolean;
  rangeMode: '60s' | 'full';
  onRangeModeChange?: (mode: '60s' | 'full') => void;
  allowRangeToggle?: boolean;
  loadingFull?: boolean;
  targetMbps?: number;
}

interface ChartDatum {
  elapsed: number;
  timeLabel: string;
  download: number | null;
  upload: number | null;
  state: string;
}

export function ThroughputChart({
  samples,
  showDownload,
  showUpload,
  rangeMode,
  onRangeModeChange,
  allowRangeToggle = true,
  loadingFull = false,
  targetMbps = 0,
}: ThroughputChartProps) {
  const chartData: ChartDatum[] = samples.map((s) => ({
    elapsed: s.elapsed_seconds,
    timeLabel: formatTimestamp(s.timestamp),
    download: s.download_mbps,
    upload: s.upload_mbps,
    state: s.connection_state,
  }));

  return (
    <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h2 className="font-display text-sm font-semibold text-slate-100">
            Sustained Throughput Telemetry
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Application-level WebSocket bandwidth (Mbps)
            {targetMbps > 0 ? ` · Target ${targetMbps} Mbps` : ' · Uncapped mode'}
          </p>
        </div>

        {allowRangeToggle && onRangeModeChange && (
          <div className="inline-flex items-center p-0.5 bg-[#060A12] border border-slate-800 rounded-md">
            <button
              type="button"
              onClick={() => onRangeModeChange('60s')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                rangeMode === '60s'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Last 60s
            </button>
            <button
              type="button"
              onClick={() => onRangeModeChange('full')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                rangeMode === 'full'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Full Session
            </button>
          </div>
        )}
      </div>

      <div className="h-[320px] w-full">
        {loadingFull ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-400 font-mono">
            Loading downsampled session timeline...
          </div>
        ) : chartData.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-md">
            Waiting for first 1-second telemetry sample...
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid stroke="#1E293B" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="timeLabel"
                stroke="#64748B"
                tick={{ fill: '#94A3B8', fontSize: 11, fontFamily: 'JetBrains Mono' }}
                minTickGap={28}
              />
              <YAxis
                stroke="#64748B"
                tick={{ fill: '#94A3B8', fontSize: 11, fontFamily: 'JetBrains Mono' }}
                width={56}
                unit=" M"
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0B1120',
                  borderColor: '#334155',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontFamily: 'JetBrains Mono',
                  color: '#F1F5F9',
                }}
                labelFormatter={(label, payload) => {
                  const first = payload?.[0]?.payload as ChartDatum | undefined;
                  return first
                    ? `${label} · Active ${formatDuration(first.elapsed)}`
                    : String(label);
                }}
                formatter={(value: unknown, name: unknown) => {
                  const num = typeof value === 'number' ? value.toFixed(2) : '—';
                  return [`${num} Mbps`, String(name)];
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: '12px', paddingTop: '8px', color: '#CBD5E1' }}
              />
              {showDownload && (
                <Line
                  type="monotone"
                  dataKey="download"
                  name="Download (Mbps)"
                  stroke="#06B6D4"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              )}
              {showUpload && (
                <Line
                  type="monotone"
                  dataKey="upload"
                  name="Upload (Mbps)"
                  stroke="#10B981"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
