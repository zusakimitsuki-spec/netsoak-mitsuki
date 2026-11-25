import type {
  CreateSessionResponse,
  ServerHealthResponse,
  ServerSessionStatus,
  TestConfig,
} from '../../shared/types';

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string }).error || `Request failed with HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export async function fetchServerHealth(): Promise<ServerHealthResponse> {
  const res = await fetch('/api/health', { cache: 'no-store' });
  return parseJsonOrThrow<ServerHealthResponse>(res);
}

export async function createTestSession(config: TestConfig): Promise<CreateSessionResponse> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return parseJsonOrThrow<CreateSessionResponse>(res);
}

export async function startServerSession(
  sessionId: string,
  wsToken: string
): Promise<ServerSessionStatus> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/start`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${wsToken}`,
      'Content-Type': 'application/json',
    },
  });
  return parseJsonOrThrow<ServerSessionStatus>(res);
}

export async function stopServerSession(
  sessionId: string,
  wsToken: string,
  reason: 'stopped' | 'completed' = 'stopped'
): Promise<ServerSessionStatus> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${wsToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reason }),
  });
  return parseJsonOrThrow<ServerSessionStatus>(res);
}

export async function fetchServerSessionStatus(
  sessionId: string,
  wsToken: string
): Promise<ServerSessionStatus> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/status`, {
    headers: {
      Authorization: `Bearer ${wsToken}`,
    },
    cache: 'no-store',
  });
  return parseJsonOrThrow<ServerSessionStatus>(res);
}

export function getWebSocketBaseUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}
