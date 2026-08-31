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
let lastRun = null;

function authorized(req) {
  if (!config.campaignSecret) return true; // no secret configured -> open (dev only)
  const provided = req.get('x-campaign-secret') || req.query.key || '';
  return provided === config.campaignSecret;
}

// Kick work off in the background and let the caller return immediately.
// cron-job.org drops a request after ~30s, so the HTTP response can't wait for a
// multi-minute batch. Overlap is prevented by `running` (callers get 409).
function startBackground(task, fn) {
  running = true;
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
  res.json({ ok: true, running, lastRun, time: new Date().toISOString() });
});

app.get('/api/last-run', (req, res) => {
  res.json({ ok: true, running, lastRun });
});

app.post('/api/send-campaign', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (running) return res.status(409).json({ ok: false, error: 'A run is already in progress', lastRun });

  const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
  const limit = Number(req.query.limit || req.body?.limit) || undefined;
  startBackground('send-campaign', () => runCampaign({ dryRun, limit }));
  res.status(202).json({ ok: true, started: true, task: 'send-campaign' });
});

app.post('/api/process-bounces', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (running) return res.status(409).json({ ok: false, error: 'A run is already in progress', lastRun });

  const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
  startBackground('process-bounces', () => processBounces({ dryRun }));
  res.status(202).json({ ok: true, started: true, task: 'process-bounces' });
});

app.listen(config.port, () => {
  console.log(`job-mail-automation listening on :${config.port}`);
});
