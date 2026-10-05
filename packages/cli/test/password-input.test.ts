import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const moduleUrl = new URL('../src/password.ts', import.meta.url).href;
function run(input: string, body: string) {
  const env = {...process.env};
  delete env.VIBI_PASSWORD;
  delete env.VIBI_NEW_PASSWORD;
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {promptHidden, promptNewPassword} from ${JSON.stringify(moduleUrl)}; ${body}`], {input, env, encoding: 'utf8', timeout: 5000});
}
test('piped passwords and confirmations consume separate buffered lines', () => {
  const result = run('a correct password\na correct password\n', 'console.log(await promptNewPassword());');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'a correct password');
  const lines = run('first\nsecond\n', 'console.log(JSON.stringify([await promptHidden(""), await promptHidden(""), await promptHidden("")]));');
  assert.equal(lines.status, 0, lines.stderr);
  assert.deepEqual(JSON.parse(lines.stdout), ['first', 'second', '']);
});
test('closed, short, mismatched, and missing confirmation inputs terminate', () => {
  for (const input of ['', 'short\n', 'a correct password\n', 'a correct password\na different password\n']) {
    const result = run(input, 'await promptNewPassword();');
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.error, undefined);
  }
});
