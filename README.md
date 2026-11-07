# LinkedIn account assistant

A native TypeScript/Node application for one account, using a headed Playwright
Chromium profile, two worker pages, SQLite and an OpenAI-compatible model endpoint.
No Docker, dashboard, cloud deployment, stealth plugins or credential collection.

**Status:** implemented and tested with synthetic data and local browser fixtures.
Read-only selectors were partially validated against an authenticated account on
7 Nov 2026 (see "Live validation so far" below). **No live acceptance or send has been
performed**, nor a real-model quality assessment or one-hour soak. Do not submit this
as live-verified without completing the checklist below.

## Platform-policy risk

LinkedIn restricts automated account activity and unofficial scraping/browser
automation in its [User Agreement](https://www.linkedin.com/legal/user-agreement).
Ownership of an account does not mean LinkedIn authorizes automation. This application
may trigger restrictions or checkpoints; use only where the platform permits it.
Live mode requires `ACKNOWLEDGE_PLATFORM_RISK=true`. That acknowledgement does not
grant platform permission. The bot never bypasses checkpoints or CAPTCHA.
Manual reauthentication is required when a session expires.

## Setup

Use a currently supported Node release, preferably Node 22, npm and a desktop
session. Development/build/tests were run with Node 20.20.1 on macOS.
Do not run headed Chromium on a server without a display.

```sh
npm ci
npx playwright install chromium
npm run build
cp .env.example .env
```

Edit `.env`. Defaults use **OpenAI's API** at `https://api.openai.com/v1`
with model `gpt-4o-mini`. Set `LLM_API_KEY` to your own OpenAI API key locally.
No local model/server installation is needed. API usage requires available access
and billing/quota on your OpenAI API account.

```dotenv
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=your_openai_api_key
ALLOW_EXTERNAL_LLM=true
```

The example explicitly enables external inference: **conversation context is sent
to OpenAI**. Review the provider's retention policy before use. Without an explicit
`ALLOW_EXTERNAL_LLM=true`, configuration rejects remote inference. Missing OpenAI
keys fail before the bot opens its browser; login/smoke do not require a model key.
Never paste a real key into chat, documentation or Git.

Set `OWNER_PROFILE_URL` in your private `.env` to **your own logged-in account's**
full profile URL, e.g. `https://www.linkedin.com/in/your-profile-slug/`. This bypasses
the UI-dependent owner-menu lookup, not authentication. The application validates
the URL shape but cannot independently prove it belongs to the session; you must
provide the correct account. An incorrect value can break own-message classification.
Leaving it empty uses legacy owner-menu detection and fails explicitly if unavailable.

Alternative OpenAI-compatible providers remain supported through the same variables.
For local inference, explicitly set a local endpoint and model and set
`ALLOW_EXTERNAL_LLM=false`; a local server is not bundled.
Redirects are disabled to avoid forwarding credentials to a different endpoint.

```sh
npm run login          # manual login; exits after saving the local profile
npm run inspect:live   # read-only structural DOM census -> data/dom-inspection.json
npm run smoke:live     # read-only selector/thread check; prints counts, not bodies
npm run start:dry      # reads/generates but never accepts or sends
```

`inspect:live` records tag/class/role/attribute *names* only, redacting profile and
thread slugs — but button `aria-label`s on the invitation page contain inviter names.
The file is gitignored; delete it when done. **Do not run inspect/smoke repeatedly:**
each run performs dozens of page loads, and LinkedIn responded with HTTP errors
(`net::ERR_HTTP_RESPONSE_CODE_FAILURE`) after roughly six runs within ten minutes.
Wait 10–15 minutes if that happens.

The login command automatically closes Chromium once authenticated. Do not interrupt
it prematurely. Dry-run still reads private messages and contacts the configured
model; it only disables LinkedIn writes. It uses a separate database so dry-run
decisions do not consume live messages.

After live selector validation and permission/risk review:

```sh
# Set ACKNOWLEDGE_PLATFORM_RISK=true in .env first.
npm run start:live
```

Stop with Ctrl+C. Only one login/smoke/dry/live process may own a browser profile.
Do not operate the bot's tabs while it is running: manual navigation and drafts can
conflict with automation. Existing drafts are never overwritten. Stop before editing
selectors, reading/recovering pending actions or changing configuration.

### Initial history

`INITIAL_HISTORY=baseline` skips existing messages in the threads visible at the
first messaging scan. It subsequently handles new messages and newly appearing
threads. This prevents unsolicited replies to an old inbox. Start before the evaluator
sends messages. `reply-latest` explicitly opts into handling the latest inbound batch
in existing threads. Messages preceding an owner's reply are always consumed.

LinkedIn renders conversation cards lazily, so an old thread can surface after
startup. A card first seen after startup whose activity label clearly means "before
today" (a weekday, a date, "Yesterday") is baselined instead of answered. The check
fails open: a time of day or any unrecognised label is treated as fresh, so a real new
message is never ignored because of an unexpected label format.

Replies: the system prompt asks the model to reply to every message from a person
(including greetings, thanks, emoji-only and empty messages) and to decline only on an
explicit request to stop or an obvious automated notification. Run with
`LOG_LEVEL=debug` to see the model's decision and reason (this may echo message text).

## Keeping it running

Plug the machine in, keep networking available and keep the desktop logged in.
Sleep, a closed laptop lid, reboot, a display-session logout, expired credentials,
UI changes or rate limits can interrupt the test. No 24-hour uptime guarantee is
possible while manual checkpoint resolution is required.

On macOS, use the bundled foreground restart loop:

```sh
caffeinate -dims sh scripts/run-loop.sh
```

This keeps the machine awake for the lifetime of the loop. It forwards Stop to the
specific child PID and stops after ten failed starts. Do not run the loop and PM2
at the same time.

Alternatively install PM2 separately and use the ecosystem file:

```sh
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 logs linkedin-bot
pm2 stop linkedin-bot       # stops, does not restart
pm2 restart linkedin-bot
```

Keep `caffeinate -dims` running in another terminal while PM2 is running.
**Do not** wrap `pm2 start` alone in caffeinate: that command exits after daemonizing.
PM2 stops after ten unstable restarts and grants 35 seconds for shutdown. On Linux/
Windows, configure the OS not to suspend; the foreground shell loop is Unix-only.
Neither supervisor can resolve login checkpoints or reliably fix a hung desktop.

Logs go to stdout in structured JSON; PM2 stores them in its local log directory.
To keep a local file without PM2:

```sh
mkdir -p logs
npm run start:dry > logs/dry-run.log 2>&1
```

The per-worker health table records `active`, `error` or `manual_login_required`.
An INFO heartbeat is emitted every five minutes. A heartbeat means the loop is
running, not that all selectors work or that every action has succeeded.

## Architecture

```text
CLI + signal controller + single-instance profile lock
  |-- invitation loop --> invitation page --\
  |-- messaging loop  --> messaging page ----> Chromium persistent context
         | debounce -> model -> output guard -> fresh-thread check -> Send
  |-- SQLite observations / actions / conversations / health
  \-- JSON logs + latency report
```

Each page has one sequential worker, so it needs no separate mutex abstraction.
Each database is bound to the captured owner profile; switching accounts requires
a separate data directory rather than reusing another account's pending actions.
The two loops are independent and never overlap actions on their own page.
Reads and LLM calls retry through bounded worker backoff; external writes are
**never** blindly replayed. A closed browser page causes explicit worker errors.
The owner must restart the process if the browser is permanently closed.

### Action safety and recovery

1. Persist intent with incoming-message IDs and reply hash before typing/clicking.
2. Mark executing, check Stop immediately before dispatch, record `handledAt`.
3. Verify a matching own message **after the inbound anchor**, with a server-style
   message identifier and no recognized pending/error marker. For invitations,
   inspect the profile's "Remove connection" menu item without activating it.
4. Mark confirmed and consume the incoming batch atomically.
5. On ambiguous outcomes/exceptions, mark uncertain. Re-read on later polls/restart.
   Never resend/re-click just because the item is absent.

The default candidate selectors for pending/error indicators must also be checked
live. UI confirmation is not proof of recipient read or an independent server-side
delivery receipt. LinkedIn does not supply an idempotency contract to this adapter;
**exactly-once execution is not guaranteed**. Hash collisions are not the practical
problem: unstable DOM IDs, truncated history, deletion and optimistic UI updates are.
Conservative uncertainty blocks the affected conversation rather than risking a
duplicate. An old identical outgoing text before the anchor does not confirm a new send.

Uncertain actions automatically become confirmed if later reads prove success.
Otherwise they remain blocked for manual review. Stop, inspect the LinkedIn thread/
profile and the relevant action before making any manual response. There is no unsafe
"force retry" command; do not clear the database to retry an uncertain action.

Edited stable-ID messages already handled do not cause another reply. IDs fall
back to sender/text/absolute-time/occurrence hashes when unavailable. This fallback
is best-effort and can drift with virtualized/truncated history. The adapter refuses
to infer unknown senders or reply to unidentified/group/InMail threads.

The LLM has no browser tools. One JSON call performs intent/language/reply generation.
Context is bounded by `CONTEXT_MESSAGES` and `MAX_INPUT_CHARS`; truncation/omission
is explicitly labeled so the model can request missing details rather than invent them.
The guard enforces length, basic disclosure checks, valid schema and no novel URLs.
It is **not** a complete defense against prompt injection, misinformation or
multilingual policy violations. Review model quality before unattended use.
On model errors, an explicit automated-assistant fallback is sent; it does not
promise that the owner will follow up. Appropriate no-reply decisions prevent loops.
No fallback is sent when doing so would violate Stop, authentication, action caps
or unresolved-outcome safety.

### Monitoring and load

Defaults: invitation poll 20 seconds, messaging poll 10 seconds, +/-20% jitter;
debounce 7 seconds after a change, capped at 20 seconds; 60 external actions/hour.
The elapsed worker time is subtracted from the wait to avoid overlapping intervals.
Actual debounce resolution is limited by polling and thread navigation.

Polls only read the already-loaded page. Full reloads are separate and rarer: the
invitation page reloads about every 3 minutes (`INVITATION_REFRESH_MS=180000`) and the
messaging page about every 5 minutes (`MESSAGE_REFRESH_MS=300000`), each with +/-20%
jitter. The messaging page also updates live between reloads (a real message was
detected with no reload in live testing). **Measured:** reloading the invitation page
every 60 seconds was rejected by LinkedIn with HTTP errors within the first minute, so
the defaults are deliberately conservative. As a consequence, an invitation can wait up
to roughly one refresh interval before it is seen, so expect acceptance latency of a few
minutes, not seconds; lowering `INVITATION_REFRESH_MS` speeds this up but raises the
risk of throttling. The messaging reload also bounds how long a silently dead live
update channel could blind the bot. This deliberately does not assume a parked
LinkedIn page always receives updates. Threads are switched by **clicking the
conversation card inside the loaded app**, as a user would, and the adapter waits for
the message view to actually change before reading, so it can never read the previous
thread's messages as the new one. Direct URL navigation is only a fallback: in testing,
LinkedIn answered a burst of ~12 direct thread loads with HTTP errors
(`ERR_HTTP_RESPONSE_CODE_FAILURE`).

If LinkedIn does reject page loads, the worker treats it as systemic: it stops
walking threads, logs a clear error, and pauses for 2, 4, 8 then 10 minutes between
attempts (resetting on success). A single thread that fails for any other reason is
skipped for two minutes while the others continue.
Conversations are identified by participant-name hash; two threads with identical
participant names are therefore treated as one, which is a known limitation.
Only rendered conversation-list entries (up to `THREAD_LIMIT`, default 30) and
currently rendered message history are read. No pagination is implemented.
Large inboxes, slow navigation, unresolved threads and sequential LLM calls increase
latency. This version does not guarantee a reply within ten minutes under all loads.

## Receipt-to-handling measurements

Run after live actions:

```sh
npm run report
```

For every accepted invitation and reply action the database stores:

| Field | Meaning |
|---|---|
| `receivedAt` | LinkedIn UI receipt time, or null if unavailable |
| `lastReceivedAt` | Last incoming message receipt in a debounced batch |
| `precision`, `uncertaintyMs` | Exact timezone-qualified timestamp vs approximate relative label |
| `detectedAt` | First bot observation, never overwritten on later polls |
| `generatedAt` | Completion of reply generation |
| `handledAt` | Immediately before dispatching the Accept/Send click |
| `confirmedAt` | Time the adapter verified the outcome |
| `llmMs`, `debounceMs` | Model/guard duration and observed batch-wait duration |

All timestamps are UTC epoch milliseconds. `handledAt` records a click **attempt**,
not success. Playwright's final auto-wait/network work can follow that timestamp.
`confirmedAt` is the success endpoint.

Reports give count/p50/p95/max milliseconds separately for invitations and replies:
receipt-to-detection (exact samples), receipt-to-confirmation (exact and approximate
samples separately), detection-to-generation/handling/confirmation, handling-to-
confirmation, LLM time and debounce time. Counts include unknown receipts,
approximate receipts, clock-skewed samples, uncertain/failed actions and retries.
Only confirmed actions enter completed-action latency percentiles.

Do not manufacture receipt times when the UI exposes only ambiguous clock labels
or dates. Supported exact inputs are timezone-qualified ISO timestamps; supported
approximate inputs are English "N seconds/minutes/hours/days ago". Other labels are
unknown. Relative labels are estimates with unit-sized uncertainty, **not precise
measurements**. First and last receipt times use the first and last messages in
rendered conversation order, not the smallest/largest parsed dates.

LLM duration uses a monotonic clock. Cross-stage persisted timestamps use the system
wall clock so they survive restarts; clock skew/system-clock changes can affect them.
Negative completed-duration samples are excluded, not clamped to zero. An exact UI
timestamp still depends on platform clock accuracy. Evaluator send time is not
necessarily identical to LinkedIn UI receipt time.

The synthetic demo prints deterministic **simulation** metrics, not live performance:

```sh
npm run demo
```

No real receipt-to-response numbers are available yet. Publish live percentiles only
after collecting a real soak dataset, along with sample counts and missing receipts.

## Privacy model

- Credentials are entered manually into Chromium, never into the application.
- The local browser profile inherently contains authentication cookies and history.
  It is not exported. Keep it private; it is not encrypted by this application.
- API keys live in local `.env`; remote HTTP is rejected and keys are never logged.
- No message bodies or generated reply bodies are stored in SQLite/logs.
  Model requests hold bounded conversation context in memory.
- SQLite retains profile/conversation identifiers, hashes, receipt timestamps and
  operational state. These are still potentially personal data.
- Consumed-observation receipt metadata expires after `RETENTION_DAYS` (default 7).
  Minimal ID tombstones, action keys and action metrics persist to prevent replay
  and support reports; this is not complete automatic data erasure.
- `.gitignore` excludes `.env`, profiles, databases/WAL files and logs.
- Directories are owner-only on Unix; use encrypted disk storage and appropriate
  OS permissions. The app does not encrypt its database.
- To erase account data, stop the bot and deliberately delete only its configured
  profile/data/log directories. Erasure removes dedup state; do not resume live
  processing without a fresh baseline. Review external provider retention separately.
- Tests use synthetic identities only; browser test requests are intercepted locally.

## Validation

Verified on macOS with Node 20.20.1:
`npm run typecheck` and `npm run build` passed; all **84 tests in 4 files** passed;
`npm audit` reported **0 vulnerabilities**. The synthetic demo confirmed one fake
invitation and one fake reply without duplicate processing. These are offline
results, not a live LinkedIn soak test or real latency benchmark.

### Live validation so far (read-only, 7 Nov 2026)

Observed against the owner's authenticated account with `inspect:live`/`smoke:live`:

- Login detection, owner identity (`OWNER_PROFILE_URL`) and both list pages load.
- `/messaging/` auto-opens a thread; conversation cards have **no links**, so thread
  URLs are learned by clicking each card once (startup only), then change detection
  uses an in-memory preview fingerprint. 12 threads were discovered this way.
- Messages carry stable `data-event-urn` IDs; incoming ones carry
  `msg-s-event-listitem--other`; the owner's own link uses the member-ID URL form, so
  own/incoming classification uses marker + recipient + one-to-one elimination.
  4 one-to-one threads (23 messages, 10 own / 13 incoming) classified without error.
  Threads with Page/organisation recipients are skipped as unsupported.
- No `<time datetime>` attributes exist: message receipt times are **unknown**;
  invitation ages are parsed from relative text ("2 hours ago") when present.
- The invitation manager mixes connection requests with **Page-follow and newsletter
  invitations**. Only cards with a `/in/` profile link whose Accept label is not of the
  form "… invitation for …" are treated as connection requests. The account had **zero
  pending person requests** during validation, so **the person-card label format and the
  Accept click are still unverified live**.
- The Send button only renders once the composer has content; it has **not** been
  clicked live. Acceptance verification via the profile "More actions" menu is unverified.

```sh
npm run typecheck
npm run build
npm test
npm run demo
```

The test suite covers first-receipt retention, receipt precision/skew reporting,
invitation/reply dedup, own-message filtering, baseline/new conversations, debounce,
changed threads during generation, no-reply decisions, model failure fallback,
Stop, authentication pause/resume, hourly caps, uncertain outcomes, restart recovery,
retention tombstones, stable-ID edits/deletions and attachment metadata.

Synthetic DOM browser tests exercise real Chromium against local fixtures:
selectors, receipt extraction, sender identity, dispatch, acceptance verification,
send verification and draft protection. They do **not** test LinkedIn's actual DOM.
Unusual-message tests with a fake generator verify the workflow, not real-model
linguistic quality or injection resistance. CI installs Chromium before running tests.

### Required manual live checklist

1. Review platform permission/risk and OpenAI privacy. Configure your API key and quota.
2. Run login and smoke. Check owner identity, single-recipient detection and all
   read/write selectors in [selectors.ts](src/selectors.ts) against the current UI.
   JSON overrides can be supplied using `SELECTORS_FILE` with matching keys.
   A startup list health check alone does not validate Send/Accept selectors.
3. Dry-run with a consenting contact. Confirm fresh messages, own-message filtering,
   batching, and suitable replies in the sender's language.
4. Enable live mode; use one harmless invitation and message exchange. Verify the
   account UI, confirmation logs, database and report agree.
5. Test a short model outage, a session expiry/manual login, graceful restart and
   a crash/restart. Verify no duplicate actions and appropriate uncertain blocking.
6. Run for at least one hour, including restart. Inspect worker health and keep-awake.
   Test empty/emoji/long/foreign-language/link/attachment/hostile/ambiguous/injection
   inputs with consenting synthetic exchanges. Do not publish private messages.
7. Collect `npm run report` counts and real p50/p95/max with receipt-quality caveats.
   Label unverified items in the submission. Continue supervised operation throughout
   the evaluator's window; automation cannot repair manual-login-required pauses.

## Troubleshooting

- Missing browser executable: `npx playwright install chromium`.
- Build/native SQLite install failure: use a supported Node version and rerun
  `npm ci`; native builds may require platform compiler tools.
- Selector health failure: run smoke and inspect the current UI. Edit centralized
  selectors/overrides. Never substitute unverified empty-list fallbacks.
- Zero supported threads: check recipient/unsupported selectors. The adapter skips
  uncertain classifications rather than replying to arbitrary threads.
- Locked profile: stop the other bot/login/PM2 process. A dead PID lock is recovered;
  invalid/permission-conflicted locks require manual inspection. Never remove an
  active process's lock.
- LLM unavailable/invalid output: inspect API key, provider quota, model access and configuration. Incident
  logs omit arbitrary provider bodies to avoid exposing private information.
- Checkpoint/login redirect: resolve manually in Chromium; both workers pause for
  recognized checkpoints. Shared login cookies allow workers to restore their own
  redirected tabs once at least one tab is authenticated.
- Logged in but stuck at "Log in manually": monitoring has not started. Login
  detection accepts visible legacy navigation or a navigation region containing
  a Messaging link; the Feed link need not be inside that region. LinkedIn origin
  and login/checkpoint URL checks still apply. Every 30 seconds it logs sanitized page state and
  selector counts. If those remain absent, update the `nav` selector after inspecting
  the actual UI; do not bypass the authentication check.
- Uncertain action: inspect manually; no blind retry or database reset.
- High latency: inspect stage metrics, navigation, model performance, inbox size,
  periodic refresh delay and caps before lowering intervals. Do not evade restrictions.

## Public repository

Repository: [carloskekwa/LinkedInBot](https://github.com/carloskekwa/LinkedInBot).

Tracked files were checked for runtime data and common credential patterns before
publication. Continue reviewing changes and history before subsequent pushes.
Never add ignored profiles, `.env`, databases or logs with `git add -f`.

Repository publication is distinct from the live account verification. Do not claim
live validation merely because source code is public.
