import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Harness, TraceMetadata } from '@vibivibi/shared/sessions';
import { configDir } from '../config';

/**
 * Where a downloaded trace goes so the harness on this machine can resume it.
 *
 *   claude   ~/.claude/projects/<project dir, non-alphanumerics -> "-">/<id>.jsonl
 *            (`claude --resume <id>` inside that project directory)
 *   codex    ~/.codex/sessions/YYYY/MM/DD/<original file name>      (`codex resume <id>`)
 *   pi       ~/.pi/agent/sessions/<original file name>              (`pi --session <file>`)
 *   sc       ~/.sc/sessions/<original file name>                    (`marathon --resume <file>`)
 *   opencode ~/.vibi/downloads/opencode-<id>.json, then `opencode import <file>` puts it in
 *            OpenCode's database                                  (`opencode --session <id>`)
 */

export type InstallTarget = {
  harness: Harness;
  harnessSessionId: string;
  harnessUpdatedAt: string;
  metadata: TraceMetadata;
  content: Buffer;
  home: string;
  /** For Claude Code: the project directory on this machine. */
  projectDir?: string;
  overwrite?: boolean;
};

export class InstallConflict extends Error {
  constructor(public readonly file: string) {
    super(`${file} already exists with different content; pass --overwrite to replace it`);
    this.name = 'InstallConflict';
  }
}

/** Claude Code's project directory encoding. */
export function encodeClaudeProjectDir(projectDir: string) {
  return path.resolve(projectDir).replace(/[^a-zA-Z0-9]/g, '-');
}

function originalBasename(metadata: TraceMetadata, fallback: string) {
  const base = path.win32.basename(path.posix.basename(metadata.sourcePath));
  return isSafeFilename(base) && base.endsWith('.jsonl') ? base : fallback;
}

function isSafeFilename(value: string): boolean {
  return Boolean(value) && value !== '.' && value !== '..' &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

export function installPathFor(t: Omit<InstallTarget, 'content' | 'overwrite'>): string {
  if (!isSafeFilename(t.harnessSessionId)) throw new Error('Invalid harness session id for a local file');
  switch (t.harness) {
    case 'claude':
      return path.join(
        t.home,
        '.claude',
        'projects',
        encodeClaudeProjectDir(t.projectDir ?? process.cwd()),
        `${t.harnessSessionId}.jsonl`
      );
    case 'codex': {
      const when = new Date(t.harnessUpdatedAt);
      const yyyy = String(when.getUTCFullYear());
      const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(when.getUTCDate()).padStart(2, '0');
      const stamp = when.toISOString().slice(0, 19).replace(/:/g, '-');
      return path.join(
        t.home,
        '.codex',
        'sessions',
        yyyy,
        mm,
        dd,
        originalBasename(t.metadata, `rollout-${stamp}-${t.harnessSessionId}.jsonl`)
      );
    }
    case 'pi':
      return path.join(t.home, '.pi', 'agent', 'sessions', originalBasename(t.metadata, `${t.harnessSessionId}.jsonl`));
    case 'sc':
      return path.join(t.home, '.sc', 'sessions', originalBasename(t.metadata, `session-${t.harnessSessionId}.jsonl`));
    case 'opencode':
      return path.join(configDir(), 'downloads', `opencode-${t.harnessSessionId}.json`);
  }
}

export type InstallResult = {
  file: string;
  existed: boolean;
  /** OpenCode: the session was handed to `opencode import` and can be resumed; otherwise the file is all there is. */
  imported: boolean;
  /** Why the import did not happen, for the message to the user. */
  importError?: string;
};

/** Writes the plaintext trace where the harness expects it; returns the path. */
export function installTrace(t: InstallTarget): InstallResult {
  const file = installPathFor(t);
  const existed = existsSync(file);
  if (existed && !t.overwrite) {
    const current = readFileSync(file);
    if (!current.equals(t.content)) throw new InstallConflict(file);
  } else {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, t.content, { mode: 0o600 });
  }
  if (t.harness !== 'opencode') return { file, existed, imported: false };
  return { file, existed, ...importIntoOpenCode(file, t.content) };
}

/**
 * OpenCode has no session files to drop in place; its own `opencode import`
 * loads an `opencode export` document into the database (same id, idempotent).
 * Older uploads were summaries, which OpenCode cannot import.
 */
function importIntoOpenCode(file: string, content: Buffer): { imported: boolean; importError?: string } {
  let doc: { info?: { id?: unknown }; messages?: unknown };
  try {
    doc = JSON.parse(content.toString('utf8'));
  } catch {
    return { imported: false, importError: 'the file is not JSON' };
  }
  if (typeof doc?.info?.id !== 'string' || !Array.isArray(doc.messages)) {
    return { imported: false, importError: 'this version was uploaded as a summary, which OpenCode cannot import; push it again from the original machine' };
  }
  const result = spawnSync('opencode', ['import', file], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } });
  if (result.error) return { imported: false, importError: `opencode is not installed here (${result.error.message})` };
  if (result.status !== 0) return { imported: false, importError: `opencode import failed: ${(result.stderr || result.stdout || '').trim().split('\n').pop() ?? ''}` };
  return { imported: true };
}
