'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');
const gmailApi = require('./gmailApi');

const mode = config.mailTransport; // 'smtp' | 'gmail_api'

let transporter;
if (mode === 'gmail_api') {
  // Buffer transport: sendMail() compiles the full MIME into info.message and
  // sends nowhere. We then hand that buffer to the Gmail API over HTTPS.
  transporter = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
} else {
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: config.gmail.user, pass: config.gmail.pass },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
}

// Confirms sending works before a run starts.
async function verifyTransport() {
  if (mode === 'gmail_api') {
    const r = await gmailApi.verify();
    if (!r || !r.ok) throw new Error('Gmail API verify failed');
    return;
  }
  await transporter.verify();
}

async function sendMail({ to, subject, html, text }) {
  const from = config.gmail.fromName
    ? `"${config.gmail.fromName}" <${config.gmail.user}>`
    : config.gmail.user;

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    html,
    text,
    replyTo: config.gmail.replyTo || undefined,
  });

  if (mode === 'gmail_api') {
    const sent = await gmailApi.sendRaw(info.message); // info.message === full MIME Buffer
    return { messageId: info.messageId, accepted: [to], rejected: [], gmailId: sent.id };
  }
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

module.exports = { verifyTransport, sendMail };
