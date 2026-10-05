import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, mock } from 'node:test';
import { generateKeyPair, publicKeyFingerprint } from '@vibivibi/shared/crypto';
import { encryptTrace, decryptTrace } from '@vibivibi/shared/envelope';
import { sendSession, sessionStatus } from '../src/push';
import { readState, writeState } from '../src/state';
import { sha256 } from '../src/upload';

test('reusing a stored version for a send updates the local sync status without reuploading', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibi-send-'));
  const original = process.env.VIBI_HOME;
  process.env.VIBI_HOME = dir;
  const pair = generateKeyPair();
  const other = generateKeyPair();
  const bytes = Buffer.from('{"type":"user","message":{"role":"user","content":"trace"}}\n');
  const sourcePath = path.join(dir, 'trace.jsonl');
  writeFileSync(sourcePath, bytes);
  const session = {key: 'claude:id', harness: 'claude' as const, id: 'id', title: 't', cwd: '', model: '', updatedMs: 2000, mtimeMs: 2000, sizeBytes: bytes.length, sourcePath};
  const encrypted = encryptTrace({content: bytes, metadata: {title: 't', cwd: '', model: '', messageCount: 1, sourcePath, startedAt: null}, recipients: [pair.publicKey]});
  let putCount = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async (_url, init) => {
    if (init?.method === 'PUT') {
      putCount++;
      const {envelope} = JSON.parse(String(init.body));
      assert.deepEqual(decryptTrace({header: envelope, ciphertext: encrypted.ciphertext, pair: other}).content, bytes);
      return Response.json({sessionId: 1, versionId: 2});
    }
    assert.equal(init?.method, 'GET');
    return Response.json({id: 1, pullId: 'new-pull', machineName: 'test', harness: 'claude', harnessSessionId: 'id', harnessUpdatedAt: 'now', label: 'old', currentVersionId: 2, versions: [{id: 2, seq: 1, machineName: 'test', contentHash: encrypted.header.content.hash, sizeBytes: encrypted.ciphertext.length, keyFingerprint: publicKeyFingerprint(pair.publicKey), status: 'stored', createdAt: 'now', storedAt: 'now', sharedWith: [], envelope: encrypted.header}]});
  });
  try {
    writeState({version: 1, pending: {}, sessions: {[session.key]: {...session, mtimeMs: 1000, updatedMs: 1000, sessionId: 1, versionId: 2, plaintextHash: sha256(bytes), keyFingerprint: publicKeyFingerprint(pair.publicKey), syncedAt: 'now', label: 'old', pullId: 'old-pull'}}});
    assert.equal(sessionStatus(session, readState()), 'changed');
    const result = await sendSession({serverUrl: 'https://example.test', machineId: 1, machineName: 'test', deviceToken: 'token', enrolledAt: 'now'}, {...pair, fingerprint: publicKeyFingerprint(pair.publicKey), createdAt: 'now', unlockedAt: 'now'}, session, undefined, 'other@example.test', {recipient: {email: 'other@example.test', publicKey: other.publicKey, provisional: false, passphrase: null, registered: true}});
    assert.equal(result.reusedVersion, true);
    assert.equal(result.uploaded, false);
    assert.equal(putCount, 1);
    assert.equal(sessionStatus(session, readState()), 'synced');
    assert.equal(readState().sessions[session.key].pullId, 'new-pull');
    assert.equal(readState().sessions[session.key].label, 'old');
  } finally {
    fetchMock.mock.restore();
    if (original === undefined) delete process.env.VIBI_HOME; else process.env.VIBI_HOME = original;
    rmSync(dir, {recursive: true, force: true});
  }
});
