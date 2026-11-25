import { escapeCsvField } from '../../shared/networkMath';
import type {
  AppSettings,
  StoredSessionSummary,
  TelemetrySample,
  TestEvent,
} from '../../shared/types';

const DB_NAME = 'netsoak_noc_db';
const DB_VERSION = 1;

const STORE_SESSIONS = 'sessions';
const STORE_SAMPLES = 'samples';
const STORE_EVENTS = 'events';
const STORE_SETTINGS = 'settings';

export const DEFAULT_SETTINGS: AppSettings = {
  keepScreenAwakeDefault: true,
  backgroundKeepAliveDefault: true,
  maxReconnectDelaySeconds: 60,
  initialReconnectDelaySeconds: 5,
  defaultChartRange: '60s',
  fluctuationThresholdPercent: 35,
  autoScrollEventLog: true,
};

export class StorageQuotaError extends Error {
  constructor(message = 'Browser IndexedDB storage quota exceeded.') {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported in this environment.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const sessionStore = db.createObjectStore(STORE_SESSIONS, { keyPath: 'session_id' });
        sessionStore.createIndex('by_created_at', 'created_at', { unique: false });
        sessionStore.createIndex('by_status', 'status', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_SAMPLES)) {
        const sampleStore = db.createObjectStore(STORE_SAMPLES, {
          keyPath: 'id',
          autoIncrement: true,
        });
        sampleStore.createIndex('by_session', 'session_id', { unique: false });
        sampleStore.createIndex('by_session_elapsed', ['session_id', 'elapsed_seconds'], {
          unique: false,
        });
      }

      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        const eventStore = db.createObjectStore(STORE_EVENTS, {
          keyPath: 'id',
          autoIncrement: true,
        });
        eventStore.createIndex('by_session', 'session_id', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('Failed to open IndexedDB.'));
    };
  });

  return dbPromise;
}

function wrapRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      const err = req.error;
      if (err && err.name === 'QuotaExceededError') {
        reject(new StorageQuotaError());
      } else {
        reject(err || new Error('IndexedDB request failed.'));
      }
    };
  });
}

function wrapTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      const err = tx.error;
      if (err && err.name === 'QuotaExceededError') {
        reject(new StorageQuotaError());
      } else {
        reject(err || new Error('IndexedDB transaction failed.'));
      }
    };
    tx.onabort = () => {
      const err = tx.error;
      if (err && err.name === 'QuotaExceededError') {
        reject(new StorageQuotaError());
      } else {
        reject(err || new Error('IndexedDB transaction aborted.'));
      }
    };
  });
}

export async function saveSessionSummary(summary: StoredSessionSummary): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_SESSIONS, 'readwrite');
  tx.objectStore(STORE_SESSIONS).put(summary);
  await wrapTransaction(tx);
}

export async function getSessionSummary(sessionId: string): Promise<StoredSessionSummary | undefined> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_SESSIONS, 'readonly');
  return wrapRequest(tx.objectStore(STORE_SESSIONS).get(sessionId));
}

export async function getAllSessions(): Promise<StoredSessionSummary[]> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_SESSIONS, 'readonly');
  const all: StoredSessionSummary[] = await wrapRequest(tx.objectStore(STORE_SESSIONS).getAll());
  return all.sort((a, b) => b.created_at - a.created_at);
}

export async function addSamplesBatch(samples: TelemetrySample[]): Promise<void> {
  if (samples.length === 0) return;
  const db = await openDatabase();
  const tx = db.transaction(STORE_SAMPLES, 'readwrite');
  const store = tx.objectStore(STORE_SAMPLES);
  for (const sample of samples) {
    const clean = { ...sample };
    delete clean.id;
    store.add(clean);
  }
  await wrapTransaction(tx);
}

