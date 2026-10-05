import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readState, statePath, writeState } from '../src/state';

test('corrupt state cannot silently erase provisional keys, and valid updates replace files atomically', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibi-state-'));
  const original = process.env.VIBI_HOME;
  process.env.VIBI_HOME = dir;
  try {
    assert.deepEqual(readState(), {version: 1, sessions: {}, pending: {}});
    const valid = {version: 1 as const, sessions: {}, pending: {}};
    writeState(valid);
    assert.deepEqual(readState(), valid);
    writeState(valid);
    assert.deepEqual(readdirSync(dir), ['state.json']);
    for (const broken of ['{"pending":', '{"version":2,"sessions":{},"pending":{}}']) {
      writeFileSync(statePath(), broken);
      assert.throws(readState, /Cannot read local state/);
      assert.throws(() => writeState(valid), /Cannot read local state/);
      assert.equal(readFileSync(statePath(), 'utf8'), broken);
    }
  } finally {
    if (original === undefined) delete process.env.VIBI_HOME; else process.env.VIBI_HOME = original;
    rmSync(dir, {recursive: true, force: true});
  }
});
