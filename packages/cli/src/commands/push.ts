import { harnessName } from '@vibivibi/shared/sessions';
import { ApiError } from '../api';
import { requireConfig, type Config } from '../config';
import { discoverContext, discoverLocalSessions, type LocalSession } from '../harnesses';
import { fail } from '../log';
import { promptYesNo } from '../password';
import {
  describeSend,
  draftProvisional,
  ensurePublicKey,
  lookupRecipient,
  provisionalNotice,
  registerProvisional,
  sendSession,
  sessionStatus,
  sessionsForDirectory,
  syncSession,
  type Recipient,
  type SendOutcome
} from '../push';
import { readState } from '../state';
import { runTui, type TuiSession } from '../tui';
import { VERSION } from '../version';
import { lineReporter } from '../progress';
import { bold, box, dim, ok } from '../ui';

function toTuiSessions(sessions: LocalSession[]): TuiSession[] {
  const state = readState();
  return sessions.map((s) => ({
    key: s.key,
    harness: s.harness,
    harnessName: harnessName(s.harness),
    title: s.title,
    cwd: s.cwd,
    updatedAt: new Date(s.updatedMs).toISOString(),
    model: s.model,
    status: sessionStatus(s, state),
    label: state.sessions[s.key]?.label ?? '',
    sizeBytes: s.sizeBytes
  }));
}

export function findSession(sessions: LocalSession[], ref: string) {
  const wanted = ref.trim();
  if (!wanted) return null;
  const exact = sessions.filter((s) => s.key === wanted || s.id === wanted);
  if (exact.length > 1) throw new Error(`Session "${ref}" is ambiguous; use a full harness:id key.`);
  if (exact.length === 1) return exact[0];
  if (/^[1-9]\d*$/.test(wanted)) return sessions[Number(wanted) - 1] ?? null;
  const matches = sessions.filter((s) => s.id.startsWith(wanted));
  if (matches.length > 1) throw new Error(`Session "${ref}" is ambiguous; use a full harness:id key.`);
  return matches[0] ?? null;
}

/**
 * Who a scripted send goes to. An address without a key gets a provisional
 * one, and the sender sees its passphrase and confirms they have it before
 * anything is uploaded (`--yes`, VIBI_YES, or no terminal skip the question).
 */
async function prepareRecipient(config: Config, email: string, yes: boolean | undefined): Promise<Recipient> {
  const found = await lookupRecipient(config, email);
  if (found) return found;
  const draft = draftProvisional(email);
  console.log(box(provisionalNotice(draft).map((line) => (line.trim() === draft.passphrase ? `    ${bold(line.trim())}` : line)), { title: `Passphrase for ${draft.email}` }));
  const go = yes || (await promptYesNo(`Have you saved the passphrase for ${draft.email}? Upload now? [y/N] `, !process.stdin.isTTY, 'VIBI_YES'));
  if (!go) fail('nothing sent. Run the same command when you are ready; the same passphrase will be used.');
  return registerProvisional(config, draft);
}

/** The send outcome for the terminal: the fact first, the recipient's situation after it. */
function formatSend(r: SendOutcome): string {
  const [head, ...rest] = describeSend(r).split('\n');
  const tail = rest.map((line) => (line.trim() === r.passphrase ? `  ${bold(line.trim())}` : dim(line)));
  return [ok(head), ...tail].join('\n');
}

/**
 * `vibi push`                                  interactive: pick a session, Sync or Send
 * `vibi push --list`                            print the sessions under this directory
 * `vibi push --session <key|n> --sync [--name]` non-interactive sync
 * `vibi push --session <key|n> --send <email>`  non-interactive send
 */
