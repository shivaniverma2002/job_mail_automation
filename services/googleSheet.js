'use strict';

// HTTP client for the Google Apps Script web app (/exec).
//   GET  -> { success, count, data: [ { "Sr no", Name, Email, Title, Company, Status }, ... ] }
//   POST { sr_no, email, status } -> matches a row by Sr no + Email, sets Status
const config = require('../config');

const TIMEOUT_MS = 20000;

// header lookup that ignores case and spaces ("Sr no" === "srno" === "SR NO")
function pick(row, name) {
  const target = name.toLowerCase().replace(/\s+/g, '');
  for (const key of Object.keys(row)) {
    if (key.toLowerCase().replace(/\s+/g, '') === target) return row[key];
  }
  return undefined;
}

async function request(method, body) {
  const url = new URL(config.sheet.apiUrl);
  if (config.sheet.token) url.searchParams.set('token', config.sheet.token);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow', // Apps Script 302-redirects to the result payload
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Apps Script returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok || json.success === false) {
      throw new Error(json && json.error ? json.error : `Apps Script HTTP ${res.status}`);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Apps Script request timed out after ${TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches every row. Filtering by Status happens in campaign.js.
 * Returns { contacts: [{ srNo, name, email, title, company, status }] }.
 */
async function getContacts() {
  const json = await request('GET');
  const rows = Array.isArray(json.data) ? json.data : [];

  const contacts = rows.map((row) => ({
    srNo: pick(row, 'Sr no'),
    name: String(pick(row, 'Name') ?? '').trim(),
    email: String(pick(row, 'Email') ?? '').trim(),
    title: String(pick(row, 'Title') ?? '').trim(),
    company: String(pick(row, 'Company') ?? '').trim(),
    status: String(pick(row, 'Status') ?? '').trim(),
  }));

  return { contacts };
}

/**
 * Writes a new Status for one row. The Apps Script needs BOTH Sr no and Email
 * to locate the row; it only sets the Status cell (no note column).
 */
async function updateStatus(contact, status) {
  if (contact.srNo === undefined || contact.srNo === '' || !contact.email) {
    throw new Error(
      `Cannot update sheet: row needs both "Sr no" and "Email" (sr_no=${contact.srNo}, email=${contact.email})`
    );
  }
  return request('POST', {
    sr_no: contact.srNo,
    email: contact.email,
    status,
    ...(config.sheet.token ? { token: config.sheet.token } : {}),
  });
}

module.exports = { getContacts, updateStatus };
