import { harnessName } from '@vibivibi/shared/sessions';
import { discoverContext, discoverLocalSessions, scanHome } from '../harnesses';
import { readState } from '../state';
import { sessionStatus } from '../push';

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Lists the coding-agent sessions found on this machine. */
export async function sessions(opts: { max: string; json?: boolean }) {
  const max = Math.max(1, Number(opts.max) || 200);
  const found = await discoverLocalSessions(discoverContext(max));
  if (opts.json) {
    console.log(JSON.stringify(found, null, 2));
    return;
  }
  const state = readState();
  console.log(`Scanning ${scanHome()} — ${found.length} session(s) found\n`);
  for (const s of found) {
    const status = sessionStatus(s, state);
    console.log(`${s.key}  ${s.title}`);
    console.log(
      `    ${harnessName(s.harness)} · ${new Date(s.updatedMs).toLocaleString()}` +
        `${s.cwd ? ` · ${s.cwd}` : ''}${s.sizeBytes ? ` · ${formatSize(s.sizeBytes)}` : ''} · ${status}`
    );
  }
}
