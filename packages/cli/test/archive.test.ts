import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { archiveRelease } from '../scripts/archive.mjs';

test('Windows release archives build without an external zip executable', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibi archive spaces '));
  try {
    const source = path.join(dir, 'vibi.exe');
    const asset = path.join(dir, 'vibi-windows-x64.zip');
    writeFileSync(source, 'executable fixture');
    archiveRelease(asset, source);
    const bytes = readFileSync(asset);
    assert.equal(bytes.subarray(0, 2).toString(), 'PK');
    if (process.platform === 'win32') {
      const destination = path.join(dir, 'unpacked');
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:VIBI_ARCHIVE_SOURCE -DestinationPath $env:VIBI_ARCHIVE_DESTINATION'], {env: {...process.env, VIBI_ARCHIVE_SOURCE: asset, VIBI_ARCHIVE_DESTINATION: destination}});
      assert.equal(readFileSync(path.join(destination, 'vibi.exe'), 'utf8'), 'executable fixture');
    } else {
      assert.equal(execFileSync('unzip', ['-p', asset, 'vibi.exe'], {encoding: 'utf8'}), 'executable fixture');
    }
  } finally {rmSync(dir, {recursive: true, force: true});}
});
