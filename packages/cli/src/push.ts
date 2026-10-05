import path from 'node:path';
import {
  type InviteResponse,
  inviteResponseSchema,
  pendingRecipientResponseSchema,
  sessionDetailResponseSchema,
  userLookupResponseSchema
} from '@vibivibi/shared/sessions';
import { addRecipient, contentKeyFor } from '@vibivibi/shared/envelope';
import { generateKeyPair } from '@vibivibi/shared/crypto';
import { wrapPrivateKey } from '@vibivibi/shared/userkey';
import { PASSPHRASE_SCRYPT_PARAMS, generatePassphrase, normalizePassphrase } from '@vibivibi/shared/passphrase';
import { ApiError, request } from './api';
import { readUserKey, type Config, type LocalUserKey } from './config';
import { adapterFor, discoverContext, discoverLocalSessions, type LocalSession, type TraceContent } from './harnesses';
import { encodeClaudeProjectDir } from './harnesses/install';
import { readState, writeState, type SessionState, type State } from './state';
import { fetchUserKey, rememberPublicKey } from './userkey';
import { sha256, uploadVersion } from './upload';
import type { ProgressReporter } from './progress';

/**
 * Sessions that belong to `dir`, newest first: their recorded working
 * directory is `dir` or inside it, or (Claude Code) the transcript lives in
 * the project folder Claude Code keeps for `dir`. The second rule matters for
 * sessions pulled from another machine, whose transcript still records the
 * original path.
 */
