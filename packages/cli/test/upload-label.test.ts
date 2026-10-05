import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, mock } from 'node:test';
import { generateKeyPair, publicKeyFingerprint } from '@vibivibi/shared/crypto';
import { uploadVersion } from '../src/upload';
import { readState } from '../src/state';

test('explicit null clears an uploaded label while omission preserves it', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibi-label-'));
  const original = process.env.VIBI_HOME;
  process.env.VIBI_HOME = dir;
  const pair = generateKeyPair();
  const key = {...pair, fingerprint: publicKeyFingerprint(pair.publicKey), createdAt: 'now', unlockedAt: 'now'};
  const session = {key: 'claude:id', harness: 'claude' as const, id: 'id', title: 't', cwd: '', model: '', updatedMs: Date.now(), mtimeMs: 0, sizeBytes: 1, sourcePath: ''};
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({sessionId: 1, pullId: 'pull', versionId: 2, seq: 1, status: 'stored', upload: null}));
  try {
    const input = {session, trace: {bytes: Buffer.from('trace'), messageCount: 0, startedAt: null}, plaintextHash: 'hash', recipients: [pair.publicKey]};
    const config = {serverUrl: 'https://example.test', machineId: 1, machineName: 'test', deviceToken: 'test', enrolledAt: 'now'};
    await uploadVersion(config, key, {...input, label: 'old label'});
    await uploadVersion(config, key, input);
    assert.equal(readState().sessions[session.key].label, 'old label');
    await uploadVersion(config, key, {...input, label: null});
    assert.equal(readState().sessions[session.key].label, null);
    await uploadVersion(config, key, {...input, label: ''});
    assert.equal(readState().sessions[session.key].label, '');
  } finally {
    fetchMock.mock.restore();
    if (original === undefined) delete process.env.VIBI_HOME; else process.env.VIBI_HOME = original;
    rmSync(dir, {recursive: true, force: true});
  }
});
