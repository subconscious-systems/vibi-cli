import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseLines, firstTimestamp } from '../src/harnesses/jsonl';
import { claudeAdapter } from '../src/harnesses/claude';

test('JSON scalars and partial records cannot hide an otherwise valid transcript', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibi-jsonl-'));
  const folder = path.join(dir, '.claude', 'projects', '-work');
  const good = {type: 'user', sessionId: 'visible', cwd: '/work', message: {role: 'user', content: 'Keep this session'}};
  const contents = `null\n42\n"text"\n[]\n${JSON.stringify(good)}\n{"partial":`;
  assert.deepEqual(parseLines(contents), [good]);
  try {
    await mkdir(folder, {recursive: true});
    await writeFile(path.join(folder, 'visible.jsonl'), contents);
    const found = await claudeAdapter.discover({home: dir, max: 10, execute: (() => {}) as never});
    assert.equal(found.length, 1);
    assert.equal(found[0].id, 'visible');
    assert.equal((await claudeAdapter.readTrace(found[0], {} as never)).messageCount, 1);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
test('out-of-range timestamps are ignored so valid later timestamps remain usable', () => {
  assert.equal(firstTimestamp([{timestamp: Infinity}, {timestamp: 1e20}, {timestamp: 'invalid'}, {timestamp: '2026-10-01T10:00:00Z'}]), '2026-10-01T10:00:00Z');
  assert.equal(firstTimestamp([{timestamp: 1e20}]), null);
});
