# NetSoak NOC — Network Soak Testing & Bandwidth Monitoring Platform

## 1. Project Overview

**NetSoak NOC** is a full-stack network diagnostic and soak testing platform designed to evaluate internet connection stability, sustained download throughput, sustained upload throughput, and bidirectional transfer reliability for up to **24 continuous hours**.

Unlike short-burst consumer speed tests, NetSoak NOC tracks long-term throughput variance, detects intermittent disconnections, records outage windows separately from active testing time, automatically reconnects with exponential backoff, and persists second-by-second telemetry to browser IndexedDB for streaming CSV export.

---

## 2. Features

- **Download, Upload & Bidirectional Testing**: Full-duplex binary WebSocket streaming (`perMessageDeflate: false`) with 64 KB incompressible random `Uint8Array` payloads.
- **Rate-Limited & Uncapped Modes**: Monotonic token-bucket rate limiter supporting `0 Mbps` uncapped testing (bounded by server safety caps) or exact target Mbps pacing.
- **1–4 Parallel WebSocket Streams**: Concurrent socket streams to overcome single-connection TCP window bottlenecks on high-latency links.
- **Dedicated Web Worker Engine**: Isolates WebSocket streaming, backpressure (`bufferedAmount`), timing, and reconnection loops from React UI rendering.
- **Automatic Reconnection & Session Recovery**: Exponential backoff starting at 5 seconds, preserving the original session ID, pausing active duration during outages, and recovering interrupted tests after browser reload.
- **IndexedDB Long-Duration Logging**: Batched 1-second persistence supporting up to 86,400 samples per 24-hour test, cursor-streamed RFC-4180 CSV export, and downsampled timeline visualization.
- **Screen Wake Lock Integration**: Optional `Keep Screen Awake` toggle with automatic visibility reacquisition.
- **Server Safety & Abuse Controls**: Cryptographic per-session `wsToken` validation, Balanced server defaults (24h max, 500 Mbps cap, 2 active sessions/IP), IP rate limiting, and graceful shutdown.

---

## 3. Technology Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4, Recharts, Lucide React, Web Workers, IndexedDB, Screen Wake Lock API.
- **Backend**: Node.js 22+, Express.js, TypeScript (`tsx`), `ws` WebSocket server.
- **Testing & Containers**: Vitest, Docker, Docker Compose.

---

## 4. System Requirements

- **Node.js**: v20.x or v22.x LTS
- **npm**: v10.x or newer
- **OS**: Windows 10/11, macOS 13+, or Linux (Ubuntu/Debian/Alpine)
- **Browser**: Modern Chromium, Firefox, or Safari with Web Worker and IndexedDB support (Screen Wake Lock requires HTTPS or `localhost` in supported browsers)

---

## 5. Installation Instructions

```bash
git clone <your-repository-url> netsoak-noc
cd netsoak-noc
npm install
```

---

## 6. Environment Variable Configuration

Copy `.env.example` to `.env` and adjust limits for your environment:

**Linux / macOS:**
```bash
cp .env.example .env
```

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```

Key variables:
- `PORT=3000`: HTTP and WebSocket port.
- `MAX_DURATION_SECONDS=86400`: Maximum permitted soak test duration (24 hours).
- `MAX_BANDWIDTH_MBPS=500`: Balanced safety cap in Mbps (`0` disables the server cap for private infrastructure).
- `MAX_PARALLEL_STREAMS=4`: Maximum concurrent WebSocket streams per test.
- `MAX_ACTIVE_SESSIONS_PER_CLIENT=2`: Maximum active sessions per client IP.
- `MAX_TRANSFER_GB=0`: Optional server-side data cap per session (`0` = disabled).

---

## 7. Running Locally in Development

Because NetSoak NOC uses a unified Express + WebSocket + Vite middleware server on port `3000`:

```bash
npm run dev
```

Open `http://localhost:3000` in your browser.

---

## 8. Building and Running Production Server Locally

Build the optimized Vite frontend bundle and launch the production Node.js server:

```bash
npm run build
npm run start
```

Verify health:
```bash
curl http://localhost:3000/api/health
```

---

## 9. Running with Docker Compose

Build and start the containerized service on port `3000`:

```bash
docker compose up --build -d
```

Inspect logs and health:
```bash
docker compose logs -f netsoak
curl http://localhost:3000/api/health
```

Stop the container:
```bash
docker compose down
```

---

## 10. Frontend-to-Backend Connection Architecture

The React client communicates with the Express backend on the same origin:
- **REST API**: `/api/health`, `/api/sessions`, `/api/sessions/:id/start`, `/api/sessions/:id/stop`, `/api/sessions/:id/status`
- **WebSocket Engine**: `ws://<host>/ws` (or `wss://<host>/ws` over HTTPS) authenticated with `sessionId` and `wsToken`.

---

## 11. Deploying to a VPS

1. Provision an Ubuntu/Debian VPS with Docker and Docker Compose installed.
2. Clone the repository and create `.env` (adjust `MAX_BANDWIDTH_MBPS` as needed for your VPS NIC and egress allowance).
3. Run `docker compose up --build -d`.
4. Place Nginx or Caddy in front of `127.0.0.1:3000` for TLS termination.

---

## 12. Configuring Secure WebSockets (WSS) with Nginx

Sample Nginx server block supporting HTTP/2, TLS, and long-lived WebSocket upgrades (`/ws`):

```nginx
server {
    listen 443 ssl http2;
    server_name netsoak.example.com;

    ssl_certificate     /etc/letsencrypt/live/netsoak.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/netsoak.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Prevent idle proxy timeouts on rate-limited soak tests
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

---

## 13. Troubleshooting Common Errors

- **429 Maximum Concurrent Active Sessions**: Wait for prior tests to finish or click **STOP TEST**. By default, Balanced limits allow 2 active sessions per client IP.
- **401 Unauthorized / Expired Session**: If the backend server restarted mid-test, active session tokens in memory are cleared. Dismiss the recovery prompt and start a new test.
- **Wake Lock Unavailable**: Browsers restrict Screen Wake Lock to HTTPS (or `localhost`) and require the tab to be visible.
- **IndexedDB Quota Warning**: Clear old 24-hour test records in **Settings -> Clear All History** or delete individual runs from **Test History**.

---

## 14. Understanding Bandwidth Measurements & Data Consumption

- **Throughput Formula**:
  `Mbps = (Transferred Bytes × 8) / (Elapsed Seconds × 1,000,000)`
  Measurements reflect **application-level WebSocket payload throughput**, which is slightly lower than raw physical NIC line speed due to TCP, TLS, and WebSocket framing overhead.
- **Data Estimator Formula**:
  `Total GB = (Mbps × Seconds × 1,000,000) / (8 × 1,000,000,000)`
  For example, a sustained 100 Mbps bidirectional soak test transfers approximately **90 GB per hour** (45 GB down + 45 GB up).

---

## Running Automated Tests

```bash
npm run test
npm run lint
```
