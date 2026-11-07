# What it does

Implements a local account assistant that monitors incoming connection requests
and one-to-one direct messages, accepts requests, and generates short contextual
replies. SQLite records durable action intents, deduplication state and receipt-
to-confirmation timings. Ambiguous outcomes block retries rather than risk duplicates.
No outgoing invitations, unsolicited new conversations or bulk outreach.

# How to run it

Use a supported Node release and a logged-in desktop:
`npm ci`, `npx playwright install chromium`, `npm run build`.
Copy `.env.example` to `.env` and add your private OpenAI API key as `LLM_API_KEY`.
Defaults use OpenAI's `gpt-4o-mini`; conversation context is sent to OpenAI with
`ALLOW_EXTERNAL_LLM=true`. No local model server is required.
Review platform-policy risk and model privacy. Run `npm run login`, then
`npm run smoke:live` and `npm run start:dry`.
After live selector validation, explicitly acknowledge platform risk in configuration
and run `npm run start:live`. On macOS use
`caffeinate -dims sh scripts/run-loop.sh` for supervision and keep-awake.
Stop with Ctrl+C. `npm run report` reports measured latency with timestamp-quality
and sample-count caveats.

# What it cannot do yet

Live LinkedIn selectors, acceptance/send, model response quality, a live soak test
and real latency percentiles remain unverified. Automated verification uses synthetic
workflow and local Chromium fixtures only. Attachments/images are not inspected;
groups, InMail and unidentified threads are skipped. Rendered history/conversation
lists are bounded and UI-dependent. Manual re-login is required for checkpoints.
Exactly-once delivery and 24-hour uninterrupted operation are not guaranteed.
LinkedIn restricts this type of automation and may restrict the account.
All 79 offline tests, the build and runtime/test type checks passed.
Source: https://github.com/carloskekwa/LinkedInBot.
No live performance figures are claimed here.