export async function push(opts: {
  session?: string;
  sync?: boolean;
  send?: string;
  name?: string;
  list?: boolean;
  json?: boolean;
  all?: boolean;
  force?: boolean;
  yes?: boolean;
  max: string;
}) {
  const config = requireConfig();
  const dir = process.cwd();
  const max = Math.max(1, Number(opts.max) || 500);
  try {
    const key = await ensurePublicKey(config);
    const sessions = opts.all ? await discoverLocalSessions(discoverContext(max)) : await sessionsForDirectory(dir, max);

    if (opts.list || opts.json) {
      const rows = toTuiSessions(sessions);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      console.log(`${opts.all ? 'All sessions' : `Sessions under ${dir}`}: ${rows.length}\n`);
      rows.forEach((r, i) => {
        console.log(`${String(i + 1).padStart(3)}. ${r.label ? `[${r.label}] ` : ''}${r.title}`);
        console.log(`     ${r.key} · ${r.harnessName} · ${new Date(r.updatedAt).toLocaleString()} · ${r.status}${r.cwd !== dir ? ` · ${r.cwd}` : ''}`);
      });
      return;
    }

    if (opts.session) {
      const session = findSession(sessions, opts.session);
      if (!session) fail(`no session "${opts.session}" under ${dir}; see \`vibi push --list\`.`);
      const label = opts.name !== undefined ? opts.name : undefined;
      if (opts.send) {
        const recipient = await prepareRecipient(config, opts.send, opts.yes);
        const progress = lineReporter();
        const r = await sendSession(config, key, session, label, opts.send, { onProgress: progress, recipient }).finally(() => progress.finish());
        console.log(formatSend(r));
      } else {
        const progress = lineReporter();
        const r = await syncSession(config, key, session, label, { force: opts.force, onProgress: progress }).finally(() => progress.finish());
        console.log(ok(r.uploaded ? `Synced #${r.pullId} as version v${r.seq ?? '?'}.` : `#${r.pullId} is already up to date (version v${r.seq ?? '?'}).`));
      }
      return;
    }

    // VIBI_TUI_BIN substitutes the picker binary (tests), so no terminal is needed then.
    if (!process.env.VIBI_TUI_BIN && (!process.stdout.isTTY || !process.stdin.isTTY)) {
      fail('interactive mode needs a terminal; use --list, or --session <key> with --sync or --send <email>.');
    }
    let current = sessions;
    await runTui({
      state: {
        version: VERSION,
        mode: 'push',
        cwd: dir,
        serverUrl: config.serverUrl,
        machineName: config.machineName,
        keyUnlocked: Boolean(key.privateKey),
        sessionsLoading: false,
        sessions: toTuiSessions(current),
        contacts: [],
        remote: []
      },
      onRequest: async (request, report) => {
        const session = current.find((s) => s.key === request.key);
        if (!session) throw new Error('That session is no longer in the list.');
        const label = request.name ? request.name : undefined;
        let message: string;
        if (request.action === 'send' || request.action === 'send-confirmed') {
          let recipient: Recipient;
          if (request.action === 'send') {
            const found = await lookupRecipient(config, request.email);
            if (!found) {
              // Show the passphrase and let the sender confirm they have it; the
              // picker answers with a "send-confirmed" request, or nothing happens.
              const draft = draftProvisional(request.email);
              return {
                message: provisionalNotice(draft).join('\n'),
                ask: { action: 'send-confirmed', title: `Passphrase for ${draft.email}`, yes: 'I have saved the passphrase, upload now', no: 'Cancel, nothing is sent' }
              };
            }
            recipient = found;
          } else {
            recipient = await registerProvisional(config, draftProvisional(request.email));
          }
          const r = await sendSession(config, key, session, label, request.email, { onProgress: report, recipient });
          message = describeSend(r, true);
        } else {
          const r = await syncSession(config, key, session, label, { force: opts.force, onProgress: report });
          message = r.uploaded ? `Synced #${r.pullId} as version v${r.seq ?? '?'}` : `#${r.pullId} already up to date (version v${r.seq ?? '?'})`;
        }
        current = opts.all ? await discoverLocalSessions(discoverContext(max)) : await sessionsForDirectory(dir, max);
        return { message, sessions: toTuiSessions(current) };
      }
    });
  } catch (error) {
    if (error instanceof ApiError) fail(error.message, error.status === 401 ? 2 : 1);
    throw error;
  }
}
