import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerConfig } from './server/config';
import { SessionManager } from './server/sessionManager';
import { attachWebSocketEngine } from './server/wsEngine';
import { createApp } from './server/app';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function bootstrap() {
  const config = loadServerConfig();
  const sessionManager = new SessionManager(config);
  sessionManager.startCleanupLoop();

  const app = createApp(sessionManager, config);
  const httpServer = http.createServer(app);
  const wss = attachWebSocketEngine(httpServer, sessionManager, config);

  if (config.nodeEnv !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[NetSoak NOC] Server listening on http://0.0.0.0:${config.port} (${config.nodeEnv}) | Max duration: ${config.limits.maxDurationSeconds}s | Max bandwidth cap: ${config.limits.maxBandwidthMbps === 0 ? 'Uncapped' : `${config.limits.maxBandwidthMbps} Mbps`}`
    );
  });

  const shutdown = (signal: string) => {
    console.log(`[NetSoak NOC] Received ${signal}. Shutting down gracefully...`);
    sessionManager.closeAll();
    wss.close(() => {
      httpServer.close(() => {
        console.log('[NetSoak NOC] Shutdown complete.');
        process.exit(0);
      });
    });
    setTimeout(() => {
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[NetSoak NOC] Fatal startup error:', err);
  process.exit(1);
});
