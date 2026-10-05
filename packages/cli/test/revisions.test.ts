import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectVersion } from '../src/commands/pull';
import type { SessionDetail } from '@vibivibi/shared/sessions';

const versions = [{id: 80, seq: 1, status: 'stored', contentHash: 'vHash_ABC'}, {id: 90, seq: 2, status: 'stored', contentHash: '1different'}, {id: 91, seq: 3, status: 'pending', contentHash: 'pending'}] as SessionDetail['versions'];
test('version numbers cannot collide with hash prefixes and hashes retain their first character', () => {
  assert.equal(selectVersion(versions, '1'), versions[0]);
  assert.equal(selectVersion(versions, ' v2 '), versions[1]);
  assert.equal(selectVersion(versions, 'vHash'), versions[0]);
  assert.equal(selectVersion(versions, 'id:90'), versions[1]);
  for (const ref of ['', ' ', '3', 'id:91', 'id:NaN', 'v0', 'v999', 'VHash']) assert.throws(() => selectVersion(versions, ref), /matches 0/);
  assert.throws(() => selectVersion([...versions, {...versions[0], id: 95, contentHash: 'vHash_other'}], 'vHash'), /matches 2/);
});
