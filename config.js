'use strict';

require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(v).trim();
}

function bool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

function int(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

// How mail is sent and how bounces are read:
//   smtp      (default) Gmail SMTP + App Password + IMAP. Simple, works locally.
//             Needs outbound ports 465 and 993 — BLOCKED on Render.
//   gmail_api Gmail API over HTTPS/443 for both sending and bounce reading.
//             Works on Render. Needs GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN.
const mailTransport =
  (process.env.MAIL_TRANSPORT || 'smtp').toLowerCase() === 'gmail_api' ? 'gmail_api' : 'smtp';
const requiredForSmtp = (name) => (mailTransport === 'smtp' ? required(name) : (process.env[name] || '').trim());
const requiredForApi = (name) => (mailTransport === 'gmail_api' ? required(name) : (process.env[name] || '').trim());

const config = {
  port: int('PORT', 3000),
  campaignSecret: process.env.CAMPAIGN_SECRET || '',
  mailTransport,

  gmail: {
    user: required('EMAIL_USER'),
    pass: requiredForSmtp('EMAIL_PASSWORD'),
    fromName: process.env.EMAIL_FROM_NAME || '',
    replyTo: process.env.EMAIL_REPLY_TO || '',
  },

  // OAuth2 for the Gmail API transport (MAIL_TRANSPORT=gmail_api).
  // Get a refresh token with `npm run google-token`.
  google: {
    clientId: requiredForApi('GOOGLE_CLIENT_ID'),
    clientSecret: requiredForApi('GOOGLE_CLIENT_SECRET'),
    refreshToken: requiredForApi('GOOGLE_REFRESH_TOKEN'),
  },

  // Bounce reader for the smtp transport. gmail_api reads bounces over the API.
  imap: {
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: int('IMAP_PORT', 993),
    user: process.env.IMAP_USER || process.env.EMAIL_USER,
    pass: process.env.IMAP_PASSWORD || requiredForSmtp('EMAIL_PASSWORD'),
  },

  sheet: {
    // Google Apps Script web-app URL, ending in /exec
    apiUrl: required('GOOGLE_SHEET_API'),
    // Optional shared token; only used if your Apps Script checks for it.
    token: process.env.GOOGLE_SHEET_API_TOKEN || '',
  },

  campaign: {
    batchSize: int('BATCH_SIZE', 25),
    sendDelayMs: int('SEND_DELAY_MS', 2000),
    retryFailed: bool('RETRY_FAILED', false),
    dryRun: bool('DRY_RUN', false),
    // Scan the inbox for bounces at the start of each run and mark those rows "Bounced".
    processBounces: bool('PROCESS_BOUNCES', true),
    bounceLookbackDays: int('BOUNCE_LOOKBACK_DAYS', 3),
    subjectTemplate:
      process.env.EMAIL_SUBJECT ||
      'AI Engineer & full-stack developer exploring roles at {{company}}',
  },
};

module.exports = config;
