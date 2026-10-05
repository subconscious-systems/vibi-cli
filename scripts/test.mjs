import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['packages/shared/test', 'packages/cli/test'].flatMap((dir) =>
  readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((name) => name.endsWith('.test.ts')).sort().map((name) => `${dir}/${name}`)
);
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {cwd: root, stdio: 'inherit'});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
