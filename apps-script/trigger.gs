/**
 * Scheduler for job_mail_autmation - runs inside your Google account, replacing
 * cron-job.org. Two triggers:
 *
 *   keepWarm     every 10 min  -> GET /health   (stops the free Render instance sleeping)
 *   sendCampaign every 1 hour  -> POST /api/send-campaign
 *
 * SETUP
 *   1. script.google.com -> New project (name it e.g. "Job Mail Scheduler").
 *   2. Paste this file. Set SERVICE_URL and CAMPAIGN_SECRET below.
 *   3. Run `keepWarm` once -> authorize when prompted.
 *   4. Triggers (clock icon) -> Add trigger:
 *        keepWarm     - Time-driven - Minutes timer - Every 10 minutes
 *        sendCampaign - Time-driven - Hour timer    - Every hour
 *   5. Executions tab: keepWarm should log 200, sendCampaign 202 (or 409 if a
 *      run overlaps - both fine).
 */
var SERVICE_URL = 'https://YOUR-SERVICE.onrender.com';
var CAMPAIGN_SECRET = 'PUT_THE_RENDER_CAMPAIGN_SECRET_HERE';

function keepWarm() {
  var res = UrlFetchApp.fetch(SERVICE_URL + '/health', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    console.warn('keepWarm ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }
}

function sendCampaign() {
  var res = UrlFetchApp.fetch(SERVICE_URL + '/api/send-campaign', {
    method: 'post',
    headers: { 'x-campaign-secret': CAMPAIGN_SECRET },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code !== 202 && code !== 409) {
    console.warn('sendCampaign ' + code + ': ' + res.getContentText().slice(0, 300));
  }
}

/** Run manually to see the last run's summary in the logs. */
function checkLastRun() {
  var res = UrlFetchApp.fetch(SERVICE_URL + '/api/last-run', {
    headers: { 'x-campaign-secret': CAMPAIGN_SECRET },
    muteHttpExceptions: true,
  });
  console.log(res.getContentText());
}