export async function addEventsBatch(events: TestEvent[]): Promise<void> {
  if (events.length === 0) return;
  const db = await openDatabase();
  const tx = db.transaction(STORE_EVENTS, 'readwrite');
  const store = tx.objectStore(STORE_EVENTS);
  for (const evt of events) {
    const clean = { ...evt };
    delete clean.id;
    store.add(clean);
  }
  await wrapTransaction(tx);
}

export async function getSessionEvents(sessionId: string): Promise<TestEvent[]> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_EVENTS, 'readonly');
  const index = tx.objectStore(STORE_EVENTS).index('by_session');
  const events: TestEvent[] = await wrapRequest(index.getAll(IDBKeyRange.only(sessionId)));
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Streams IndexedDB sample records via cursor and returns at most `maxPoints`
 * downsampled points so 86,400-record 24h sessions never exhaust memory.
 */
export async function getSessionSamplesDownsampled(
  sessionId: string,
  maxPoints = 240
): Promise<TelemetrySample[]> {
  const db = await openDatabase();

  const totalCount = await new Promise<number>((resolve, reject) => {
    const tx = db.transaction(STORE_SAMPLES, 'readonly');
    const idx = tx.objectStore(STORE_SAMPLES).index('by_session');
    const countReq = idx.count(IDBKeyRange.only(sessionId));
    countReq.onsuccess = () => resolve(countReq.result);
    countReq.onerror = () => reject(countReq.error);
  });

  if (totalCount === 0) return [];

  if (totalCount <= maxPoints) {
    const tx = db.transaction(STORE_SAMPLES, 'readonly');
    const idx = tx.objectStore(STORE_SAMPLES).index('by_session');
    const rows: TelemetrySample[] = await wrapRequest(idx.getAll(IDBKeyRange.only(sessionId)));
    return rows.sort((a, b) => a.elapsed_seconds - b.elapsed_seconds);
  }

  const bucketSize = totalCount / maxPoints;
  const result: TelemetrySample[] = [];

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SAMPLES, 'readonly');
    const idx = tx.objectStore(STORE_SAMPLES).index('by_session');
    const req = idx.openCursor(IDBKeyRange.only(sessionId));

    let currentBucketIdx = 0;
    let cursorPos = 0;
    let dlSum = 0;
    let dlCount = 0;
    let ulSum = 0;
    let ulCount = 0;
    let hasDisconnection = false;
    let lastSample: TelemetrySample | null = null;

    const flushBucket = () => {
      if (!lastSample) return;
      result.push({
        ...lastSample,
        download_mbps: dlCount > 0 ? Number((dlSum / dlCount).toFixed(2)) : null,
        upload_mbps: ulCount > 0 ? Number((ulSum / ulCount).toFixed(2)) : null,
        connection_state:
          hasDisconnection && dlCount === 0 && ulCount === 0
            ? 'reconnecting'
            : lastSample.connection_state,
      });
      dlSum = 0;
      dlCount = 0;
      ulSum = 0;
      ulCount = 0;
      hasDisconnection = false;
      lastSample = null;
    };

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        flushBucket();
        resolve();
        return;
      }

      const sample = cursor.value as TelemetrySample;
      const targetBucket = Math.min(maxPoints - 1, Math.floor(cursorPos / bucketSize));
      if (targetBucket > currentBucketIdx) {
        flushBucket();
        currentBucketIdx = targetBucket;
      }

      if (sample.download_mbps !== null) {
        dlSum += sample.download_mbps;
        dlCount++;
      }
      if (sample.upload_mbps !== null) {
        ulSum += sample.upload_mbps;
        ulCount++;
      }
      if (sample.connection_state === 'reconnecting' || sample.connection_state === 'disconnected') {
        hasDisconnection = true;
      }
      lastSample = sample;
      cursorPos++;
      cursor.continue();
    };

    req.onerror = () => reject(req.error);
  });

  return result;
}

/**
 * Streams all session samples from IndexedDB via cursor in chunks to construct
 * a valid RFC-4180 CSV Blob without building a single giant concatenated string.
 */
