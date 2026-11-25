export function AboutPage() {
  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="font-display text-2xl font-semibold text-slate-100">
          Measurement Methodology &amp; Architecture
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Technical reference for interpreting NetSoak NOC bandwidth measurements and operational
          constraints.
        </p>
      </div>

      <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-6 space-y-5 text-sm text-slate-300 leading-relaxed">
        <section className="space-y-2">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Application-Level WebSocket Throughput vs Physical Line Speed
          </h2>
          <p className="text-slate-400">
            NetSoak NOC measures <strong className="text-slate-200">application-level WebSocket binary throughput</strong>{' '}
            using incompressible 64 KB random payloads with <code className="font-mono text-cyan-300">perMessageDeflate: false</code>.
            Measured values represent payload bytes delivered per second at the application socket
            layer rather than raw Layer-1/Layer-2 NIC line speed. TCP headers, TLS encryption
            framing, WebSocket frame headers, and browser event-loop scheduling introduce small
            protocol overhead.
          </p>
          <div className="bg-[#060A12] border border-slate-800 rounded-md p-3.5 font-mono text-xs text-cyan-300">
            Mbps = (Transferred Payload Bytes × 8) / (Elapsed Monotonic Seconds × 1,000,000)
          </div>
        </section>

        <section className="space-y-2 pt-3 border-t border-slate-800/80">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Token-Bucket Rate Limiting &amp; Uncapped Mode
          </h2>
          <p className="text-slate-400">
            When a target Mbps is configured, NetSoak NOC enforces a monotonic token-bucket rate
            limiter independently for download (server-side) and upload (Web Worker) streams. The
            interface always distinguishes your <strong className="text-slate-200">configured target</strong> from{' '}
            <strong className="text-slate-200">actual measured throughput</strong>. Setting 0 Mbps
            enables uncapped mode up to the server&apos;s configured safety ceiling.
          </p>
        </section>

        <section className="space-y-2 pt-3 border-t border-slate-800/80">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Data Usage Estimation
          </h2>
          <p className="text-slate-400">
            Pre-test volume estimates use decimal gigabytes (1 GB = 1,000,000,000 bytes) according
            to the formula:
          </p>
          <div className="bg-[#060A12] border border-slate-800 rounded-md p-3.5 font-mono text-xs text-emerald-300">
            Total GB = (Mbps × Duration Seconds × 1,000,000) / (8 × 1,000,000,000)
          </div>
        </section>

        <section className="space-y-2 pt-3 border-t border-slate-800/80">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Web Workers, Screen Wake Lock &amp; Long-Duration Reliability
          </h2>
          <p className="text-slate-400">
            All binary streaming runs inside a dedicated Web Worker to isolate network timers from
            UI rendering, and 1-second telemetry rows are batched into IndexedDB (supporting up to
            86,400 samples across a 24-hour soak test without holding large arrays in memory).
            Screen Wake Lock prevents normal display dimming where supported, though operating
            systems and browsers may still throttle background tabs or suspend hardware during
            lid-close/sleep events. Visibility transitions are explicitly logged in the Session Event
            Log.
          </p>
        </section>

        <section className="space-y-2 pt-3 border-t border-slate-800/80">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Authorized Testing Notice
          </h2>
          <p className="text-slate-400">
            Only execute sustained soak tests against infrastructure you own or have explicit
            authorization to test. Extended high-throughput runs can saturate shared links and incur
            substantial metered bandwidth charges.
          </p>
        </section>
      </div>
    </div>
  );
}
