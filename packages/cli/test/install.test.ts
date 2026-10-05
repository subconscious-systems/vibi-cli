import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { InstallConflict, encodeClaudeProjectDir, installPathFor, installTrace } from '../src/harnesses/install';

let home: string;
before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'vibi-install-test-'));
  process.env.VIBI_HOME = path.join(home, '.vibi');
});
after(async () => {
  await rm(home, { recursive: true, force: true });
});

const meta = { title: 't', cwd: '/work/x', model: '', messageCount: 1, sourcePath: '', startedAt: null };

test('Claude Code project directories are encoded the way Claude Code does it', () => {
  const prefix = process.platform === 'win32' ? `${path.parse(process.cwd()).root[0]}--` : '-';
  assert.equal(encodeClaudeProjectDir('/Users/hongyinluo/Desktop/cybermind'), `${prefix}Users-hongyinluo-Desktop-cybermind`);
  assert.equal(encodeClaudeProjectDir('/Users/me/my_app.v2'), `${prefix}Users-me-my-app-v2`);
  const file = installPathFor({ harness: 'claude', harnessSessionId: 'abc', harnessUpdatedAt: '2026-10-01T10:00:00Z', metadata: meta, home, projectDir: '/work/x' });
  assert.equal(file, path.join(home, '.claude', 'projects', `${prefix}work-x`, 'abc.jsonl'));
});

test('other harnesses keep their original file names and date folders', () => {
  const codex = installPathFor({ harness: 'codex', harnessSessionId: 'u-u-i-d', harnessUpdatedAt: '2026-10-01T10:05:00Z', metadata: { ...meta, sourcePath: '/x/rollout-2026-10-01T10-00-00-u-u-i-d.jsonl' }, home });
  assert.equal(codex, path.join(home, '.codex', 'sessions', '2026', '10', '01', 'rollout-2026-10-01T10-00-00-u-u-i-d.jsonl'));
  const codexNoSource = installPathFor({ harness: 'codex', harnessSessionId: 'u-u-i-d', harnessUpdatedAt: '2026-10-01T10:05:00Z', metadata: meta, home });
  assert.equal(path.basename(codexNoSource), 'rollout-2026-10-01T10-05-00-u-u-i-d.jsonl');
  assert.equal(installPathFor({ harness: 'pi', harnessSessionId: 'pi-id', harnessUpdatedAt: '2026-10-01T10:05:00Z', metadata: { ...meta, sourcePath: '/y/pi_2026_pi-id.jsonl' }, home }), path.join(home, '.pi', 'agent', 'sessions', 'pi_2026_pi-id.jsonl'));
  assert.equal(installPathFor({ harness: 'sc', harnessSessionId: 'sc-id', harnessUpdatedAt: '2026-10-01T10:05:00Z', metadata: meta, home }), path.join(home, '.sc', 'sessions', 'session-sc-id.jsonl'));
  assert.equal(installPathFor({ harness: 'opencode', harnessSessionId: 'ses_1', harnessUpdatedAt: '2026-10-01T10:05:00Z', metadata: meta, home }), path.join(home, '.vibi', 'downloads', 'opencode-ses_1.json'));
});

test('installTrace writes once, tolerates identical re-installs, refuses silent overwrite', async () => {
  const base = { harness: 'claude' as const, harnessSessionId: 'abc', harnessUpdatedAt: '2026-10-01T10:00:00Z', metadata: meta, home, projectDir: '/work/x' };
  const first = installTrace({ ...base, content: Buffer.from('one\n') });
  assert.equal(first.existed, false);
  assert.equal(await readFile(first.file, 'utf8'), 'one\n');
  const again = installTrace({ ...base, content: Buffer.from('one\n') });
  assert.equal(again.existed, true);
  assert.throws(() => installTrace({ ...base, content: Buffer.from('two\n') }), InstallConflict);
  const forced = installTrace({ ...base, content: Buffer.from('two\n'), overwrite: true });
  assert.equal(await readFile(forced.file, 'utf8'), 'two\n');
});
