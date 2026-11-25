import { useCallback, useEffect, useRef, useState } from 'react';

export interface WakeLockState {
  supported: boolean;
  enabled: boolean;
  active: boolean;
  error: string | null;
  setEnabled: (next: boolean) => void;
}

export function useWakeLock(isTestActive: boolean, defaultEnabled: boolean): WakeLockState {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  const [enabled, setEnabled] = useState<boolean>(defaultEnabled);
  const [active, setActive] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    setEnabled(defaultEnabled);
  }, [defaultEnabled]);

  const releaseLock = useCallback(async () => {
    if (sentinelRef.current) {
      try {
        await sentinelRef.current.release();
      } catch {
        // Ignore release failures
      }
      sentinelRef.current = null;
    }
    setActive(false);
  }, []);

  const acquireLock = useCallback(async () => {
    if (!supported || !enabled || !isTestActive) {
      return;
    }
    if (document.visibilityState !== 'visible') {
      return;
    }
    if (sentinelRef.current && !sentinelRef.current.released) {
      setActive(true);
      return;
    }

    try {
      const sentinel = await navigator.wakeLock.request('screen');
      sentinelRef.current = sentinel;
      setActive(true);
      setError(null);
      sentinel.addEventListener('release', () => {
        setActive(false);
        sentinelRef.current = null;
      });
    } catch (err) {
      setActive(false);
      setError(err instanceof Error ? err.message : 'Wake Lock request was denied.');
    }
  }, [supported, enabled, isTestActive]);

  useEffect(() => {
    if (enabled && isTestActive) {
      void acquireLock();
    } else {
      void releaseLock();
    }
  }, [enabled, isTestActive, acquireLock, releaseLock]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && enabled && isTestActive) {
        void acquireLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      void releaseLock();
    };
  }, [enabled, isTestActive, acquireLock, releaseLock]);

  return {
    supported,
    enabled,
    active,
    error,
    setEnabled,
  };
}
