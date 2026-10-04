# job-mail-automation

Reads job-outreach contacts from a Google Sheet (via a Google Apps Script web
app), sends a templated email to every row whose **Status** is `Pending`, then
writes the result (`Sent` / `Bounced` / `Failed` / `Skipped`) back to the sheet.

Built for my own job search, open-sourced so anyone can run their own copy.
Everything identifying is config you supply (`.env`, the Google Sheet, the Apps
Script deployment) - nothing here is tied to my accounts. **`templates/email.*`
contain my actual outreach copy (name, resume link, phone) as a working
example** - replace it with your own before sending anything.

```
Google Sheet ──(Apps Script /exec)──►  Node API (Render web service)  ──►  Gmail
      ▲                                          │         ▲               send + read
      └──────────── POST status ◄────────────────┘         └── bounces     bounces
cron-job.org  ──hourly POST /api/send-campaign──►  Node API (runs in background)
```

**Mail transport** (`MAIL_TRANSPORT`):

| | `smtp` (default) | `gmail_api` |
| --- | --- | --- |
| Sends via | Gmail SMTP :465 + App Password | Gmail API over HTTPS :443 |
| Reads bounces via | IMAP :993 | Gmail API |
| Works on Render | **No** (465/993 blocked) | **Yes** |
| Setup | App Password | Desktop OAuth client + refresh token |

Use `smtp` locally, `gmail_api` on Render.

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

> The web app is currently unauthenticated — anyone with the URL can read the
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
variables available.

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
- `CAMPAIGN_SECRET` is auto-generated — **copy its value**, cron-job.org needs it.

Manual alternative: **New → Web Service** from the repo, build `npm install`,
start `node server.js`, health check `/health`, add the vars from `.env.example`
plus `MAIL_TRANSPORT=gmail_api`.

Note the free web service sleeps after 15 min idle, so the first request each
hour is a cold start (~30-60s).

## Scheduling with cron-job.org

`POST /api/send-campaign` starts the batch in the **background** and returns
`202` immediately, so a pinger that times out long requests is fine. The
`running` flag makes an overlapping call return `409` (harmless).

**Main job** — at https://console.cron-job.org → *Create cronjob*:

| Field | Value |
| --- | --- |
| URL | `https://<your-service>.onrender.com/api/send-campaign` |
| Schedule | Every 1 hour (`0 * * * *`) |
| Request method | `POST` |
| Header | `x-campaign-secret: <CAMPAIGN_SECRET>` |
| Save responses / notify on failure | on |

A `2xx` (the `202`) counts as success. Enable **retry on failure** so a cold
start that overruns the 30s limit is retried; the next hourly run would catch up
anyway.

**Keep-warm job (recommended)** — a second cronjob, `GET` on
`https://<your-service>.onrender.com/health` every 10 minutes, no header. This
keeps the Render instance from sleeping so the main job never hits a cold start.
(An always-on free instance uses ~730 of the 750 free hours/month.)

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

The sheet has ~1700 rows. A personal Gmail sends **~500 recipients/day** over SMTP
(Google Workspace: ~2000); exceeding it triggers a 24h send block, and sustained
cold blasting from a new pattern risks the account being flagged.

- Defaults: `BATCH_SIZE=15` + hourly cron = **~360/day**, ~5 days for the full list.
- Ramp up rather than starting at the cap: e.g. `BATCH_SIZE=8` for the first 2-3
  days, then raise it. Watch the sheet for a run of `Failed` rows — that's usually
  the quota block; pause for 24h.
- Run duration ≈ `BATCH_SIZE` x (`SEND_DELAY_MS` + sheet-write time). The Apps
  Script write is currently ~9s, so 15 rows ≈ 3 min. Keep this well under the
  1-hour gap between triggers.

## Safety notes

- `SEND_DELAY_MS` throttles between sends so the burst looks less machine-like.
- Duplicate email addresses within the sheet are emailed once; later rows get
  `Skipped`.
- A send that succeeds but whose status write fails is marked `sent-unrecorded`
  in the run summary — check for these so you don't re-send on the next run.
- `.env` is git-ignored — never commit real credentials.
