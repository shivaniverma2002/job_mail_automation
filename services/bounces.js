'use strict';

// Reads delivery-failure notices out of the sending account's inbox over IMAP
// and marks the matching sheet rows "Bounced". SMTP accepts a message for relay,
// so a later rejection by the recipient's server only surfaces here, as a bounce.
//
// Stateless + idempotent: every run re-scans the last N days of notices. Writing
// "Bounced" over a row that already says "Bounced" is a no-op, so nothing needs
// to track which notices were handled, and read/unread state is left untouched.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const config = require('../config');
const sheet = require('./googleSheet');

const MAX_MESSAGES = 400;
const ADDR = '[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}';

function addAll(set, value) {
  if (!value) return;
  String(Array.isArray(value) ? value.join(',') : value)
    .split(/[,;\s]+/)
    .map((s) => s.trim().replace(/^<|>$/g, '').toLowerCase())
    .filter((s) => /@/.test(s))
    .forEach((s) => set.add(s));
}

function scanText(set, text) {
  if (!text) return;
  const patterns = [
    new RegExp(`(?:Final|Original)-Recipient:\\s*(?:rfc822;)?\\s*<?(${ADDR})>?`, 'gi'),
    new RegExp(`message (?:wasn't delivered to|to)\\s+<?(${ADDR})>?`, 'gi'),
    new RegExp(`could(?:n't| not) be delivered to\\s+<?(${ADDR})>?`, 'gi'),
    new RegExp(`failed permanently.*?<?(${ADDR})>?`, 'gi'),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) set.add(m[1].toLowerCase());
  }
}

// Every failed recipient address referenced by a parsed NDR.
function extractRecipients(parsed) {
  const out = new Set();
  addAll(out, parsed.headers.get('x-failed-recipients'));
  scanText(out, parsed.text || '');
  scanText(out, parsed.html || '');

  for (const att of parsed.attachments || []) {
    if (!/delivery-status|rfc822|report/i.test(att.contentType || '')) continue;
    const body = (att.content && att.content.toString('utf8')) || '';
    scanText(out, body);
    const to = body.match(new RegExp(`^To:\\s*<?(${ADDR})>?`, 'im'));
    if (to) out.add(to[1].toLowerCase());
  }
  return [...out];
}

// permanent (5.x.x) vs transient (4.x.x) failure.
function classify(parsed) {
  const body = `${parsed.text || ''}\n${(parsed.attachments || [])
    .map((a) => (a.content ? a.content.toString('utf8') : ''))
    .join('\n')}`;

  const status = body.match(/\bStatus:\s*([245])\.\d+\.\d+/);
  if (status) return status[1] === '5' ? 'permanent' : status[1] === '4' ? 'transient' : 'unknown';
  if (/\b5\d\d[ -]5\.\d\.\d\b/.test(body) || /\b55\d\b/.test(body)) return 'permanent';
  if (/\b4\d\d[ -]4\.\d\.\d\b/.test(body) || /\b45\d\b/.test(body)) return 'transient';
  return 'unknown';
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]   don't write to the sheet
 * @param {Array}   [opts.contacts] pre-fetched contacts (avoids a second sheet GET)
 */
async function processBounces(opts = {}) {
  const dryRun = opts.dryRun ?? false;
  const summary = {
    scanned: 0,
    bounced: [],
    alreadyBounced: 0,
    transient: [],
    unmatched: [],
    unclassified: [],
    errors: [],
  };

  let contacts = opts.contacts;
  if (!contacts) ({ contacts } = await sheet.getContacts());

  // email -> contact, preferring the row currently marked "Sent"
  const byEmail = new Map();
  for (const c of contacts) {
    if (!c.email) continue;
    const key = c.email.toLowerCase();
    const cur = byEmail.get(key);
    if (!cur || (c.status.toLowerCase() === 'sent' && cur.status.toLowerCase() !== 'sent')) {
      byEmail.set(key, c);
    }
  }

  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: true,
    auth: { user: config.imap.user, pass: config.imap.pass },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  try {
    const since = new Date(Date.now() - config.campaign.bounceLookbackDays * 86400000);
    const queries = [
      { from: 'mailer-daemon', since },
      { from: 'postmaster', since },
      { subject: 'Undeliverable', since },
      { subject: 'Delivery Status Notification', since },
      { subject: 'Returned mail', since },
    ];

    const uidSet = new Set();
    for (const q of queries) {
      const found = await client.search(q, { uid: true });
      (found || []).forEach((u) => uidSet.add(u));
    }
    let uids = [...uidSet].sort((a, b) => a - b);
    if (!uids.length) return summary;
    if (uids.length > MAX_MESSAGES) uids = uids.slice(-MAX_MESSAGES);

    const seenWrites = new Set();

    for await (const msg of client.fetch({ uid: uids }, { source: true }, { uid: true })) {
      summary.scanned += 1;

      let parsed;
      try {
        parsed = await simpleParser(msg.source);
      } catch (err) {
        summary.errors.push({ uid: msg.uid, error: `parse failed: ${err.message}` });
        continue;
      }

      const recipients = extractRecipients(parsed);
      if (!recipients.length) continue; // not a parseable NDR (auto-reply, etc.)

      const kind = classify(parsed);

      for (const email of recipients) {
        const contact = byEmail.get(email);
        const rec = { email, kind, srNo: contact ? contact.srNo : null };

        if (kind === 'transient') {
          summary.transient.push(rec);
          continue;
        }
        if (kind !== 'permanent') {
          summary.unclassified.push(rec);
          continue;
        }
        if (!contact) {
          summary.unmatched.push(rec);
          continue;
        }
        if (contact.status.toLowerCase() === 'bounced' || seenWrites.has(email)) {
          summary.alreadyBounced += 1;
          continue;
        }

        seenWrites.add(email);
        summary.bounced.push(rec);
        if (!dryRun) {
          try {
            await sheet.updateStatus(contact, 'Bounced');
            rec.updated = true;
          } catch (err) {
            rec.updated = false;
            rec.writeErr = err.message;
          }
        }
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  return summary;
}

module.exports = { processBounces };
