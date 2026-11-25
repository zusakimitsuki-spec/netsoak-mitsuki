import {
  Activity,
  FileBarChart2,
  History,
  Info,
  PlaySquare,
  Settings,
  X,
} from 'lucide-react';
import type { NavSection } from '../../shared/types';

interface SidebarProps {
  activeSection: NavSection;
  onSelect: (section: NavSection) => void;
  isTestActive: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: Array<{ id: NavSection; label: string; icon: typeof Activity }> = [
  { id: 'dashboard', label: 'Dashboard', icon: Activity },
  { id: 'new-test', label: 'New Test', icon: PlaySquare },
  { id: 'history', label: 'Test History', icon: History },
  { id: 'reports', label: 'Reports', icon: FileBarChart2 },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'about', label: 'About', icon: Info },
];

export function Sidebar({
  activeSection,
  onSelect,
  isTestActive,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const navContent = (
    <div className="flex h-full flex-col bg-[#080D18] border-r border-slate-800/90">
      <div className="flex h-16 items-center justify-between px-5 border-b border-slate-800/90">
        <span className="font-display text-base font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0">
          NetSoak NOC
        </span>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation menu"
          className="lg:hidden p-2 text-slate-400 hover:text-slate-100 rounded-md"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1" aria-label="Primary Navigation">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelect(item.id);
                onCloseMobile();
              }}
              className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-md transition-colors duration-150 whitespace-nowrap shrink-0 ${
                active
                  ? 'bg-slate-800/90 text-cyan-300 border border-slate-700/80'
                  : 'text-slate-400 hover:text-slate-100 hover:bg-slate-900/70 border border-transparent'
              }`}
            >
              <span className="flex items-center gap-3">
                <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-cyan-400' : 'text-slate-500'}`} />
                <span>{item.label}</span>
              </span>
              {item.id === 'dashboard' && isTestActive && (
                <span className="text-[11px] font-mono tabular-nums text-emerald-400">LIVE</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="p-4 border-t border-slate-800/90 text-xs text-slate-500 space-y-1">
        <div className="text-slate-400 font-medium">Diagnostic Engine</div>
        <div className="font-mono tabular-nums text-[11px] text-slate-500">
          WS Binary · 64 KB Frames
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block w-[240px] shrink-0 h-screen sticky top-0">
        {navContent}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative w-[240px] max-w-[80vw] h-full z-10">{navContent}</div>
        </div>
      )}
    </>
  );
}
