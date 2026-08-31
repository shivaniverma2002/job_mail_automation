'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: config.gmail.user,
    pass: config.gmail.pass,
  },
});

// Confirms the SMTP credentials work before a run starts.
async function verifyTransport() {
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

  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

module.exports = { verifyTransport, sendMail };
