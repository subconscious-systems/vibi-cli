import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, mock } from 'node:test';
import { generateKeyPair, publicKeyFingerprint } from '@vibivibi/shared/crypto';
import { unwrapPrivateKey, wrapPrivateKey } from '@vibivibi/shared/userkey';
import { changePassword } from '../src/commands/key';
import { readUserKey, writeConfig, writeUserKey } from '../src/config';

test('password changes preserve locked, remembered, and replaced-key storage choices', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibi-password-'));
  const original = {...process.env};
  process.env.VIBI_HOME = dir;
  process.env.VIBI_PASSWORD = 'correct password 123';
  process.env.VIBI_NEW_PASSWORD = 'another password 456';
  const pair = generateKeyPair();
  let remote = {publicKey: pair.publicKey, fingerprint: publicKeyFingerprint(pair.publicKey), encryptedPrivateKey: wrapPrivateKey(pair, process.env.VIBI_PASSWORD), createdAt: 'now', updatedAt: 'now'};
  const fetchMock = mock.method(globalThis, 'fetch', async (_url, init) => {
    if (init?.method === 'PUT') remote = {...remote, ...JSON.parse(String(init.body))};
    return Response.json(remote);
  });
  try {
    writeConfig({serverUrl: 'https://example.test', machineId: 1, machineName: 'test', deviceToken: 'test', enrolledAt: 'now'});
    for (const choice of ['missing', 'locked', 'remembered', 'different']) {
      remote.encryptedPrivateKey = wrapPrivateKey(pair, process.env.VIBI_PASSWORD!);
      if (choice !== 'missing') {
        const stored = choice === 'different' ? generateKeyPair() : pair;
        writeUserKey({publicKey: stored.publicKey, fingerprint: publicKeyFingerprint(stored.publicKey), privateKey: choice === 'locked' ? null : stored.privateKey, createdAt: 'now', unlockedAt: choice === 'locked' ? null : 'remembered-at'});
      }
      await changePassword();
      assert.equal(readUserKey()!.privateKey, choice === 'remembered' ? pair.privateKey : null);
      assert.equal(readUserKey()!.unlockedAt, choice === 'remembered' ? 'remembered-at' : null);
      assert.equal(unwrapPrivateKey(remote.encryptedPrivateKey, pair.publicKey, process.env.VIBI_NEW_PASSWORD!).privateKey, pair.privateKey);
    }
  } finally {
    fetchMock.mock.restore();
    for (const key of ['VIBI_HOME', 'VIBI_PASSWORD', 'VIBI_NEW_PASSWORD']) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
    rmSync(dir, {recursive: true, force: true});
  }
});
