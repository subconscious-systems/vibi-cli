import { generateKeyPair } from '@vibivibi/shared/crypto';
import { userKeySchema } from '@vibivibi/shared/api';
import { WrongPasswordError, unwrapPrivateKey, wrapPrivateKey } from '@vibivibi/shared/userkey';
import { ApiError, request } from '../api';
import { readUserKey, requireConfig, writeUserKey } from '../config';
import { fail } from '../log';
import { promptHidden, promptNewPassword } from '../password';
import { fetchUserKey, unlockUserKey } from '../userkey';

/** Download the wrapped private key and unlock it here. */
export async function unlock() {
  const config = requireConfig();
  try {
    const remote = await fetchUserKey(config);
    if (!remote) fail('your account has no encryption key yet; run `vibi enroll <code>` on a machine first.');
    const local = await unlockUserKey(config, remote, { remember: true });
    if (!local) fail('not unlocked.');
    console.log('The unlocked key is kept on this machine (`vibi lock` forgets it).');
  } catch (error) {
    if (error instanceof ApiError) fail(error.message);
    throw error;
  }
}

/** Forget the plaintext private key on this machine (uploads keep working). */
export async function lock() {
  const key = readUserKey();
  if (!key || !key.privateKey) {
    console.log('No private key is kept on this machine.');
    return;
  }
  writeUserKey({ ...key, privateKey: null, unlockedAt: null });
  console.log(`Locked; the private key is no longer stored on this machine.`);
}

/** Re-wrap the same key pair with a new password. */
export async function changePassword() {
  const config = requireConfig();
  try {
    const remote = await fetchUserKey(config);
    if (!remote) fail('your account has no encryption key yet.');
    const current = await promptHidden('Current encryption password: ');
    let pair;
    try {
      pair = unwrapPrivateKey(remote.encryptedPrivateKey, remote.publicKey, current);
    } catch (error) {
      if (error instanceof WrongPasswordError) fail('wrong password.');
      throw error;
    }
    const next = await promptNewPassword();
    const encryptedPrivateKey = wrapPrivateKey(pair, next);
    const updated = await request(config.serverUrl, '/api/client/user-key', {
      method: 'PUT',
      token: config.deviceToken,
      body: { publicKey: pair.publicKey, encryptedPrivateKey },
      schema: userKeySchema
    });
    const local = readUserKey();
    writeUserKey({
      publicKey: updated.publicKey,
      fingerprint: updated.fingerprint,
      privateKey: local?.publicKey === updated.publicKey && local.privateKey ? pair.privateKey : null,
      createdAt: updated.createdAt,
      unlockedAt: local?.publicKey === updated.publicKey && local.privateKey ? local.unlockedAt ?? new Date().toISOString() : null
    });
    console.log('Password changed. Other machines will ask for the new password the next time they unlock.');
  } catch (error) {
    if (error instanceof ApiError) fail(error.message);
    throw error;
  }
}

// Exported for completeness of the key module; a key is normally created by enroll.
export { generateKeyPair };
