import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, mock } from 'node:test';
import { sessions } from '../src/commands/sessions';
import { opencodeAdapter } from '../src/harnesses/opencode';
import { writeState } from '../src/state';

test('sessions reports changed database sessions even when file size and mtime remain zero', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibi-status-'));
  const previous = {...process.env};
  process.env.VIBI_HOME = dir;
  process.env.VIBI_HARNESSES = 'opencode';
  const session = {key: 'opencode:id', harness: 'opencode' as const, id: 'id', title: 'Database session', cwd: '', model: '', updatedMs: 1000, mtimeMs: 0, sizeBytes: 0, sourcePath: ''};
  const discover = mock.method(opencodeAdapter, 'discover', async () => [session]);
  const output = mock.method(console, 'log', () => {});
  try {
    const state = {version: 1 as const, pending: {}, sessions: {[session.key]: {...session, sessionId: 1, versionId: 1, plaintextHash: 'h', keyFingerprint: 'f', syncedAt: 'now'}}};
    writeState(state);
    await sessions({max: '10'});
    assert.match(String(output.mock.calls.at(-1)!.arguments[0]), /synced$/);
    session.updatedMs = 2000;
    await sessions({max: '10'});
    assert.match(String(output.mock.calls.at(-1)!.arguments[0]), /changed$/);
  } finally {
    discover.mock.restore(); output.mock.restore();
    for (const key of ['VIBI_HOME', 'VIBI_HARNESSES']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    rmSync(dir, {recursive: true, force: true});
  }
});
