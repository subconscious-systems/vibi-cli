#!/usr/bin/env node
// Builds the vibi client with Bun (https://bun.sh):
//   dist/vibi.mjs                the npm package's bundle (Node 20+, run by bin/vibi.mjs)
//   dist/bin/<target>/vibi       standalone executables: Bun runtime + bundle + the Go TUI,
//                                nothing to install first (these are what install.sh fetches)
//   dist/release/*.tar.gz|.zip   the executables packaged for a GitHub release, plus checksums.txt
//
//   node scripts/build-cli.mjs              npm bundle + executables for every target
//   node scripts/build-cli.mjs --host       npm bundle + the executable for this machine only
//   node scripts/build-cli.mjs --npm-only   just the npm bundle (what `prepack` runs)
//   node scripts/build-cli.mjs --target linux-x64 [--target ...]
//
// The TUI binaries must exist first: `node scripts/build-tui.mjs` (needs Go).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveRelease } from './archive.mjs';

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(CLI_DIR, 'dist');
const VERSION = JSON.parse(fs.readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8')).version;

// name: what install.sh asks for; bun: Bun's --target; tui: the Go build from build-tui.mjs
export const TARGETS = [
  { name: 'darwin-arm64', bun: 'bun-darwin-arm64', tui: 'vibi-tui-darwin-arm64' },
  { name: 'darwin-x64', bun: 'bun-darwin-x64', tui: 'vibi-tui-darwin-amd64' },
  { name: 'linux-x64', bun: 'bun-linux-x64', tui: 'vibi-tui-linux-amd64' },
  { name: 'linux-arm64', bun: 'bun-linux-arm64', tui: 'vibi-tui-linux-arm64' },
  { name: 'windows-x64', bun: 'bun-windows-x64', tui: 'vibi-tui-windows-amd64.exe', exe: '.exe' }
];

function hostTargetName() {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
  const arch = { arm64: 'arm64', x64: 'x64' }[process.arch];
  if (!os || !arch) throw new Error(`No standalone build for ${process.platform}/${process.arch}`);
  return `${os}-${arch}`;
}

const args = process.argv.slice(2);
const npmOnly = args.includes('--npm-only');
const wanted = args.flatMap((a, i) => (a === '--target' ? [args[i + 1]] : []));
const selected = npmOnly ? [] : args.includes('--host') ? [hostTargetName()] : wanted.length ? wanted : TARGETS.map((t) => t.name);
const targets = selected.map((name) => {
  const t = TARGETS.find((x) => x.name === name);
  if (!t) throw new Error(`Unknown target ${name}; known: ${TARGETS.map((x) => x.name).join(', ')}`);
  return t;
});

const bun = (cmdArgs) => execFileSync('bun', cmdArgs, { cwd: CLI_DIR, stdio: 'inherit' });
const define = ['--define', `__VIBI_VERSION__=${JSON.stringify(VERSION)}`];

fs.mkdirSync(DIST, { recursive: true });
console.log(`vibi ${VERSION}: npm bundle -> dist/vibi.mjs`);
bun(['build', 'src/index.ts', '--target=node', '--format=esm', '--outfile', path.join(DIST, 'vibi.mjs'), ...define]);

if (targets.length) {
  const entries = path.join(DIST, 'entries');
  const release = path.join(DIST, 'release');
  fs.mkdirSync(entries, { recursive: true });
  fs.mkdirSync(release, { recursive: true });
  const checksums = [];
  for (const t of targets) {
    const tui = path.join(CLI_DIR, 'bin', 'native', t.tui);
    if (!fs.existsSync(tui)) throw new Error(`${path.relative(CLI_DIR, tui)} is missing; run \`node scripts/build-tui.mjs\` first.`);
    // A one-line entry per target: Bun embeds the file it imports with type "file".
    const entry = path.join(entries, `${t.name}.ts`);
    fs.writeFileSync(
      entry,
      `import tui from '../../bin/native/${t.tui}' with { type: 'file' };\n` +
        `globalThis.__VIBI_EMBEDDED_TUI = tui;\n` +
        `await import('../../src/index.ts');\n`
    );
    const outDir = path.join(DIST, 'bin', t.name);
    fs.mkdirSync(outDir, { recursive: true });
    const outfile = path.join(outDir, `vibi${t.exe ?? ''}`);
    console.log(`standalone ${t.name} -> ${path.relative(CLI_DIR, outfile)}`);
    bun(['build', '--compile', `--target=${t.bun}`, '--minify', ...define, entry, '--outfile', outfile]);

    const asset = path.join(release, `vibi-${t.name}${t.exe ? '.zip' : '.tar.gz'}`);
    fs.rmSync(asset, { force: true });
    archiveRelease(asset, outfile);
    const digest = createHash('sha256').update(fs.readFileSync(asset)).digest('hex');
    checksums.push(`${digest}  ${path.basename(asset)}`);
    console.log(`  ${path.relative(CLI_DIR, asset)} (${(fs.statSync(asset).size / 1048576).toFixed(1)} MB)`);
  }
  // Partial builds (--host, --target) keep the other lines so a release can be assembled in steps.
  const file = path.join(release, 'checksums.txt');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const updated = new Map(existing.map((l) => [l.split(/\s+/)[1], l]));
  for (const line of checksums) updated.set(line.split(/\s+/)[1], line);
  fs.writeFileSync(file, [...updated.values()].sort((a, b) => a.localeCompare(b)).join('\n') + '\n');
  console.log(`checksums -> ${path.relative(CLI_DIR, file)}`);
}
