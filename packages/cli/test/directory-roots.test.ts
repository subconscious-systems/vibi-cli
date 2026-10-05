import assert from 'node:assert/strict';
import path from 'node:path';
import { test, mock } from 'node:test';
import { sessionsForDirectory } from '../src/push';
import { piAdapter } from '../src/harnesses/pi';

test('directory matching includes filesystem roots and descendants but excludes siblings', async () => {
  const original = process.env.VIBI_HARNESSES;
  process.env.VIBI_HARNESSES = 'pi';
  const root = path.parse(process.cwd()).root;
  const project = path.join(root, 'work', 'project');
  const make = (id: string, cwd: string) => ({id, key: `pi:${id}`, harness: 'pi' as const, title: '', cwd, model: '', updatedMs: 1, mtimeMs: 0, sizeBytes: 0, sourcePath: ''});
  const rows = [make('project', project), make('child', path.join(project, 'child')), make('sibling', `${project}-other`), make('parent', path.dirname(project)), make('unknown', '')];
  const discover = mock.method(piAdapter, 'discover', async () => rows);
  try {
    assert.equal((await sessionsForDirectory(root)).length, 4);
    assert.deepEqual(new Set((await sessionsForDirectory(project)).map((s) => s.id)), new Set(['project', 'child']));
    if (process.platform === 'win32') assert.deepEqual(new Set((await sessionsForDirectory(project.toUpperCase())).map((s) => s.id)), new Set(['project', 'child']));
  } finally {
    discover.mock.restore();
    if (original === undefined) delete process.env.VIBI_HARNESSES; else process.env.VIBI_HARNESSES = original;
  }
});
