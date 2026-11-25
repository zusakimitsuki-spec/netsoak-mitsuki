import { useCallback, useEffect, useRef, useState } from 'react';

export interface BackgroundKeepAliveState {
  enabled: boolean;
  active: boolean;
  webLockActive: boolean;
  audioActive: boolean;
  error: string | null;
  setEnabled: (next: boolean) => void;
  ensureActivatedFromGesture: () => void;
}

/**
 * Prevents Chromium/Firefox/Safari from throttling timers or freezing the tab
 * when the user switches to another tab, website, or desktop application.
 * Combines:
 * 1. Web Locks API ('netsoak-noc-active-session') held during active soak tests.
 * 2. Silent Web Audio API pipeline (gain = 0) started from user interaction.
 */
export function useBackgroundKeepAlive(
  isTestActive: boolean,
  defaultEnabled: boolean
): BackgroundKeepAliveState {
  const [enabled, setEnabledState] = useState<boolean>(defaultEnabled);
  const [webLockActive, setWebLockActive] = useState<boolean>(false);
  const [audioActive, setAudioActive] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<ConstantSourceNode | AudioBufferSourceNode | null>(null);
  const lockReleaseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setEnabledState(defaultEnabled);
  }, [defaultEnabled]);

  const stopAudioKeepAlive = useCallback(() => {
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.stop();
        sourceNodeRef.current.disconnect();
      } catch {
        // Ignore stop errors
      }
      sourceNodeRef.current = null;
    }
    if (audioCtxRef.current) {
      try {
        void audioCtxRef.current.close();
      } catch {
        // Ignore close errors
      }
      audioCtxRef.current = null;
    }
    setAudioActive(false);
  }, []);

  const startAudioKeepAlive = useCallback(async () => {
    if (typeof window === 'undefined') return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        const ctx = new AudioCtx();
        const gain = ctx.createGain();
        gain.gain.value = 0; // Completely silent
        gain.connect(ctx.destination);

        if (typeof ctx.createConstantSource === 'function') {
          const src = ctx.createConstantSource();
          src.offset.value = 0;
          src.connect(gain);
          src.start();
          sourceNodeRef.current = src;
        } else {
          const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.loop = true;
          src.connect(gain);
          src.start();
          sourceNodeRef.current = src;
        }
        audioCtxRef.current = ctx;
      }

      if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
      }
      setAudioActive(audioCtxRef.current.state === 'running');
      setError(null);
    } catch (err) {
      setAudioActive(false);
      setError(
        err instanceof Error
          ? err.message
          : 'Browser blocked background audio keep-alive until user interaction.'
      );
    }
  }, []);

  const releaseWebLock = useCallback(() => {
    if (lockReleaseRef.current) {
      lockReleaseRef.current();
      lockReleaseRef.current = null;
    }
    setWebLockActive(false);
  }, []);

  const acquireWebLock = useCallback(() => {
    if (typeof navigator === 'undefined' || !('locks' in navigator)) return;
    if (lockReleaseRef.current) return;

    void navigator.locks
      .request('netsoak-noc-active-session', { mode: 'exclusive' }, () => {
        setWebLockActive(true);
        return new Promise<void>((resolve) => {
          lockReleaseRef.current = resolve;
        });
      })
      .catch(() => {
        setWebLockActive(false);
      });
  }, []);

  const ensureActivatedFromGesture = useCallback(() => {
    if (!enabled) return;
    void startAudioKeepAlive();
  }, [enabled, startAudioKeepAlive]);

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      if (next && isTestActive) {
        acquireWebLock();
        void startAudioKeepAlive();
      } else if (!next) {
        stopAudioKeepAlive();
        releaseWebLock();
      }
    },
    [isTestActive, acquireWebLock, startAudioKeepAlive, stopAudioKeepAlive, releaseWebLock]
  );

  useEffect(() => {
    if (isTestActive && enabled) {
      acquireWebLock();
      void startAudioKeepAlive();
    } else {
      stopAudioKeepAlive();
      releaseWebLock();
    }
  }, [isTestActive, enabled, acquireWebLock, startAudioKeepAlive, stopAudioKeepAlive, releaseWebLock]);

  useEffect(() => {
    return () => {
      stopAudioKeepAlive();
      releaseWebLock();
    };
  }, [stopAudioKeepAlive, releaseWebLock]);

  return {
    enabled,
    active: isTestActive && enabled && (audioActive || webLockActive),
    webLockActive,
    audioActive,
    error,
    setEnabled,
    ensureActivatedFromGesture,
  };
}
