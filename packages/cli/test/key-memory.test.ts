import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, mock } from 'node:test';
import { generateKeyPair, publicKeyFingerprint } from '@vibivibi/shared/crypto';
import { wrapPrivateKey } from '@vibivibi/shared/userkey';
import { createUserKey, ensureUserKey } from '../src/userkey';
import { readUserKey, writeUserKey } from '../src/config';

test('no-remember keeps new and existing keys available in memory without storing them', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibi-memory-'));
  const original = {home: process.env.VIBI_HOME, password: process.env.VIBI_PASSWORD};
  process.env.VIBI_HOME = dir;
  process.env.VIBI_PASSWORD = 'correct password 123';
  const config = {serverUrl: 'https://example.test', machineId: 1, machineName: 'test', deviceToken: 'test', enrolledAt: 'now'};
  const pair = generateKeyPair();
  const remote = {publicKey: pair.publicKey, fingerprint: publicKeyFingerprint(pair.publicKey), encryptedPrivateKey: wrapPrivateKey(pair, process.env.VIBI_PASSWORD), createdAt: 'now', updatedAt: 'now'};
  const fetchMock = mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : remote;
    return Response.json({...remote, ...body, fingerprint: publicKeyFingerprint(body.publicKey)});
  });
  try {
    const created = await createUserKey(config, {remember: false});
    assert.ok(created.privateKey);
    assert.equal(readUserKey()!.privateKey, null);
    const unlocked = await ensureUserKey(config, {unlock: true, remember: false});
    assert.equal(unlocked.privateKey, pair.privateKey);
    assert.equal(readUserKey()!.privateKey, null);
    writeUserKey(unlocked);
    const cached = await ensureUserKey(config, {unlock: true, remember: false});
    assert.equal(cached.privateKey, pair.privateKey);
    assert.equal(readUserKey()!.privateKey, null);
  } finally {
    fetchMock.mock.restore();
    for (const [key, value] of [['VIBI_HOME', original.home], ['VIBI_PASSWORD', original.password]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    rmSync(dir, {recursive: true, force: true});
  }
});
