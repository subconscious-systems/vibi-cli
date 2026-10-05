import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { installPathFor } from '../src/harnesses/install';
import type { Harness } from '@vibivibi/shared/sessions';

const base = { harnessSessionId: 'session-id', harnessUpdatedAt: '2026-10-01T10:00:00Z', home: path.resolve('test-home'), metadata: {title: '', cwd: '', model: '', messageCount: 0, sourcePath: '', startedAt: null} };
test('untrusted session IDs cannot escape installation directories or create invalid Windows files', () => {
  for (const harness of ['claude', 'codex', 'pi', 'sc', 'opencode'] as Harness[]) {
    for (const id of ['../escape', '..\\escape', '/absolute', 'C:\\absolute', '', '.', '..', 'bad\0id', 'CON', 'name:stream', 'trailing.']) {
      assert.throws(() => installPathFor({...base, harness, harnessSessionId: id}), /Invalid harness session id/);
    }
  }
});
test('source filenames survive Windows to Unix and Unix to Windows transfers', () => {
  for (const sourcePath of ['C:\\Users\\sender\\rollout-original.jsonl', '/Users/sender/rollout-original.jsonl']) {
    const file = installPathFor({...base, harness: 'codex', metadata: {...base.metadata, sourcePath}});
    assert.equal(path.basename(file), 'rollout-original.jsonl');
    assert.equal(path.dirname(file), path.join(base.home, '.codex', 'sessions', '2026', '10', '01'));
  }
  assert.equal(path.basename(installPathFor({...base, harness: 'pi', metadata: {...base.metadata, sourcePath: '/x/bad:name.jsonl'}})), 'session-id.jsonl');
});
