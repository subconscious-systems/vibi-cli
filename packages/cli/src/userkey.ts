import { userKeySchema, type UserKey } from '@vibivibi/shared/api';
import { generateKeyPair, publicKeyFingerprint } from '@vibivibi/shared/crypto';
import { WrongPasswordError, unwrapPrivateKey, wrapPrivateKey } from '@vibivibi/shared/userkey';
import { ApiError, request } from './api';
import { readUserKey, writeUserKey, type Config, type LocalUserKey } from './config';
import { promptHidden, promptNewPassword, promptYesNo } from './password';
import { bold, dim, heading, ok } from './ui';

/** The user's key as the server holds it, or null if none has been created yet. */
export async function fetchUserKey(config: Config): Promise<UserKey | null> {
  try {
    return await request(config.serverUrl, '/api/client/user-key', {
      token: config.deviceToken,
      schema: userKeySchema
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export const REMEMBER_QUESTION =
  'Keep the unlocked private key on this machine, so `vibi pull` does not ask for the password each time? [y/N] ';

/** Asks, unless the caller or VIBI_REMEMBER_KEY already decided. */
export async function askRemember(preset: boolean | undefined): Promise<boolean> {
  if (preset !== undefined) return preset;
  return promptYesNo(REMEMBER_QUESTION, false, 'VIBI_REMEMBER_KEY');
}

function localFrom(remote: Pick<UserKey, 'publicKey' | 'fingerprint' | 'createdAt'>, privateKey: string | null): LocalUserKey {
  return {
    publicKey: remote.publicKey,
    fingerprint: remote.fingerprint,
    privateKey,
    createdAt: remote.createdAt,
    unlockedAt: privateKey ? new Date().toISOString() : null
  };
}

/** First machine: generate the pair, wrap the private key, register both. */
export async function createUserKey(config: Config, opts: { remember?: boolean }): Promise<LocalUserKey> {
  console.log(heading('Create your encryption key'));
  console.log(dim('No encryption key exists for your account yet. It is created here, and the private key is stored on the'));
  console.log(dim('server only after being encrypted with a password that never leaves your machines.'));
  console.log(dim('There is no way to recover that password. Keep it somewhere safe.'));
  const password = await promptNewPassword();
  const pair = generateKeyPair();
  const encryptedPrivateKey = wrapPrivateKey(pair, password);
  const remote = await request(config.serverUrl, '/api/client/user-key', {
    method: 'POST',
    token: config.deviceToken,
    body: { publicKey: pair.publicKey, encryptedPrivateKey },
    schema: userKeySchema
  });
  console.log(ok(`Encryption key created (fingerprint ${bold(remote.fingerprint)}).`));
  const remember = await askRemember(opts.remember);
  const local = localFrom(remote, remember ? pair.privateKey : null);
  writeUserKey(local);
  console.log(remember ? ok('The unlocked key is kept on this machine (`vibi lock` forgets it).') : dim('The private key is not kept on this machine; commands that need it will ask for the password.'));
  return localFrom(remote, pair.privateKey);
}

/**
 * Unwraps the server copy with the password. The result is returned for use
 * in memory; it is written to disk only when `remember` is true.
 */
export async function unlockUserKey(
  config: Config,
  remote: UserKey,
  opts: { remember: boolean; optional?: boolean; attempts?: number }
): Promise<LocalUserKey | null> {
  const attempts = opts.attempts ?? 3;
  const question = opts.optional ? 'Encryption password (leave empty to skip for now): ' : 'Encryption password: ';
  for (let i = 0; i < attempts; i++) {
    const password = await promptHidden(question);
    if (!password) return null;
    try {
      const pair = unwrapPrivateKey(remote.encryptedPrivateKey, remote.publicKey, password);
      const local = localFrom({ ...remote, fingerprint: publicKeyFingerprint(pair.publicKey) }, pair.privateKey);
      if (opts.remember) {
        writeUserKey(local);
      } else {
        // Public half only on disk; the private key lives in this process.
        const existing = readUserKey();
        if (!existing || existing.publicKey !== remote.publicKey) writeUserKey(localFrom(remote, null));
      }
      return local;
    } catch (error) {
      if (error instanceof WrongPasswordError) {
        console.log('Wrong password.');
        if (process.env.VIBI_PASSWORD !== undefined) throw error;
        continue;
      }
      throw error;
    }
  }
  return null;
}

/** Stores the public half only, so syncing works without the password. */
export function rememberPublicKey(remote: UserKey): LocalUserKey {
  const existing = readUserKey();
  const keep = existing?.publicKey === remote.publicKey ? existing.privateKey : null;
  const local = localFrom(remote, keep);
  if (!existing || existing.publicKey !== remote.publicKey) writeUserKey(local);
  return local;
}

/**
 * Enrollment: create the account's key if it has none, otherwise fetch the
 * public key and offer to unlock. The remember choice decides whether the
 * unlocked private key is written to disk.
 */
export async function ensureUserKey(config: Config, opts: { unlock: boolean; remember?: boolean }): Promise<LocalUserKey> {
  const remote = await fetchUserKey(config);
  if (!remote) return createUserKey(config, { remember: opts.remember });
  const local = rememberPublicKey(remote);
  if (opts.remember === false && local.privateKey) writeUserKey(localFrom(remote, null));
  if (local.privateKey || !opts.unlock) return local;
  const unlocked = await unlockUserKey(config, remote, { remember: false, optional: true });
  if (!unlocked) return local;
  const remember = await askRemember(opts.remember);
  if (remember) {
    writeUserKey(unlocked);
    console.log(ok('The unlocked key is kept on this machine (`vibi lock` forgets it).'));
  } else {
    console.log(dim('The private key is not kept on this machine; commands that need it will ask for the password.'));
  }
  return unlocked;
}

/**
 * The private key for this command: the remembered copy if there is one,
 * otherwise the server copy unlocked with the password and held in memory
 * only. Returns null when `optional` and the user skipped the password.
 */
export async function obtainPrivateKey(config: Config, opts: { optional?: boolean } = {}): Promise<LocalUserKey | null> {
  const cached = readUserKey();
  if (cached?.privateKey) return cached;
  const remote = await fetchUserKey(config);
  if (!remote) throw new Error('Your account has no encryption key yet; run `vibi enroll <code>` first.');
  const local = await unlockUserKey(config, remote, { remember: false, optional: opts.optional });
  if (!local && !opts.optional) throw new Error('The encryption password is required for this command.');
  return local;
}
