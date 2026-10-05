import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { ApiError, getBytes } from '../src/api';

test('downloads enforce declared and streamed limits and release reader locks', async () => {
  const url = new URL('https://example.test/content');
  let response: Response;
  const fetchMock = mock.method(globalThis, 'fetch', async () => response);
  try {
    let cancelled = false;
    response = new Response(new ReadableStream({cancel() {cancelled = true;}}), {headers: {'content-length': '6'}});
    await assert.rejects(getBytes(url, 'token', undefined, 5), ApiError);
    assert.equal(cancelled, true);
    cancelled = false;
    let chunk = 0;
    response = new Response(new ReadableStream({pull(controller) {controller.enqueue(Buffer.from(chunk++ === 0 ? '123' : '456'));}, cancel() {cancelled = true;}}));
    await assert.rejects(getBytes(url, 'token', undefined, 5), /exceeds/);
    assert.equal(cancelled, true);
    assert.equal(response.body!.locked, false);
    response = new Response(Buffer.from('12345'), {headers: {'content-length': '5'}});
    const progress: number[] = [];
    assert.equal((await getBytes(url, 'token', (loaded) => progress.push(loaded), 5)).toString(), '12345');
    assert.equal(progress.at(-1), 5);
    assert.equal(response.body!.locked, false);
    response = new Response(null);
    assert.equal((await getBytes(url, 'token', undefined, 0)).length, 0);
    await assert.rejects(getBytes(url, 'token', undefined, Infinity), /Invalid/);
    await assert.rejects(getBytes(url, 'token', undefined, -1), /Invalid/);
  } finally {fetchMock.mock.restore();}
});
