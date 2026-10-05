import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { MAX_TRACE_BYTES } from '@vibivibi/shared/sessions';
import { MAX_PLAINTEXT_BYTES, TraceTooLargeError, uploadVersion } from '../src/upload';

test('oversize ciphertext is rejected before encryption or a network request', async () => {
  assert.equal(MAX_PLAINTEXT_BYTES + 16, MAX_TRACE_BYTES);
  const fetchMock = mock.method(globalThis, 'fetch', () => {throw new Error('must not upload');});
  try {
    await assert.rejects(uploadVersion({} as never, {} as never, {session: {} as never, trace: {bytes: Buffer.alloc(MAX_PLAINTEXT_BYTES + 1), messageCount: 0, startedAt: null}, plaintextHash: '', recipients: []}), TraceTooLargeError);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {fetchMock.mock.restore();}
});
