import { useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { formatTimestamp } from '../../shared/networkMath';
import type { EventSeverity, TestEvent } from '../../shared/types';

interface EventLogPanelProps {
  events: TestEvent[];
  autoScroll?: boolean;
  maxHeightClass?: string;
}

const SEVERITY_CONFIG: Record<
  EventSeverity,
  { label: string; colorClass: string; Icon: typeof Info }
> = {
  info: { label: 'INFO', colorClass: 'text-cyan-400', Icon: Info },
  success: { label: 'OK', colorClass: 'text-emerald-400', Icon: CheckCircle2 },
  warning: { label: 'WARN', colorClass: 'text-amber-400', Icon: AlertTriangle },
  error: { label: 'ERR', colorClass: 'text-red-400', Icon: AlertCircle },
};

export function EventLogPanel({
  events,
  autoScroll = true,
  maxHeightClass = 'max-h-[300px]',
}: EventLogPanelProps) {
  const [filter, setFilter] = useState<'all' | EventSeverity>('all');
  const containerRef = useRef<HTMLDivElement | null>(null);

  const visibleEvents =
    filter === 'all' ? events : events.filter((evt) => evt.severity === filter);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [visibleEvents.length, autoScroll]);

  return (
    <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="font-display text-sm font-semibold text-slate-100">Session Event Log</h2>
          <p className="text-xs text-slate-400 mt-0.5 font-mono tabular-nums">
            {events.length} event{events.length === 1 ? '' : 's'} recorded
          </p>
        </div>

        <div className="inline-flex items-center p-0.5 bg-[#060A12] border border-slate-800 rounded-md">
          {(['all', 'info', 'success', 'warning', 'error'] as const).map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => setFilter(level)}
              className={`px-2.5 py-1 text-xs font-medium rounded capitalize transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filter === level
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {level}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={containerRef}
        className={`${maxHeightClass} overflow-y-auto border border-slate-800/80 rounded-md bg-[#060A12] divide-y divide-slate-800/60`}
      >
        {visibleEvents.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500">
            No events recorded for this filter.
          </div>
        ) : (
          visibleEvents.map((evt, idx) => {
            const meta = SEVERITY_CONFIG[evt.severity];
            const Icon = meta.Icon;
            return (
              <div
                key={`${evt.timestamp}-${evt.code}-${idx}`}
                className="flex items-start gap-3 px-3.5 py-2.5 text-xs hover:bg-slate-900/40"
              >
                <span className="font-mono tabular-nums text-slate-500 shrink-0 pt-0.5">
                  {formatTimestamp(evt.timestamp)}
                </span>
                <span className={`inline-flex items-center gap-1 font-mono font-semibold shrink-0 pt-0.5 w-14 ${meta.colorClass}`}>
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{meta.label}</span>
                </span>
                <span className="text-slate-200 leading-relaxed break-words">{evt.message}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
