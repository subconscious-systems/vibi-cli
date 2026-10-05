import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function archiveRelease(asset, outfile) {
  if (asset.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Compress-Archive -LiteralPath $env:VIBI_ARCHIVE_SOURCE -DestinationPath $env:VIBI_ARCHIVE_DESTINATION -Force'], {
        stdio: 'inherit',
        env: {...process.env, VIBI_ARCHIVE_SOURCE: outfile, VIBI_ARCHIVE_DESTINATION: asset}
      });
    } else execFileSync('zip', ['-q', '-j', asset, outfile], {stdio: 'inherit'});
  } else execFileSync('tar', ['-czf', asset, '-C', path.dirname(outfile), path.basename(outfile)], {stdio: 'inherit'});
}
