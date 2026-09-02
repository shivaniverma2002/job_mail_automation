'use strict';

const express = require('express');
const config = require('./config');
const { runCampaign } = require('./services/campaign');
const { processBounces } = require('./services/bounces');

const app = express();
app.use(express.json());

// One job at a time. `lastRun` holds the outcome of the most recent one so an
// external pinger (cron-job.org) can check results on a later request.
let running = false;
let runStartedAt = 0;
let lastRun = null;

// If a run somehow hangs (stalled IMAP/SMTP/socket), don't let its lock wedge
// the campaign forever — after this long a new trigger is allowed through.
const STALE_LOCK_MS = 15 * 60 * 1000;

function locked() {
  if (!running) return false;
  if (Date.now() - runStartedAt > STALE_LOCK_MS) {
    console.warn(`[lock] previous run stale (${Math.round((Date.now() - runStartedAt) / 1000)}s) — overriding`);
    return false;
  }
  return true;
}

function authorized(req) {
  if (!config.campaignSecret) return true; // no secret configured -> open (dev only)
  const provided = req.get('x-campaign-secret') || req.query.key || '';
  return provided === config.campaignSecret;
}

// Compact view of a run — counts only, no per-row arrays. Keeps every response
// small so an external pinger never trips a response-size limit. The full
// summary always goes to the logs; `/api/last-run?full=1` returns it verbatim.
function compactRun(r) {
  if (!r) return null;
  const s = r.summary;
  const out = { task: r.task, startedAt: r.startedAt, finishedAt: r.finishedAt, ok: r.ok };
  if (r.error) out.error = String(r.error).slice(0, 300);
  if (s) {
    out.counts = {
      considered: s.considered,
      sent: s.sent,
      failed: s.failed,
      skippedDuplicate: s.skippedDuplicate,
      skippedInvalidEmail: s.skippedInvalidEmail,
    };
    if (s.results && s.results[0]) out.firstSrNo = s.results[0].srNo;
    if (s.bounces) {
      out.bounces = {
        transport: s.bounces.transport,
        scanned: s.bounces.scanned,
        newlyBounced: (s.bounces.bounced || []).length,
        alreadyBounced: s.bounces.alreadyBounced,
        error: s.bounces.error ? String(s.bounces.error).slice(0, 200) : undefined,
      };
    }
  }
  return out;
}

// Kick work off in the background and let the caller return immediately.
// cron-job.org drops a request after ~30s, so the HTTP response can't wait for a
// multi-minute batch. Overlap is prevented by `running` (callers get 409).
function startBackground(task, fn) {
  running = true;
  runStartedAt = Date.now();
  const startedAt = new Date().toISOString();
  lastRun = { task, startedAt, finishedAt: null, ok: null };

  (async () => {
    try {
      const summary = await fn();
      lastRun = { task, startedAt, finishedAt: new Date().toISOString(), ok: true, summary };
      console.log(`[${task}] done ${JSON.stringify(summary)}`);
    } catch (err) {
      const error = (err && err.message) || String(err);
      lastRun = { task, startedAt, finishedAt: new Date().toISOString(), ok: false, error };
      console.error(`[${task}] failed:`, err);
    } finally {
      running = false;
    }
  })();
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    running,
    runningForMs: running ? Date.now() - runStartedAt : 0,
    lastRun: compactRun(lastRun),
    time: new Date().toISOString(),
  });
});

app.get('/api/last-run', (req, res) => {
  const full = req.query.full === '1' || req.query.full === 'true';
  res.json({ ok: true, running, lastRun: full ? lastRun : compactRun(lastRun) });
});

app.post('/api/send-campaign', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (locked()) return res.status(409).json({ ok: false, error: 'A run is already in progress' });

  const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
  const limit = Number(req.query.limit || req.body?.limit) || undefined;
  startBackground('send-campaign', () => runCampaign({ dryRun, limit }));
  res.status(202).json({ ok: true, started: true, task: 'send-campaign' });
});

app.post('/api/process-bounces', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (locked()) return res.status(409).json({ ok: false, error: 'A run is already in progress' });

  const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
  startBackground('process-bounces', () => processBounces({ dryRun }));
  res.status(202).json({ ok: true, started: true, task: 'process-bounces' });
});

// Small JSON errors instead of Express's HTML stack-trace page.
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('unhandled error:', err);
  res.status(500).json({ ok: false, error: (err && err.message ? String(err.message) : String(err)).slice(0, 300) });
});

app.listen(config.port, () => {
  console.log(`job-mail-automation listening on :${config.port} (transport: ${config.mailTransport})`);
});
