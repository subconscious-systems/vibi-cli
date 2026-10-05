import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeOutputTrace } from '../src/commands/pull';
import { InstallConflict } from '../src/harnesses/install';

test('pull output preserves different existing content until overwrite is explicit', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibi-output-'));
  try {
    const file = path.join(dir, 'trace.jsonl');
    writeOutputTrace(file, Buffer.from('first'));
    writeOutputTrace(file, Buffer.from('first'));
    assert.throws(() => writeOutputTrace(file, Buffer.from('second')), InstallConflict);
    assert.equal(readFileSync(file, 'utf8'), 'first');
    writeOutputTrace(file, Buffer.from('second'), true);
    assert.equal(readFileSync(file, 'utf8'), 'second');
    const empty = path.join(dir, 'empty');
    writeFileSync(empty, '');
    assert.throws(() => writeOutputTrace(empty, Buffer.from('data')), InstallConflict);
    assert.throws(() => writeOutputTrace(path.join(dir, 'missing', 'trace'), Buffer.from('data')), /ENOENT/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
