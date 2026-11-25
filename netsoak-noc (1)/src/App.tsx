import { useState } from 'react';
import type { NavSection, TestConfig } from '../shared/types';
import { ConfirmModal } from './components/ConfirmModal';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { useBackgroundKeepAlive } from './hooks/useBackgroundKeepAlive';
import { useSoakEngine } from './hooks/useSoakEngine';
import { useWakeLock } from './hooks/useWakeLock';
import { AboutPage } from './pages/AboutPage';
import { DashboardPage } from './pages/DashboardPage';
import { NewTestPage } from './pages/NewTestPage';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsPage } from './pages/SettingsPage';
import { TestHistoryPage } from './pages/TestHistoryPage';

export default function App() {
  const [activeSection, setActiveSection] = useState<NavSection>('dashboard');
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [confirmStopOpen, setConfirmStopOpen] = useState(false);

  const engine = useSoakEngine();
  const wakeLock = useWakeLock(engine.isRunning, engine.settings.keepScreenAwakeDefault);
  const backgroundKeepAlive = useBackgroundKeepAlive(
    engine.isRunning,
    engine.settings.backgroundKeepAliveDefault
  );

  const handleStartTest = async (config: TestConfig) => {
    backgroundKeepAlive.ensureActivatedFromGesture();
    await engine.startNewTest(config);
    setActiveSection('dashboard');
  };

  const handleOpenReport = (sessionId: string) => {
    setSelectedReportId(sessionId);
    setActiveSection('reports');
  };

  const handleTopBarAction = () => {
    if (engine.isRunning) {
      setConfirmStopOpen(true);
    } else {
      setActiveSection('new-test');
    }
  };

  return (
    <div className="min-h-screen bg-[#060A12] text-slate-100 flex">
      <Sidebar
        activeSection={activeSection}
        onSelect={setActiveSection}
        isTestActive={engine.isRunning}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar
          activeSection={activeSection}
          isTestActive={engine.isRunning}
          serverHealth={engine.serverHealth}
          serverError={engine.serverError}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
          onPrimaryAction={handleTopBarAction}
        />

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
          {activeSection === 'dashboard' && (
            <DashboardPage
              activeMetrics={engine.activeMetrics}
              rollingSamples={engine.rollingSamples}
              liveEvents={engine.liveEvents}
              history={engine.history}
              serverHealth={engine.serverHealth}
              serverError={engine.serverError}
              settings={engine.settings}
              wakeLock={wakeLock}
              backgroundKeepAlive={backgroundKeepAlive}
              quotaWarning={engine.quotaWarning}
              recoverableSession={engine.recoverableSession}
              onResumeRecovered={() => {
                backgroundKeepAlive.ensureActivatedFromGesture();
                void engine.resumeRecoveredSession();
              }}
              onDismissRecovered={() => void engine.dismissRecoveredSession()}
              onStopTest={() => void engine.stopActiveTest()}
              onGoToNewTest={() => setActiveSection('new-test')}
              onOpenReport={handleOpenReport}
              onExportCsv={(id, createdAt) => void engine.exportSessionCsv(id, createdAt)}
            />
          )}

          {activeSection === 'new-test' && (
            <NewTestPage
              serverHealth={engine.serverHealth}
              isRunning={engine.isRunning}
              isStarting={engine.isStarting}
              onStartTest={handleStartTest}
              onGoToDashboard={() => setActiveSection('dashboard')}
            />
          )}

          {activeSection === 'history' && (
            <TestHistoryPage
              history={engine.history}
              onOpenReport={handleOpenReport}
              onExportCsv={(id, createdAt) => void engine.exportSessionCsv(id, createdAt)}
              onDeleteSession={engine.deleteHistorySession}
              onGoToNewTest={() => setActiveSection('new-test')}
            />
          )}

          {activeSection === 'reports' && (
            <ReportsPage
              history={engine.history}
              selectedSessionId={selectedReportId}
              onSelectSessionId={setSelectedReportId}
              onExportCsv={(id, createdAt) => void engine.exportSessionCsv(id, createdAt)}
              onGoToNewTest={() => setActiveSection('new-test')}
            />
          )}

          {activeSection === 'settings' && (
            <SettingsPage
              settings={engine.settings}
              onUpdateSettings={engine.updateAppSettings}
              serverHealth={engine.serverHealth}
              onRefreshHealth={engine.refreshHealth}
              onHistoryCleared={engine.refreshHistory}
            />
          )}

          {activeSection === 'about' && <AboutPage />}
        </main>
      </div>

      <ConfirmModal
        open={confirmStopOpen}
        title="Stop Active Soak Test"
        description="Immediately terminate all active WebSocket test streams and finalize this session's recorded metrics?"
        confirmLabel="STOP TEST"
        confirmTone="danger"
        onCancel={() => setConfirmStopOpen(false)}
        onConfirm={() => {
          setConfirmStopOpen(false);
          void engine.stopActiveTest();
        }}
      />
    </div>
  );
}
