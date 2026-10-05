import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  harnessName,
  listRemoteSessionsResponseSchema,
  sessionDetailResponseSchema,
  type EnvelopeHeader,
  type Harness,
  type RemoteSession,
  type SessionDetail,
  type SharedSession
} from '@vibivibi/shared/sessions';
import { decryptMetadata, decryptTrace } from '@vibivibi/shared/envelope';
import { ApiError, getBytes, request } from '../api';
import { requireConfig, type Config, type LocalUserKey } from '../config';
import { obtainPrivateKey } from '../userkey';
import { InstallConflict, installTrace } from '../harnesses/install';
import { scanHome } from '../harnesses';
import { fail } from '../log';
import { runTui, type TuiRemote } from '../tui';
import { VERSION } from '../version';
import { lineReporter, type ProgressReporter } from '../progress';
import { claimPendingSessions } from '../claim';
import { cmd, dim, heading, ok } from '../ui';

function formatSize(bytes: number | null) {
  if (bytes === null) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function titleOf(envelope: EnvelopeHeader | null, key: LocalUserKey | null) {
  if (!envelope) return { title: '(upload pending)', cwd: '' };
  if (!key) return { title: '(encrypted: password needed to show the title)', cwd: '' };
  try {
    const meta = decryptMetadata(envelope, { publicKey: key.publicKey, privateKey: key.privateKey! });
    return { title: meta.title, cwd: meta.cwd };
  } catch {
    return { title: '(cannot decrypt with this key)', cwd: '' };
  }
}

/** What to download: one version of one session, own or shared. */
type Target = {
  id: string;
  harness: Harness;
  harnessSessionId: string;
  harnessUpdatedAt: string;
  versionId: number;
  sizeBytes: number;
  envelope: EnvelopeHeader;
  description: string;
};

async function fetchList(config: Config) {
  return request(config.serverUrl, '/api/client/sessions?scope=all', {
    token: config.deviceToken,
    schema: listRemoteSessionsResponseSchema
  });
}

async function fetchDetail(config: Config, sessionId: number): Promise<SessionDetail> {
  return request(config.serverUrl, `/api/client/sessions/${sessionId}`, {
    token: config.deviceToken,
    schema: sessionDetailResponseSchema
  });
}

/** The share is still encrypted for a provisional key: claim it with the sender's passphrase first. */
class NeedsPassphrase extends Error {
  constructor(
    public readonly pendingId: number,
    public readonly fromEmail: string,
    public readonly pullId: string
  ) {
    super(`#${pullId} from ${fromEmail} needs the passphrase they gave you; run \`vibi pull ${pullId}\` in a terminal to enter it.`);
    this.name = 'NeedsPassphrase';
  }
}

function sharedTarget(share: SharedSession): Target {
  if (share.needsPassphrase && share.pendingRecipientId !== null) throw new NeedsPassphrase(share.pendingRecipientId, share.fromEmail, share.pullId);
  return {
    id: `#${share.pullId}`,
    harness: share.harness,
    harnessSessionId: share.harnessSessionId,
    harnessUpdatedAt: share.harnessUpdatedAt,
    versionId: share.versionId,
    sizeBytes: share.sizeBytes,
    envelope: share.envelope,
    description: `from ${share.fromEmail}`
  };
}

function ownTarget(session: RemoteSession, version?: SessionDetail['versions'][number]): Target {
  if (version) {
    return {
      id: `#${session.pullId}`,
      harness: session.harness,
      harnessSessionId: session.harnessSessionId,
      harnessUpdatedAt: session.harnessUpdatedAt,
      versionId: version.id,
      sizeBytes: version.sizeBytes,
      envelope: version.envelope,
      description: `version v${version.seq ?? '?'}`
    };
  }
  if (!session.envelope || !session.versionId || session.sizeBytes === null) {
    throw new Error(`session #${session.pullId} has no stored version yet.`);
  }
  return {
    id: `#${session.pullId}`,
    harness: session.harness,
    harnessSessionId: session.harnessSessionId,
    harnessUpdatedAt: session.harnessUpdatedAt,
    versionId: session.versionId,
    sizeBytes: session.sizeBytes,
    envelope: session.envelope,
    description: 'latest version'
  };
}

const normalizeId = (id: string) => id.trim().replace(/^#/, '').toLowerCase();

/** A pull id (own session or share), optionally a version by number `3` / `v3` or a content-hash prefix. */
async function resolveTarget(config: Config, id: string, versionRef: string | undefined): Promise<Target> {
  const { sessions, shared } = await fetchList(config);
  const wanted = normalizeId(id);
  // The picker refers to versions by their internal row id ("id:78"); users
  // use `--rev` with the version number or a content-hash prefix.
  const byRowId = versionRef?.startsWith('id:') ? Number(versionRef.slice(3)) : null;
  const session = sessions.find((s) => s.pullId === wanted);
  if (session) {
    if (!versionRef) return ownTarget(session);
    const detail = await fetchDetail(config, session.id);
    const ref = versionRef.trim().replace(/^v/i, '');
    const matches = detail.versions.filter(
      (v) => v.status === 'stored' && (byRowId !== null ? v.id === byRowId : String(v.seq) === ref || v.contentHash.startsWith(ref))
    );
    if (matches.length !== 1) throw new Error(`--rev ${versionRef} matches ${matches.length} versions; run \`vibi pull ${id} --versions\`.`);
    return ownTarget(session, matches[0]);
  }
  const share = shared.find((s) => s.pullId === wanted);
  if (share) {
    const refId = byRowId !== null ? byRowId : versionRef ? Number(versionRef.replace(/^v/i, '')) : null;
    if (refId !== null && refId !== share.versionId) {
      throw new Error('shared sessions refer to one version; --rev does not apply.');
    }
    return sharedTarget(share);
  }
  throw new Error(`no session #${wanted} in this account or shared with it; run \`vibi pull --list\` to see them.`);
}

/** Download, verify, decrypt and either install or write the plaintext. Returns a message. */
async function pullTarget(config: Config, key: LocalUserKey, target: Target, opts: { into?: string; out?: string; overwrite?: boolean }, onProgress?: ProgressReporter) {
  onProgress?.({ phase: 'downloading', loaded: 0, total: target.sizeBytes });
  const ciphertext = await getBytes(
    new URL(`/api/client/session-versions/${target.versionId}/content`, config.serverUrl),
    config.deviceToken,
    (loaded, total) => onProgress?.({ phase: 'downloading', loaded, total: total || target.sizeBytes }),
    target.sizeBytes
  );
  onProgress?.({ phase: 'decrypting' });
  if (ciphertext.length !== target.sizeBytes) throw new Error(`downloaded ${ciphertext.length} bytes, expected ${target.sizeBytes}.`);
  if (createHash('sha256').update(ciphertext).digest('base64url') !== target.envelope.content.hash) {
    throw new Error('downloaded ciphertext does not match the envelope hash.');
  }
  const { content, metadata } = decryptTrace({
    header: target.envelope,
    ciphertext,
    pair: { publicKey: key.publicKey, privateKey: key.privateKey! }
  });
  onProgress?.({ phase: 'installing' });
  if (opts.out) {
    writeFileSync(opts.out, content, { mode: 0o600 });
    onProgress?.({ phase: 'done' });
    return `Wrote ${content.length} bytes of plaintext (${target.description}) to ${opts.out}.`;
  }
  const { file, existed, imported, importError } = installTrace({
    harness: target.harness,
    harnessSessionId: target.harnessSessionId,
    harnessUpdatedAt: target.harnessUpdatedAt,
    metadata,
    content,
    home: scanHome(),
    projectDir: opts.into,
    overwrite: opts.overwrite
  });
  onProgress?.({ phase: 'done' });
  const where = `${existed ? 'Already present' : 'Installed'} (${target.description}): ${file}`;
  switch (target.harness) {
    case 'claude':
      return `${where}\nResume with: cd ${opts.into ?? process.cwd()} && claude --resume ${target.harnessSessionId}`;
    case 'codex':
      return `${where}\nResume with: codex resume ${target.harnessSessionId}`;
    case 'pi':
      return `${where}\nResume with: pi --session ${file}`;
    case 'sc':
      return `${where}\nResume with: marathon --resume ${file}`;
    default:
      if (imported) {
        return `${where}\nImported into OpenCode.\nResume with: ${metadata.cwd ? `cd ${metadata.cwd} && ` : ''}opencode --session ${target.harnessSessionId}`;
      }
      return `${where}\nNot imported into OpenCode: ${importError ?? 'unknown reason'}. The file is OpenCode's export format; \`opencode import <file>\` loads it once OpenCode is available.`;
  }
}

/** The install report for the terminal: what happened, then how to resume, as a command to copy. */
function formatPullMessage(message: string): string {
  const [head, ...rest] = message.split('\n');
  return [
    ok(head),
    ...rest.map((line) => (line.startsWith('Resume with: ') ? `  ${dim('Resume with:')} ${cmd(line.slice('Resume with: '.length))}` : `  ${dim(line)}`))
  ].join('\n');
}

/** Entries for the pull picker: own sessions and shares, newest first, titles decrypted locally. */
async function remoteEntries(config: Config, key: LocalUserKey | null, into: string): Promise<{ entries: TuiRemote[]; details: Map<string, SessionDetail> }> {
  const { sessions, shared } = await fetchList(config);
  const details = new Map<string, SessionDetail>();
  await Promise.all(
    sessions
      .filter((s) => s.versionCount > 1)
      .map(async (s) => details.set(`#${s.id}`, await fetchDetail(config, s.id)))
  );
  const entries: TuiRemote[] = [];
  for (const s of sessions) {
    const { title } = titleOf(s.envelope, key);
    const detail = details.get(`#${s.id}`);
    const versions = detail
      ? detail.versions
          .filter((v) => v.status === 'stored')
          .map((v) => ({
            id: v.id,
            label: `v${v.seq ?? '?'}  ${formatSize(v.sizeBytes)}  ${v.storedAt ? new Date(v.storedAt).toLocaleString() : ''}${v.machineName ? `  from ${v.machineName}` : ''}${v.sharedWith.length ? `  sent to ${v.sharedWith.join(', ')}` : ''}`,
            latest: v.id === detail.currentVersionId
          }))
      : s.versionId
        ? [{ id: s.versionId, label: `v${s.versionCount}  ${formatSize(s.sizeBytes)}`, latest: true }]
        : [];
    entries.push({
      id: `#${s.pullId}`,
      title,
      label: s.label ?? '',
      meta: `${harnessName(s.harness)} · ${s.machineName} · ${new Date(s.harnessUpdatedAt).toLocaleString()} · ${formatSize(s.sizeBytes)}${s.versionCount > 1 ? ` · ${s.versionCount} versions` : ''}`,
      updatedAt: s.harnessUpdatedAt,
      installed: false,
      versions
    });
  }
  for (const s of shared) {
    const { title } = titleOf(s.envelope, key);
    entries.push({
      id: `#${s.pullId}`,
      title,
      label: s.label ?? '',
      meta: `from ${s.fromEmail} · ${harnessName(s.harness)} · sent ${new Date(s.sentAt).toLocaleString()} · ${formatSize(s.sizeBytes)}${s.needsPassphrase ? ' · needs passphrase' : ''}`,
      updatedAt: s.sentAt,
      installed: false,
      versions: [{ id: s.versionId, label: `v${s.versionId}  ${formatSize(s.sizeBytes)}`, latest: true }]
    });
  }
  void into;
  entries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { entries, details };
}

function printList(sessions: RemoteSession[], shared: SharedSession[], key: LocalUserKey | null) {
  if (!sessions.length && !shared.length) {
    console.log('No sessions stored for this account yet.');
    return;
  }
  for (const s of sessions) {
    const { title, cwd } = titleOf(s.envelope, key);
    console.log(`#${s.pullId}  ${s.label ? `[${s.label}] ` : ''}${title}`);
    console.log(
      `    ${harnessName(s.harness)} · ${s.machineName} · ${new Date(s.harnessUpdatedAt).toLocaleString()} · ${formatSize(s.sizeBytes)}` +
        `${s.versionCount > 1 ? ` · ${s.versionCount} versions` : ''}${cwd ? ` · ${cwd}` : ''}`
    );
  }
  for (const s of shared) {
    const { title, cwd } = titleOf(s.envelope, key);
    console.log(`#${s.pullId}  ${s.label ? `[${s.label}] ` : ''}${title}`);
    console.log(
      `    from ${s.fromEmail} · ${harnessName(s.harness)} · sent ${new Date(s.sentAt).toLocaleString()} · ${formatSize(s.sizeBytes)}${cwd ? ` · ${cwd}` : ''}${s.needsPassphrase ? ' · needs passphrase' : ''}`
    );
  }
  console.log('\nDownload with `vibi pull <id>` (Claude Code: add --into <project dir>; older versions: `--versions`, then `--rev <n>`).');
}

async function printVersions(config: Config, id: string, key: LocalUserKey | null) {
  const { sessions } = await fetchList(config);
  const session = sessions.find((s) => s.pullId === normalizeId(id));
  if (!session) throw new Error(`no session #${normalizeId(id)} in this account.`);
  const detail = await fetchDetail(config, session.id);
  console.log(`#${detail.pullId}  ${detail.label ? `[${detail.label}] ` : ''}${harnessName(detail.harness)} · ${detail.machineName}`);
  for (const v of detail.versions) {
    const { title } = titleOf(v.envelope, key);
    const current = v.id === detail.currentVersionId ? ' (latest)' : '';
    console.log(
      `  v${v.seq ?? '?'}  ${formatSize(v.sizeBytes)}  ${v.storedAt ? new Date(v.storedAt).toLocaleString() : v.status}${current}` +
        `${v.machineName ? `  from ${v.machineName}` : ''}${v.sharedWith.length ? `  sent to ${v.sharedWith.join(', ')}` : ''}  ${title}  (${v.contentHash.slice(0, 8)})`
    );
  }
  console.log(`\nPull one with \`vibi pull ${detail.pullId} --rev <n>\`.`);
}

/**
 * `vibi pull`                     interactive picker: newest first, enter installs into this directory
 * `vibi pull --list`              print the list (used automatically without a terminal)
 * `vibi pull <id> [--rev v|hash]` download, decrypt and install one
 * `vibi pull <id> --versions`     list a session's versions
 */
export async function pull(
  id: string | undefined,
  opts: { into?: string; out?: string; overwrite?: boolean; json?: boolean; list?: boolean; rev?: string; versions?: boolean }
) {
  const config = requireConfig();
  const into = opts.into ?? process.cwd();
  try {
    // Titles and contents need the private key: the remembered copy, or the
    // password now (kept in memory for this command only).
    const key = opts.versions || !id ? await obtainPrivateKey(config, { optional: true }) : await obtainPrivateKey(config);
    if (!id) {
      const interactive = !opts.list && !opts.json && (Boolean(process.env.VIBI_TUI_BIN) || (process.stdout.isTTY && process.stdin.isTTY));
      if (!interactive) {
        const list = await fetchList(config);
        if (opts.json) console.log(JSON.stringify(list, null, 2));
        else printList(list.sessions, list.shared, key);
        return;
      }
      // Sessions sent before this account had a key cannot be opened from the
      // picker: unlock them with the senders' passphrases here first, so the
      // picker then shows them like any other.
      if (key) {
        const list = await fetchList(config);
        if (list.shared.some((s) => s.needsPassphrase)) {
          console.log(heading('Sessions waiting for a passphrase'));
          await claimPendingSessions(config, key, { interactive: Boolean(process.stdin.isTTY) || process.env.VIBI_PASSPHRASE !== undefined });
          console.log('');
        }
      }
      const { entries } = await remoteEntries(config, key, into);
      await runTui({
        state: {
          version: VERSION,
          mode: 'pull',
          cwd: into,
          serverUrl: config.serverUrl,
          machineName: config.machineName,
          keyUnlocked: Boolean(key),
          sessionsLoading: false,
          sessions: [],
          contacts: [],
          remote: entries
        },
        onRequest: async (req, report) => {
          if (!key) throw new Error('the encryption password was not entered; quit and run `vibi pull` again.');
          const target = await resolveTarget(config, req.key, req.versionId ? `id:${req.versionId}` : undefined);
          const message = await pullTarget(config, key, target, { into, overwrite: opts.overwrite }, report);
          const refreshed = await remoteEntries(config, key, into);
          return { message: message.split('\n')[0], remote: refreshed.entries };
        }
      });
      return;
    }
    if (opts.versions) {
      try {
        await printVersions(config, id, key);
      } catch (error) {
        if (error instanceof Error && !(error instanceof ApiError)) fail(error.message);
        throw error;
      }
      return;
    }
    if (!key) fail('the encryption password is required to pull.');
    const progress = lineReporter();
    try {
      let target: Target;
      try {
        target = await resolveTarget(config, id, opts.rev);
      } catch (error) {
        if (!(error instanceof NeedsPassphrase)) throw error;
        // Sent before this account had a key: unlock with the sender's passphrase, re-key for our key, then pull normally.
        const claimed = await claimPendingSessions(config, key, { interactive: Boolean(process.stdin.isTTY) || process.env.VIBI_PASSPHRASE !== undefined, only: error.pendingId });
        if (claimed.claimed === 0) fail(`#${error.pullId} is still waiting for the passphrase from ${error.fromEmail}.`);
        target = await resolveTarget(config, id, opts.rev);
      }
      console.log(formatPullMessage(await pullTarget(config, key, target, { into: opts.into, out: opts.out, overwrite: opts.overwrite }, progress).finally(() => progress.finish())));
    } catch (error) {
      if (error instanceof InstallConflict) fail(error.message);
      if (error instanceof Error && !(error instanceof ApiError)) fail(error.message);
      throw error;
    }
  } catch (error) {
    if (error instanceof ApiError) fail(error.message, error.status === 401 ? 2 : 1);
    throw error;
  }
}
