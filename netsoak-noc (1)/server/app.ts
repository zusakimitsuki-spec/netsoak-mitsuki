import express, { type NextFunction, type Request, type Response } from 'express';
import type { ServerHealthResponse } from '../shared/types';
import type { ServerConfig } from './config';
import { SessionManager, SessionValidationError } from './sessionManager';
import { extractClientIp } from './wsEngine';

interface RateBucket {
  count: number;
  resetAt: number;
}

export function createApp(sessionManager: SessionManager, config: ServerConfig) {
  const app = express();
  const startedAt = Date.now();
  const apiRateMap = new Map<string, RateBucket>();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Security headers
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(express.json({ limit: '32kb' }));

  // Basic per-IP API rate limiter
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const ip = extractClientIp(req);
    const now = Date.now();
    const entry = apiRateMap.get(ip);
    if (!entry || now > entry.resetAt) {
      apiRateMap.set(ip, { count: 1, resetAt: now + config.rateLimitWindowMs });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > config.rateLimitMaxRequests) {
      res.status(429).json({ error: 'Rate limit exceeded. Please wait before issuing more requests.' });
      return;
    }
    next();
  });

  const extractToken = (req: Request): string | null => {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return auth.slice(7).trim();
    }
    const headerToken = req.headers['x-session-token'];
    if (typeof headerToken === 'string' && headerToken.length > 0) {
      return headerToken.trim();
    }
    return null;
  };

  // Health & Server Limits endpoint
  app.get('/api/health', (_req: Request, res: Response) => {
    const mem = process.memoryUsage();
    const stats = sessionManager.getStats();
    const payload: ServerHealthResponse = {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      timestamp: Date.now(),
      activeSessions: stats.activeSessions,
      activeStreams: stats.activeStreams,
      memoryMb: {
        rss: Math.round(mem.rss / (1024 * 1024)),
        heapUsed: Math.round(mem.heapUsed / (1024 * 1024)),
        heapTotal: Math.round(mem.heapTotal / (1024 * 1024)),
      },
      limits: config.limits,
    };
    res.json(payload);
  });

  // Create validated soak test session
  app.post('/api/sessions', (req: Request, res: Response) => {
    try {
      const clientIp = extractClientIp(req);
      const session = sessionManager.createSession(req.body, clientIp);
      res.status(201).json({
        sessionId: session.sessionId,
        wsToken: session.wsToken,
        config: session.config,
        limits: config.limits,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      });
    } catch (err) {
      if (err instanceof SessionValidationError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: 'Failed to create test session.' });
    }
  });

  // Authenticated session inspection
  app.get('/api/sessions/:id', (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const session = sessionManager.verifyToken(id, extractToken(req));
    if (!session) {
      res.status(401).json({ error: 'Invalid or unauthorized session.' });
      return;
    }
    res.json(sessionManager.toStatusDto(session));
  });

  app.get('/api/sessions/:id/status', (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const session = sessionManager.verifyToken(id, extractToken(req));
    if (!session) {
      res.status(401).json({ error: 'Invalid or unauthorized session.' });
      return;
    }
    res.json(sessionManager.toStatusDto(session));
  });

  app.post('/api/sessions/:id/start', (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const session = sessionManager.verifyToken(id, extractToken(req));
    if (!session) {
      res.status(401).json({ error: 'Invalid or unauthorized session.' });
      return;
    }
    try {
      const updated = sessionManager.startSession(session.sessionId);
      res.json(sessionManager.toStatusDto(updated));
    } catch (err) {
      if (err instanceof SessionValidationError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: 'Failed to start session.' });
    }
  });

  app.post('/api/sessions/:id/stop', (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const session = sessionManager.verifyToken(id, extractToken(req));
    if (!session) {
      res.status(401).json({ error: 'Invalid or unauthorized session.' });
      return;
    }
    try {
      const finalStatus = req.body?.reason === 'completed' ? 'completed' : 'stopped';
      const updated = sessionManager.stopSession(session.sessionId, finalStatus);
      res.json(sessionManager.toStatusDto(updated));
    } catch (err) {
      if (err instanceof SessionValidationError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: 'Failed to stop session.' });
    }
  });

  return app;
}