export async function buildSessionCsvBlob(sessionId: string): Promise<{ blob: Blob; rowCount: number }> {
  const db = await openDatabase();
  const header = [
    'session_id',
    'timestamp_iso',
    'timestamp_ms',
    'elapsed_seconds',
    'download_mbps',
    'upload_mbps',
    'download_bytes',
    'upload_bytes',
    'status',
    'connection_state',
    'active_streams',
  ].join(',') + '\n';

  const parts: string[] = [header];
  let chunkLines: string[] = [];
  let rowCount = 0;

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SAMPLES, 'readonly');
    const idx = tx.objectStore(STORE_SAMPLES).index('by_session');
    const req = idx.openCursor(IDBKeyRange.only(sessionId));

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        if (chunkLines.length > 0) {
          parts.push(chunkLines.join(''));
          chunkLines = [];
        }
        resolve();
        return;
      }

      const s = cursor.value as TelemetrySample;
      const line =
        [
          escapeCsvField(s.session_id),
          escapeCsvField(new Date(s.timestamp).toISOString()),
          escapeCsvField(s.timestamp),
          escapeCsvField(s.elapsed_seconds),
          escapeCsvField(s.download_mbps !== null ? s.download_mbps.toFixed(3) : ''),
          escapeCsvField(s.upload_mbps !== null ? s.upload_mbps.toFixed(3) : ''),
          escapeCsvField(s.download_bytes),
          escapeCsvField(s.upload_bytes),
          escapeCsvField(s.status),
          escapeCsvField(s.connection_state),
          escapeCsvField(s.active_streams),
        ].join(',') + '\n';

      chunkLines.push(line);
      rowCount++;

      if (chunkLines.length >= 500) {
        parts.push(chunkLines.join(''));
        chunkLines = [];
      }

      cursor.continue();
    };

    req.onerror = () => reject(req.error);
  });

  return {
    blob: new Blob(parts, { type: 'text/csv;charset=utf-8;' }),
    rowCount,
  };
}

export async function deleteSessionData(sessionId: string): Promise<void> {
  const db = await openDatabase();

  // Delete session metadata
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    tx.objectStore(STORE_SESSIONS).delete(sessionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Delete samples by cursor
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SAMPLES, 'readwrite');
    const idx = tx.objectStore(STORE_SAMPLES).index('by_session');
    const req = idx.openKeyCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      tx.objectStore(STORE_SAMPLES).delete(cursor.primaryKey);
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Delete events by cursor
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_EVENTS, 'readwrite');
    const idx = tx.objectStore(STORE_EVENTS).index('by_session');
    const req = idx.openKeyCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      tx.objectStore(STORE_EVENTS).delete(cursor.primaryKey);
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAllHistory(): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction([STORE_SESSIONS, STORE_SAMPLES, STORE_EVENTS], 'readwrite');
  tx.objectStore(STORE_SESSIONS).clear();
  tx.objectStore(STORE_SAMPLES).clear();
  tx.objectStore(STORE_EVENTS).clear();
  await wrapTransaction(tx);
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_SETTINGS, 'readonly');
    const row = (await wrapRequest(tx.objectStore(STORE_SETTINGS).get('app_settings'))) as
      | { key: string; value: AppSettings }
      | undefined;
    if (row && row.value) {
      return { ...DEFAULT_SETTINGS, ...row.value };
    }
  } catch {
    // Fall back to default settings
  }
  return { ...DEFAULT_SETTINGS };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_SETTINGS, 'readwrite');
  tx.objectStore(STORE_SETTINGS).put({ key: 'app_settings', value: settings });
  await wrapTransaction(tx);
}

export async function getStorageEstimate(): Promise<{ usageBytes: number; quotaBytes: number } | null> {
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      return {
        usageBytes: est.usage ?? 0,
        quotaBytes: est.quota ?? 0,
      };
    } catch {
      return null;
    }
  }
  return null;
}
