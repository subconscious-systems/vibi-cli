import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSession } from '../src/commands/push';
import type { LocalSession } from '../src/harnesses';

const session = (id: string, harness = 'claude') => ({id, harness, key: `${harness}:${id}`} as LocalSession);
test('prefixes must identify exactly one session and exact IDs take precedence', () => {
  const sessions = [session('abc-1'), session('abc-2'), session('abc')];
  assert.throws(() => findSession(sessions, 'ab'), /ambiguous/);
  assert.equal(findSession(sessions, 'abc'), sessions[2]);
  assert.equal(findSession(sessions, ' claude:abc-1 '), sessions[0]);
  assert.equal(findSession(sessions, ''), null);
  assert.equal(findSession(sessions, 'missing'), null);
  assert.equal(findSession(sessions, '2'), sessions[1]);
  assert.equal(findSession(sessions, '999'), null);
  assert.equal(findSession(sessions, '1e0'), null);
  const sameId = [session('same'), session('same', 'pi')];
  assert.throws(() => findSession(sameId, 'same'), /ambiguous/);
  assert.equal(findSession(sameId, 'pi:same'), sameId[1]);
  const numeric = [session('other'), session('1')];
  assert.equal(findSession(numeric, '1'), numeric[1]);
});
