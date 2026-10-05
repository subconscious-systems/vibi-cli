import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, mock } from 'node:test';
import { generateKeyPair, publicKeyFingerprint } from '@vibivibi/shared/crypto';
import { pending, pendingKeyFor } from '../src/commands/pending';
import { writeConfig } from '../src/config';
import { readState, writeState } from '../src/state';

test('stale provisional keys cannot reset or advertise a different remote key', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibi-pending-'));
  const original = process.env.VIBI_HOME;
  process.env.VIBI_HOME = dir;
  const old = generateKeyPair();
  const current = generateKeyPair();
  const email = 'person@example.test';
  const row = {id: 9, email, fingerprint: publicKeyFingerprint(current.publicKey), createdAt: 'now', expiresAt: '2099-01-01', claimedAt: null, shareCount: 1};
  const calls = mock.method(globalThis, 'fetch', async () => Response.json({pending: [row]}));
  const output = mock.method(console, 'log', () => {});
  try {
    writeConfig({serverUrl: 'https://example.test', machineId: 1, machineName: 'test', deviceToken: 'test', enrolledAt: 'now'});
    const local = {...old, id: 8, email, fingerprint: publicKeyFingerprint(old.publicKey), passphrase: 'old-passphrase', createdAt: 'now'};
    writeState({version: 1, sessions: {}, pending: {[email]: local}});
    assert.equal(pendingKeyFor(readState(), row), undefined);
    assert.equal(pendingKeyFor(readState(), {...row, fingerprint: local.fingerprint})?.passphrase, local.passphrase);
    await assert.rejects(pending({reset: email}), /current provisional key/);
    assert.equal(calls.mock.callCount(), 1);
    assert.equal(readState().pending[email].passphrase, local.passphrase);
    await pending({json: true});
    assert.equal(JSON.parse(String(output.mock.calls.at(-1)!.arguments[0]))[0].passphrase, null);
  } finally {
    calls.mock.restore(); output.mock.restore();
    if (original === undefined) delete process.env.VIBI_HOME; else process.env.VIBI_HOME = original;
    rmSync(dir, {recursive: true, force: true});
  }
});
