/** Explicit private-state verification, on a disposable filesystem; never connects to MySQL. */
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceManager, safeError } from '../server/manager';
import { SourceStore } from '../server/store';
import { createBrowserLauncher } from '../server/browser';
import { validatePortableSession } from '../server/portableSession';
import { rinProvider } from '../server/providers/rin';
import { munetProvider } from '../server/providers/munet';
import { otogameProvider } from '../server/providers/otogame';
import type { BindingSubmission } from '../src/sourceBindingTypes';
import type { BrowserSource } from '../src/syncTypes';
const input = process.argv[2];
if (!input) throw new Error('Provide a private sessions.json path; never commit this file.');
const states: (BindingSubmission & { source: BrowserSource })[] = JSON.parse(await readFile(input, 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'machun-portable-check-'));
const results = [];
try {
  for (const state of states) {
    const store = new SourceStore(join(directory, state.source));
    const options = { store, launcher: createBrowserLauncher(), providers: { rin: rinProvider, munet: munetProvider, otogame: otogameProvider }, companionLogin: true };
    let manager = new SourceManager(options);
    const result: Record<string, unknown> = { source: state.source };
    try {
      await manager.initialize();
      await manager.bindPortable(state.source, validatePortableSession(state.source, state.session), state.identity);
      result.restore = 'passed';
      const first = await manager.sync(state.source);
      result.sync = 'passed'; result.records = first.records.length; result.parsed = first.report.parsedScores;
      result.renewedStateSaved = Boolean((await store.load(state.source)).binding?.session);
      await manager.close(); manager = new SourceManager(options); await manager.initialize();
      const second = await manager.sync(state.source);
      result.restart = 'passed'; result.restartRecords = second.records.length; result.incrementalParsed = second.report.parsedScores;
      // Force only the access token expiry in our private copy, leaving the genuine renewal token.
      const saved = await store.load(state.source); const session = saved.binding!.session!;
      if (state.source === 'rin') {
        const account = JSON.parse(session.localStorage.currentAccount); account.accessToken = 'expired-validation-token';
        session.localStorage.currentAccount = JSON.stringify(account);
      } else if (state.source === 'munet') {
        const token = session.localStorage.token.split('.');
        session.localStorage.token = `${token[0]}.${token[1]}.invalid-validation-signature`;
      } else {
        for (const key of ['TOKEN', 'ID_TOKEN']) {
          const wrapped = JSON.parse(session.localStorage[key]); wrapped.expire = 1; session.localStorage[key] = JSON.stringify(wrapped);
        }
      }
      await store.save(state.source, saved); await manager.close(); manager = new SourceManager(options); await manager.initialize();
      try { await manager.sync(state.source); result.forcedRenewal = 'passed'; }
      catch (error) { const safe = safeError(error); result.forcedRenewal = 'failed'; result.renewalCode = safe.code; result.renewalError = safe.message; }
      await manager.unbind(state.source);
      result.unbind = (await store.load(state.source)).binding === null ? 'passed' : 'failed';
    } catch (error) {
      const safe = safeError(error); result.failedAt = result.restore ? 'sync' : 'restore'; result.code = safe.code; result.error = safe.message;
    } finally { await manager.close(); }
    results.push(result); console.log(JSON.stringify(result));
  }
  console.log(JSON.stringify({ platform: process.platform, architecture: process.arch, results }));
} finally { await rm(directory, { recursive: true, force: true }); }