export async function sessionsForDirectory(dir: string, max = 500): Promise<LocalSession[]> {
  const root = path.resolve(dir);
  const claudeFolder = encodeClaudeProjectDir(root);
  const all = await discoverLocalSessions(discoverContext(max));
  return all.filter((s) => {
    if (s.harness === 'claude' && s.sourcePath && path.basename(path.dirname(s.sourcePath)) === claudeFolder) return true;
    if (!s.cwd) return false;
    const relative = path.relative(root, path.resolve(s.cwd));
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}

export type SessionStatus = 'new' | 'synced' | 'changed';

export function sessionStatus(session: LocalSession, state: State): SessionStatus {
  const prev = state.sessions[session.key];
  if (!prev) return 'new';
  if (session.sourcePath) {
    return prev.mtimeMs === session.mtimeMs && prev.sizeBytes === session.sizeBytes ? 'synced' : 'changed';
  }
  return prev.updatedMs === session.updatedMs ? 'synced' : 'changed';
}

/** The user's key with at least the public half, fetching it if this machine has none. */
export async function ensurePublicKey(config: Config): Promise<LocalUserKey> {
  const local = readUserKey();
  if (local) return local;
  const remote = await fetchUserKey(config);
  if (!remote) throw new Error('Your account has no encryption key yet; run `vibi enroll <code>` first.');
  return rememberPublicKey(remote);
}

async function readTrace(session: LocalSession, onProgress?: ProgressReporter): Promise<{ trace: TraceContent; hash: string }> {
  onProgress?.({ phase: 'reading' });
  const trace = await adapterFor(session.harness).readTrace(session, discoverContext(1));
  if (trace.bytes.length === 0) throw new Error('The session file is empty.');
  return { trace, hash: sha256(trace.bytes) };
}

function unchanged(prev: SessionState | undefined, hash: string, key: LocalUserKey) {
  return !!prev && prev.plaintextHash === hash && prev.keyFingerprint === key.fingerprint;
}

async function setLabel(config: Config, sessionId: number, label: string | null) {
  await request(config.serverUrl, `/api/client/sessions/${sessionId}`, {
    method: 'PATCH',
    token: config.deviceToken,
    body: { label },
    schema: sessionDetailResponseSchema.pick({ id: true, label: true })
  });
}

export type SyncOutcome = { sessionId: number; pullId: string; versionId: number; seq: number | null; uploaded: boolean };

/** The stored version this machine last uploaded, as the server still has it; null if gone. */
async function serverStillHas(config: Config, prev: SessionState) {
  try {
    const detail = await request(config.serverUrl, `/api/client/sessions/${prev.sessionId}`, {
      token: config.deviceToken,
      schema: sessionDetailResponseSchema
    });
    const version = detail.versions.find((v) => v.id === prev.versionId && v.status === 'stored');
    return version ? { pullId: detail.pullId, seq: version.seq } : null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Sync: encrypt for yourself and upload, unless this exact content is already
 * stored. "Already stored" is confirmed with the server, so a copy that went
 * missing there is re-uploaded; --force uploads regardless.
 */
export async function syncSession(
  config: Config,
  key: LocalUserKey,
  session: LocalSession,
  label: string | null | undefined,
  opts: { force?: boolean; onProgress?: ProgressReporter } = {}
): Promise<SyncOutcome> {
  const { trace, hash } = await readTrace(session, opts.onProgress);
  const state = readState();
  const prev = state.sessions[session.key];
  const existing = !opts.force && unchanged(prev, hash, key) ? await serverStillHas(config, prev!) : null;
  if (existing) {
    if (label !== undefined && (label || null) !== (prev!.label ?? null)) {
      await setLabel(config, prev!.sessionId, label || null);
      state.sessions[session.key] = { ...prev!, label: label || null, mtimeMs: session.mtimeMs, sizeBytes: session.sizeBytes, updatedMs: session.updatedMs, pullId: existing.pullId };
    } else {
      state.sessions[session.key] = { ...prev!, mtimeMs: session.mtimeMs, sizeBytes: session.sizeBytes, updatedMs: session.updatedMs, pullId: existing.pullId };
    }
    writeState(state);
    opts.onProgress?.({ phase: 'done' });
    return { sessionId: prev!.sessionId, pullId: existing.pullId, versionId: prev!.versionId, seq: existing.seq, uploaded: false };
  }
  return uploadVersion(config, key, { session, trace, plaintextHash: hash, label, recipients: [key.publicKey] }, opts.onProgress);
}

export type SendOutcome = SyncOutcome & {
  recipient: string;
  reusedVersion: boolean;
  /** The copy was encrypted for a provisional key made by this account; the recipient claims it with a passphrase. */
  provisional: boolean;
  /** The passphrase to pass on, when the provisional key was made on this machine. */
  passphrase: string | null;
  /** Whether the address already had an account (otherwise an invitation was emailed). */
  registered: boolean;
};

export type Recipient = { email: string; publicKey: string; provisional: boolean; passphrase: string | null; registered: boolean };

/** A provisional key pair and passphrase chosen for an address, not yet registered with the server. */
export type Provisional = { email: string; publicKey: string; privateKey: string; passphrase: string; reused: boolean };

const drafts = new Map<string, Provisional>();

/** The address's own key, or null when it has none (no account, or never enrolled: the server does not say which). */
export async function lookupRecipient(config: Config, rawEmail: string): Promise<Recipient | null> {
  const email = rawEmail.trim().toLowerCase();
  try {
    const found = await request(config.serverUrl, `/api/client/users/lookup?email=${encodeURIComponent(email)}`, {
      token: config.deviceToken,
      schema: userLookupResponseSchema
    });
    return { email: found.email, publicKey: found.publicKey, provisional: false, passphrase: null, registered: true };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * The key pair and passphrase to use for an address without a key: the ones
 * made earlier on this machine if any, otherwise fresh ones. Nothing is sent
 * to the server, so the sender can see the passphrase and still change their
 * mind; the same draft is returned until registerProvisional() uses it.
 */
export function draftProvisional(rawEmail: string): Provisional {
  const email = rawEmail.trim().toLowerCase();
  const cached = drafts.get(email);
  if (cached) return cached;
  const local = readState().pending[email];
  const draft: Provisional = local
    ? { email, publicKey: local.publicKey, privateKey: local.privateKey, passphrase: local.passphrase, reused: true }
    : { email, ...generateKeyPair(), passphrase: generatePassphrase(), reused: false };
  drafts.set(email, draft);
  return draft;
}

/**
 * Registers the provisional key with the server (which emails an invitation
 * when the address has no account) and remembers it locally. If another of
 * our machines registered one first, the server's key is used instead and
 * the passphrase to pass on is the one shown by `vibi pending` there.
 */
export async function registerProvisional(config: Config, draft: Provisional): Promise<Recipient> {
  const encryptedPrivateKey = wrapPrivateKey(draft, normalizePassphrase(draft.passphrase), PASSPHRASE_SCRYPT_PARAMS);
  const remote = await request(config.serverUrl, '/api/client/pending-recipients', {
    method: 'POST',
    token: config.deviceToken,
    body: { email: draft.email, publicKey: draft.publicKey, encryptedPrivateKey },
    schema: pendingRecipientResponseSchema
  });
  drafts.delete(draft.email);
  if (remote.publicKey !== draft.publicKey) {
    return { email: draft.email, publicKey: remote.publicKey, provisional: true, passphrase: null, registered: remote.registered };
  }
  const state = readState();
  const previous = state.pending[draft.email];
  state.pending[draft.email] = {
    id: remote.id,
    email: draft.email,
    publicKey: draft.publicKey,
    privateKey: draft.privateKey,
    fingerprint: remote.fingerprint,
    passphrase: draft.passphrase,
    createdAt: previous?.createdAt ?? new Date().toISOString()
  };
  writeState(state);
  return { email: draft.email, publicKey: draft.publicKey, provisional: true, passphrase: draft.passphrase, registered: remote.registered };
}

/** Who to encrypt for, without a confirmation step (scripts and callers that confirmed already). */
export async function resolveRecipient(config: Config, rawEmail: string): Promise<Recipient> {
  const found = await lookupRecipient(config, rawEmail);
  if (found) return found;
  return registerProvisional(config, draftProvisional(rawEmail));
}

/** What the sender must know before a provisional send, as plain lines (the TUI wraps them itself). */
export function provisionalNotice(draft: Provisional): string[] {
  return [
    `${draft.email} has no encryption key on vibivibi yet (no account, or never enrolled).`,
    'The session will be encrypted for a key made here on their behalf; they unlock it',
    `once with this passphrase${draft.reused ? ', the same one as for the earlier session you sent them' : ''}:`,
    '',
    `    ${draft.passphrase}`,
    '',
    'Give it to them through another channel; it is never emailed. `vibi pending`',
    'shows it again later.'
  ];
}

/**
 * Invites an address to join. The server mails a sign-up link through Clerk;
 * the session has to be sent again once they have signed up and enrolled,
 * because nothing can be encrypted for a key that does not exist yet.
 */
export async function inviteRecipient(config: Config, email: string, session?: LocalSession): Promise<InviteResponse> {
  const known = session ? readState().sessions[session.key] : undefined;
  return request(config.serverUrl, '/api/client/invitations', {
    method: 'POST',
    token: config.deviceToken,
    body: { email, ...(known?.sessionId ? { sessionId: known.sessionId } : {}) },
    schema: inviteResponseSchema
  });
}

/** One line for the user after inviteRecipient. */
export function describeInvite(r: InviteResponse): string {
  return r.status === 'sent'
    ? `Invitation emailed to ${r.email}. Once they sign up and run \`vibi enroll\`, send the session again.`
    : `${r.email} was already invited on ${new Date(r.invitedAt).toLocaleDateString()}; no second email was sent. Send the session again once they have enrolled.`;
}

/**
 * Send: make the current content readable by another user. If the stored
 * version is already up to date and the key is unlocked here, the content key
 * is re-wrapped for the recipient and only the envelope changes; otherwise a
 * new version is uploaded encrypted for both of you.
 */
export async function sendSession(
  config: Config,
  key: LocalUserKey,
  session: LocalSession,
  label: string | null | undefined,
  email: string,
  opts: { onProgress?: ProgressReporter; recipient?: Recipient } = {}
): Promise<SendOutcome> {
  const recipient = opts.recipient ?? (await resolveRecipient(config, email));
  const extra = { provisional: recipient.provisional, passphrase: recipient.passphrase, registered: recipient.registered };
  const { trace, hash } = await readTrace(session, opts.onProgress);
  const state = readState();
  const prev = state.sessions[session.key];

  if (unchanged(prev, hash, key) && key.privateKey) {
    opts.onProgress?.({ phase: 'registering' });
    const detail = await request(config.serverUrl, `/api/client/sessions/${prev!.sessionId}`, {
      token: config.deviceToken,
      schema: sessionDetailResponseSchema
    }).catch((error) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    });
    const version = detail?.versions.find((v) => v.id === prev!.versionId && v.status === 'stored');
    if (version) {
      const contentKey = contentKeyFor(version.envelope, { publicKey: key.publicKey, privateKey: key.privateKey });
      const envelope = addRecipient(version.envelope, contentKey, recipient.publicKey);
      await request(config.serverUrl, `/api/client/session-versions/${version.id}/envelope`, {
        method: 'PUT',
        token: config.deviceToken,
        body: { envelope, shareWith: [recipient.email] },
        schema: sessionDetailResponseSchema.pick({ id: true }).extend({ sessionId: sessionDetailResponseSchema.shape.id, versionId: sessionDetailResponseSchema.shape.id }).partial()
      });
      if (label !== undefined && (label || null) !== (prev!.label ?? null)) {
        await setLabel(config, prev!.sessionId, label || null);
        state.sessions[session.key] = { ...prev!, label: label || null };
        writeState(state);
      }
      opts.onProgress?.({ phase: 'done' });
      return { sessionId: prev!.sessionId, pullId: detail!.pullId, versionId: version.id, seq: version.seq, uploaded: false, recipient: recipient.email, reusedVersion: true, ...extra };
    }
  }

  const result = await uploadVersion(config, key, {
    session,
    trace,
    plaintextHash: hash,
    label,
    recipients: [key.publicKey, recipient.publicKey],
    shareWith: [recipient.email]
  }, opts.onProgress);
  return { ...result, recipient: recipient.email, reusedVersion: false, ...extra };
}

/** After a send: where it went and, for a provisional key, what the recipient still needs. */
export function describeSend(r: SendOutcome, compact = false): string {
  const head = r.reusedVersion
    ? `Sent #${r.pullId} v${r.seq ?? '?'} to ${r.recipient}${compact ? ' (re-keyed, nothing re-uploaded)' : '; the stored copy was re-keyed, nothing re-uploaded.'}`
    : `Sent #${r.pullId} to ${r.recipient} as new version v${r.seq ?? '?'}${compact ? '' : '.'}`;
  if (!r.provisional) return head;
  const who = r.registered ? 'They have an account but no key yet' : 'They have no account yet; an invitation was emailed';
  if (r.passphrase) {
    return `${head}\n${who}. They unlock it with the passphrase shown above (\`vibi pending\` shows it again):\n  ${r.passphrase}`;
  }
  return `${head}\n${who}. A provisional key for them already existed from another of your machines, so the passphrase that applies is the one \`vibi pending\` shows THERE, not one shown here; \`vibi pending --reset ${r.recipient}\` makes a new one on this machine.`;
}
