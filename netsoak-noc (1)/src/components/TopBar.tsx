import { Menu, Play, Square } from 'lucide-react';
import type { NavSection, ServerHealthResponse } from '../../shared/types';

interface TopBarProps {
  activeSection: NavSection;
  isTestActive: boolean;
  serverHealth: ServerHealthResponse | null;
  serverError: string | null;
  onOpenMobileMenu: () => void;
  onPrimaryAction: () => void;
}

const SECTION_LABELS: Record<NavSection, string> = {
  dashboard: 'Operations / Live Dashboard',
  'new-test': 'Operations / New Soak Test',
  history: 'Records / Test History',
  reports: 'Records / Session Reports',
  settings: 'System / Configuration',
  about: 'Documentation / Methodology',
};

export function TopBar({
  activeSection,
  isTestActive,
  serverHealth,
  serverError,
  onOpenMobileMenu,
  onPrimaryAction,
}: TopBarProps) {
  return (
    <header className="h-16 bg-[#080D18] border-b border-slate-800/90 px-4 lg:px-6 flex items-center justify-between gap-8 sticky top-0 z-30">
      {/* Zone 1: Contextual breadcrumb & mobile trigger */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          aria-label="Open navigation menu"
          className="lg:hidden p-2 text-slate-400 hover:text-slate-100 rounded-md border border-slate-800"
        >
          <Menu className="h-4 w-4" />
        </button>
        <div className="text-sm font-medium text-slate-200 truncate">
          {SECTION_LABELS[activeSection]}
        </div>
      </div>

      {/* Zone 2: Quiet unboxed server telemetry summary */}
      <div className="hidden md:flex items-center gap-2 text-xs text-slate-400 whitespace-nowrap shrink-0">
        {serverError ? (
          <span className="text-red-400 font-medium">Backend Unreachable</span>
        ) : serverHealth ? (
          <>
            <span className="text-emerald-400 font-medium">Node Connected</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {serverHealth.activeSessions} active session{serverHealth.activeSessions === 1 ? '' : 's'}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              Cap {serverHealth.limits.maxBandwidthMbps === 0 ? 'Uncapped' : `${serverHealth.limits.maxBandwidthMbps} Mbps`}
            </span>
          </>
        ) : (
          <span>Checking backend...</span>
        )}
      </div>

      {/* Zone 3: Single Primary Action */}
      <div className="shrink-0">
        {isTestActive ? (
          <button
            type="button"
            onClick={onPrimaryAction}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md bg-red-600 hover:bg-red-500 text-white transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
            <span>STOP TEST</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onPrimaryAction}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Play className="h-3.5 w-3.5 fill-current" />
            <span>Configure Test</span>
          </button>
        )}
      </div>
    </header>
  );
}
