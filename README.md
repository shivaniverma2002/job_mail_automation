# job-mail-automation

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

**Turn a Google Sheet of HR/recruiter contacts into a self-hosted, scheduled
cold-outreach campaign that sends from your own Gmail, tracks bounces
automatically, and writes `Sent` / `Bounced` / `Failed` back to the sheet —
for free, running entirely on your own accounts.**

No SaaS, no third-party mail service holding your contact list, no
per-recipient pricing. Your Google Sheet is the database, your Gmail is the
sender, Render's free tier is the host.

> Built for my own job search (and it worked — I'm employed now). Open-sourced
> so anyone can run their own copy. Nothing here is tied to my accounts:
> everything identifying is config you supply. **`templates/email.*` is my
> actual outreach copy (name, resume link, phone) kept as a working example —
> copy `templates/email.example.*` and write your own before sending anything.**

## Why this exists

Manually tracking "did I email this recruiter yet, and did it bounce" in a
spreadsheet while copy-pasting the same email 50 times is tedious and error
prone. This automates the loop:

```
Google Sheet ──(Apps Script /exec)──►  Node API (Render web service)  ──►  Gmail
      ▲                                          │         ▲               send + read
      └──────────── POST status ◄────────────────┘         └── bounces     bounces
Apps Script time trigger ──POST /api/send-campaign──►  Node API (runs in background)
```

## Features

- **Reads straight from a Google Sheet** — no database, no admin UI; the
  sheet *is* the contact list and the status board.
- **Two mail transports**: Gmail SMTP for local use, or the **Gmail API over
  HTTPS** for hosts that block outbound SMTP/IMAP (Render, most free PaaS).
- **Automatic bounce detection** — scans your inbox for delivery-failure
  notices before every batch and marks the row `Bounced`, so you're not
  flying blind on deliverability.
- **Duplicate-email protection** within a run, idempotent bounce reconciliation,
  and a `Failed`/`sent-unrecorded` trail so nothing silently re-sends.
- **Throttled, resumable batches** — a safe `BATCH_SIZE` per run, picks up
  exactly where the last run left off (by sheet `Status`).
- **Runs for free**: Render's free web service + a Google Apps Script time
  trigger as the scheduler (no paid cron service required).
- **Dry-run everything** — preview a full batch (reads, renders, bounce scan)
  with zero sends and zero sheet writes before you trust it with real mail.

## Sheet layout

Header row must be **row 1**. Column order is flexible; columns are matched by name.

| Sr no | Name   | Email             | Title    | Company | Status  |
| ----- | ------ | ----------------- | -------- | ------- | ------- |
| 101   | Anusha | anusha@ex.com     | HR Head  | ABC     | Pending |
| 102   | Rahul  | rahul@ex.com      | Director | XYZ     | Sent    |

**`Sr no` and `Email` are both required** — the Apps Script locates the row to
update by matching those two values, so `Sr no` must be non-empty and unique.
The script updates the **Status** cell only (no timestamp/note column).

`Status` values the app understands:
- `Pending` or empty → will be sent
- `Sent` → skipped
- `Bounced` → skipped (set by the bounce scanner — SMTP accepted it but the
  recipient server rejected it later)
- `Failed` → skipped, unless `RETRY_FAILED=true`
- `Skipped` → skipped (set automatically for duplicate emails)

## Setup

### 1. Google Apps Script web app

The `Code.gs` behind the sheet exposes:

- **`GET`** → `{ success, count, data: [ { "Sr no", Name, Email, Title, Company, Status }, ... ] }`
- **`POST`** `{ sr_no, email, status }` → finds the row by `Sr no` + `Email`, sets `Status`

To (re)deploy: Apps Script editor → **Deploy → New deployment → Web app**,
*Execute as* **Me**, *Who has access* **Anyone**. Copy the `/exec` URL into
`GOOGLE_SHEET_API`. After editing `Code.gs` you must **Deploy → Manage
deployments → Edit → new version** (or the URL keeps serving the old code).

> The web app is unauthenticated by default — anyone with the URL can read the
> sheet and write Status. To lock it down, add a token check in `doGet`/`doPost`
> (e.g. `if (e.parameter.token !== 'SECRET') return jsonResponse({success:false,error:'unauthorized'})`)
> and set the same value in `GOOGLE_SHEET_API_TOKEN`. The Node client already
> sends `?token=` and a `token` body field when that env var is set.

### 2. Mail transport

`EMAIL_USER` is the sending Gmail address in both modes.

**`smtp`** (local): enable 2-Step Verification →
https://myaccount.google.com/apppasswords → 16-char password → `EMAIL_PASSWORD`.
Same password is reused for IMAP bounce reading.

**`gmail_api`** (Render — SMTP/IMAP ports are blocked there):

1. [Google Cloud Console](https://console.cloud.google.com/) → new project →
   **APIs & Services → enable "Gmail API"**.
2. **OAuth consent screen** → External → fill required fields → **Publish app**
   (if left in "Testing", the refresh token dies after 7 days).
3. **Credentials → Create credentials → OAuth client ID → Desktop app.** Put the
   id/secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. `npm run google-token` → open the URL, sign in as the **sending** account,
   allow. Copy the printed `GOOGLE_REFRESH_TOKEN` into `.env` and Render.

Scopes used: `gmail.send` + `gmail.modify`. Sends as the real account (SPF/DKIM
aligned, no "via" header).

### 3. Write your email

`templates/email.html` and `templates/email.txt` are your own content and are
git-ignored (never committed), the same way `.env` is:

```bash
cp templates/email.example.html templates/email.html
cp templates/email.example.txt templates/email.txt
# edit both - replace the bracketed placeholders with your own pitch, links, name
```

Keep the two files in sync; see **Email content** below for the placeholder
variables available. Running without doing this first fails fast with a
message telling you exactly what to copy.

### 4. Local run

```bash
npm install
cp .env.example .env       # then fill in .env
npm run send -- --dry      # preview: no emails, no sheet writes
npm run send               # real send (also scans bounces first)
npm run bounces -- --dry   # preview the bounce scan only
npm run bounces            # apply "Bounced" statuses only
npm start                  # run the API locally on :3000
```

Trigger the endpoint manually:

```bash
curl -X POST "http://localhost:3000/api/send-campaign" \
  -H "x-campaign-secret: <CAMPAIGN_SECRET>"
```

Add `?dryRun=true` or `?limit=5` to the URL to override behaviour for one call.

## Deploy on Render

`render.yaml` defines one free web service and pins `MAIL_TRANSPORT=gmail_api`
(SMTP/IMAP are blocked on Render). In Render: **New → Blueprint**, point it at
this repo, then fill the `sync: false` env vars in the dashboard:

- `EMAIL_USER`, `EMAIL_FROM_NAME`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (from
  `npm run google-token` — see Setup step 2)
- `GOOGLE_SHEET_API` (and `GOOGLE_SHEET_API_TOKEN` if you added a token check)
- `CAMPAIGN_SECRET` is auto-generated — **copy its value**, the scheduler needs it.

Manual alternative: **New → Web Service** from the repo, build `npm install`,
start `node server.js`, health check `/health`, add the vars from `.env.example`
plus `MAIL_TRANSPORT=gmail_api`.

Note the free web service sleeps after 15 min idle, so an unwarmed first
request can be slow (~30-60s) — the scheduler below handles that.

## Scheduling — Google Apps Script time trigger (recommended)

`POST /api/send-campaign` starts the batch in the **background** and returns
`202` immediately — any pinger works, nothing needs to hold a connection open
for the full run.

Rather than a paid/external cron service, run the scheduler as a small Apps
Script in your own Google account — it's free, needs no third-party signup,
and a 10-minute ping conveniently keeps the free Render instance warm at the
same time:

1. script.google.com → **New project** → paste `apps-script/trigger.gs`.
2. Set `SERVICE_URL` (your Render URL) and `CAMPAIGN_SECRET` at the top.
3. Run `keepWarm` once → authorize.
4. **Triggers** (clock icon) → add two:

   | Function | Interval |
   | --- | --- |
   | `keepWarm` | Every 10 minutes (`GET /health`, keeps the instance awake) |
   | `sendCampaign` | Every hour (`POST /api/send-campaign`) |

5. **Executions** tab: `keepWarm` → `200`, `sendCampaign` → `202` (or `409` if
   a run is already in progress — both fine).

`checkLastRun()` in the same file logs the latest run summary on demand. Any
other pinger (cron-job.org, GitHub Actions, a server you already run) works
too — just `POST` to `/api/send-campaign` with the `x-campaign-secret` header
on a schedule, and `GET /health` more frequently if the host sleeps.

**Checking results:** `GET /api/last-run` (or `/health`) returns the summary of
the most recent run — counts, per-row outcomes, and the bounce scan. Render logs
have the same under `[send-campaign] done`.

## Endpoints

| Method | Path                  | Notes                                                    |
| ------ | --------------------- | ------------------------------------------------------- |
| GET    | `/health`              | Liveness, `running` / `runningForMs`, and `lastRun`. Use for the keep-warm ping. |
| GET    | `/api/last-run`        | Summary of the most recent run (counts, outcomes, bounce scan). |
| POST   | `/api/send-campaign`   | Scans bounces, then sends one batch. Runs in the background, returns `202`. Auth: `x-campaign-secret` header or `?key=`. Query: `dryRun`, `limit`. `409` if already running. |
| POST   | `/api/process-bounces` | Bounce scan only, background + `202`. Same auth. Query: `dryRun`. |

## Bounce handling

Gmail reports success as soon as it accepts a message for relay. If the
recipient's server rejects it afterwards (bad address, blocked sender), a failure
notice comes back — so the row is `Sent` but the mail never arrived.

Before every send batch, the app scans the last `BOUNCE_LOOKBACK_DAYS` (default
3) days of notices — `mailer-daemon` DSNs, `postmaster@` NDRs, `Undeliverable:`
Exchange bounces — via IMAP (`smtp` transport) or the Gmail API (`gmail_api`),
pulls the failed address out of each, and sets that row to `Bounced` (permanent
5.x.x only; transient 4.x.x left alone). Stateless and idempotent: re-marking a
`Bounced` row is a no-op, and read/unread state is not touched.

Set `PROCESS_BOUNCES=false` to disable, or run it on its own with
`npm run bounces` / `POST /api/process-bounces`.

## Email content

`templates/email.html` (HTML) and `templates/email.txt` (plain-text fallback)
are your own copy — git-ignored, start from `templates/email.example.{html,txt}`
(see Setup step 3). Keep the two in sync. Placeholders, filled per row:

- `{{name}}` — recipient first name (`"Anurag Sharma"` → `Anurag`)
- `{{fullname}}` — the Name cell as-is
- `{{company}}`, `{{title}}`, `{{email}}`

The subject comes from `EMAIL_SUBJECT` and supports the same placeholders.

## Sending volume

A personal Gmail sends **~500 recipients/day** over SMTP (Google Workspace:
~2000); exceeding it triggers a 24h send block, and sustained cold blasting
from a new pattern risks the account being flagged. Size `BATCH_SIZE` and your
trigger frequency so the daily total stays under that.

- Example: `BATCH_SIZE=15` + hourly runs = **~360/day** — a 1,500-row sheet
  clears in about 4-5 days.
- Ramp up rather than starting at the cap: e.g. `BATCH_SIZE=8` for the first
  2-3 days, then raise it. Watch the sheet for a run of `Failed` rows — that's
  usually the quota block; pause for 24h.
- Run duration ≈ `BATCH_SIZE` × (`SEND_DELAY_MS` + sheet-write time). The Apps
  Script write is typically a few seconds, so keep a batch comfortably under
  your trigger interval.

## Safety notes

- `SEND_DELAY_MS` throttles between sends so the burst looks less machine-like.
- Duplicate email addresses within the sheet are emailed once; later rows get
  `Skipped`.
- A send that succeeds but whose status write fails is marked `sent-unrecorded`
  in the run summary — check for these so you don't re-send on the next run.
- `.env` is git-ignored — never commit real credentials.

## Limitations

- This is address-list outreach, not a reply/conversation manager — it sends
  once per row and tracks delivery status, nothing more.
- Bounce detection relies on recognizable delivery-failure notices landing in
  the same inbox; a provider that silently drops mail without an NDR won't be
  caught.
- Deliverability is on you: a personal Gmail account has real daily limits and
  reputation to protect. Keep volume modest and expect some bounces.

## Contributing

Issues and PRs welcome — this started as a one-person job-search tool, so
there's plenty of room for a real email-finder integration, multi-provider
transports, a lighter-weight sheet backend, tests, etc. See
[CONTRIBUTING.md](CONTRIBUTING.md) for dev setup and how changes are verified
(there's no automated test suite). Everyone participating is expected to
follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Found a vulnerability? Please report it privately rather than as a public
issue — see [SECURITY.md](SECURITY.md), which also summarizes what each
credential in this project protects.

## License

[MIT](LICENSE)
