# Contributing

Thanks for considering a contribution. This started as a one-person job-search
tool, so there's room for real improvements — see the README's **Limitations**
and **Contributing** sections for ideas, or open an issue with your own.

## Before you start

For anything non-trivial (a new feature, a behavior change, a new dependency),
**open an issue first** to discuss the approach. Small fixes (typos, broken
links, clearer error messages) can go straight to a PR.

## Development setup

```bash
git clone https://github.com/<you>/job_mail_automation.git
cd job_mail_automation
npm install
cp .env.example .env                           # fill in your own credentials
cp templates/email.example.html templates/email.html
cp templates/email.example.txt templates/email.txt
npm run send -- --dry                          # should run cleanly with no sends
```

You'll need your own Google Sheet + Apps Script deployment, Gmail sending
account, and (for the `gmail_api` transport) a Google Cloud OAuth client — see
the README's **Setup** section. There's no way to meaningfully test this
project without real Google/Gmail config; there is no mocked "demo mode."

## Making changes

- There is currently **no automated test suite**. Verify manually:
  - `npm run send -- --dry` — confirms the sheet reads, template renders, and
    routing logic (duplicates, invalid emails, skip rules) still behave.
  - `npm run bounces -- --dry` — confirms the bounce scan still parses and
    classifies correctly.
  - For server/endpoint changes: `npm start`, then exercise `/health`,
    `/api/last-run`, and `/api/send-campaign` with `curl`.
- If you add a dependency, explain why in the PR — this project deliberately
  keeps its dependency list small.
- Match the existing code style (plain CommonJS, no build step, minimal
  comments — see the file headers for the tone).
- Update `README.md` / `.env.example` when you change behavior or add a
  config option; stale docs are worse than no docs.

## Security-sensitive changes

This project handles OAuth refresh tokens, app passwords, and a Google Sheet
API token. If your change touches credential handling, authentication, or
anything that writes to a user's inbox or sheet, call that out explicitly in
the PR description. See `SECURITY.md` for how to report a vulnerability
privately instead of via a public issue.

**Never commit real credentials.** `.env`, `templates/email.html`, and
`templates/email.txt` are git-ignored on purpose — if a `git status` shows one
of those as trackable, something's wrong.

## Submitting a pull request

1. Fork, branch from `main`.
2. Keep the PR focused — one logical change per PR is easier to review.
3. Describe what you tested and how (see "Making changes" above).
4. Link the issue it resolves, if any.

## Code of Conduct

By participating, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).
