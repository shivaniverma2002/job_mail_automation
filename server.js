'use strict';

const express = require('express');
const config = require('./config');
const { runCampaign } = require('./services/campaign');
const { processBounces } = require('./services/bounces');

const app = express();
app.use(express.json());

// Only one campaign pass may run at a time (Render Cron overlap / manual trigger).
let running = false;

function authorized(req) {
  if (!config.campaignSecret) return true; // no secret configured -> open (dev only)
  const provided = req.get('x-campaign-secret') || req.query.key || '';
  return provided === config.campaignSecret;
}

app.get('/health', (req, res) => {
  res.json({ ok: true, running, time: new Date().toISOString() });
});

app.post('/api/send-campaign', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (running) {
    return res.status(409).json({ ok: false, error: 'A campaign run is already in progress' });
  }

  running = true;
  try {
    const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
    const limit = Number(req.query.limit || req.body?.limit) || undefined;
    const summary = await runCampaign({ dryRun, limit });
    res.json({ ok: true, summary });
  } catch (err) {
    console.error('Campaign failed:', err);
    res.status(500).json({ ok: false, error: (err && err.message) || String(err) });
  } finally {
    running = false;
  }
});

// Standalone bounce reconciliation (the campaign run also does this itself).
app.post('/api/process-bounces', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
    const summary = await processBounces({ dryRun });
    res.json({ ok: true, summary });
  } catch (err) {
    console.error('Bounce processing failed:', err);
    res.status(500).json({ ok: false, error: (err && err.message) || String(err) });
  }
});

app.listen(config.port, () => {
  console.log(`job-mail-automation listening on :${config.port}`);
});
