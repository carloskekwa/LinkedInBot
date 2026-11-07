import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pino } from 'pino';
import { loadConfig, loadPrompt } from './config.js';
import { PlaywrightAdapter } from './browser.js';
import { LlmGenerator } from './ai.js';
import { Store } from './storage.js';
import { Bot } from './runtime.js';
import { acquireLock } from './lock.js';
import { report } from './metrics.js';
import { demo } from './demo.js';
import { inspectLive } from './inspect.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const log = pino({ level: process.env.LOG_LEVEL ?? 'info',
  redact: ['apiKey', 'password', 'token', 'cookies', 'text', 'reply', 'headers.authorization'] });

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm start -- [--dry-run | --live | --login | --smoke | --inspect | --demo | --report]');
    return;
  }
  const valid = ['--dry-run', '--live', '--login', '--smoke', '--inspect', '--demo', '--report'];
  if (args.length > 1 || args.some(arg => !valid.includes(arg))) {
    throw new Error('Choose exactly one documented CLI mode; use --help');
  }
  if (args[0] === '--demo') { await demo(log); return; }
  const config = loadConfig();
  log.level = config.LOG_LEVEL;
  const dataDir = resolve(config.DATA_DIR);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  if (args[0] === '--report') {
    const path = join(dataDir, 'bot.db');
    if (!existsSync(path)) throw new Error('No live-mode database; run the bot before reporting');
    const store = new Store(path);
    try {
      console.log(JSON.stringify({
        configuredPollMs: { invitation: config.INVITATION_POLL_MS, message: config.MESSAGE_POLL_MS },
        metrics: report(store.all()),
      }, null, 2));
    } finally { store.close(); }
    return;
  }
  const live = args[0] === '--live';
  if (live && !config.ACKNOWLEDGE_PLATFORM_RISK) {
    throw new Error('Live mode requires ACKNOWLEDGE_PLATFORM_RISK=true; read README first');
  }
  const generator = ['--login', '--smoke', '--inspect'].includes(args[0]!)
    ? undefined : new LlmGenerator(config, loadPrompt(config), log);
  mkdirSync(resolve(config.BROWSER_PROFILE), { recursive: true, mode: 0o700 });
  chmodSync(resolve(config.BROWSER_PROFILE), 0o700);
  const unlock = acquireLock(join(resolve(config.BROWSER_PROFILE), 'assistant.lock'));
  let adapter: PlaywrightAdapter | undefined;
  let store: Store | undefined;
  try {
    if (args[0] === '--inspect') {
      await inspectLive(config, log, controller.signal);
      return;
    }
    adapter = await PlaywrightAdapter.open(config, log);
    await adapter.login(controller.signal);
    if (args[0] === '--login') {
      log.info('Authenticated session saved in local Chromium profile; browser will now close');
      return;
    }
    await adapter.initialize();
    if (args[0] === '--smoke') {
      const invitations = await adapter.invitations();
      const threads = await adapter.conversations();
      let supportedThreads = 0, messages = 0, ownMessages = 0, exactReceipts = 0, classificationFailures = 0;
      for (const id of threads.slice(0, config.THREAD_LIMIT)) {
        try {
          const thread = await adapter.thread(id);
          supportedThreads += Number(thread.supported);
          messages += thread.messages.length;
          ownMessages += thread.messages.filter(m => m.own).length;
          exactReceipts += thread.messages.filter(m => m.receipt.precision === 'exact').length;
        } catch (error) {
          classificationFailures++;
          const message = error instanceof Error ? error.message : '';
          log.warn({ errorType: error instanceof Error ? error.name : 'unknown',
            // Only static diagnostics are logged; anything containing URLs/paths is withheld.
            detail: message && !/[/\\]|https?:/i.test(message) ? message.slice(0, 200) : undefined },
            'Thread could not be read/classified; the bot would skip it');
        }
      }
      log.info({ connectionInvitations: invitations.length, threads: threads.length,
        supportedThreads, messages, ownMessages, incomingMessages: messages - ownMessages,
        exactReceipts, classificationFailures },
        'Read-only smoke completed. No acceptance or send was attempted');
      return;
    }
    store = new Store(join(dataDir, live ? 'bot.db' : 'dry-run.db'));
    store.bindOwner(adapter.ownerIdentity());
    if (!generator) throw new Error('Reply generator missing for bot mode');
    const bot = new Bot(adapter, store, generator, config, log, live, controller.signal);
    log.info({ live, initialHistory: config.INITIAL_HISTORY,
      invitationPollMs: config.INVITATION_POLL_MS, messagePollMs: config.MESSAGE_POLL_MS },
      'Bot started; stop with Ctrl+C. Dry-run state is isolated from live state');
    await bot.run();
  } finally {
    try { if (adapter) await adapter.close(); }
    finally {
      try { store?.close(); }
      finally { unlock(); }
    }
  }
}
main().catch(error => {
  if (controller.signal.aborted) { log.info('Stopped; unfinished actions will be reconciled on restart'); return; }
  // Do not log arbitrary exception objects: HTTP/browser errors may contain private data.
  const safe = error instanceof Error ? error.name : 'unknown';
  const message = error instanceof Error ? error.message : '';
  if (/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_TOO_MANY_REDIRECTS|net::ERR_/.test(message)) {
    log.error({ errorType: safe, networkError: /net::[A-Z_]+/.exec(message)?.[0] },
      'LinkedIn returned an HTTP error. This is often temporary rate limiting after many ' +
      'page loads. Do NOT retry in a loop; wait 10-15 minutes and avoid repeated smoke/inspect runs');
  } else {
    log.error({ errorType: safe }, 'Startup/runtime failed. Check config, browser install, selectors and README');
  }
  if (error instanceof Error && error.name === 'ZodError') {
    console.error('Configuration or data validation failed; check documented field types and consent flags.');
  } else if (message && !/https?:|Bearer|cookie|token|password|api.?key|\/in\//i.test(message)) {
    console.error(message);
  }
  process.exitCode = 1;
});
