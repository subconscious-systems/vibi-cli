import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir } from './config';

/**
 * What the client remembers about each uploaded session so it can skip
 * unchanged ones. Stays local; the plaintext hash in particular is never sent.
 */
const sessionStateSchema = z.object({
  sessionId: z.number().int(),
  versionId: z.number().int(),
  sourcePath: z.string(),
  sizeBytes: z.number(),
  mtimeMs: z.number(),
  updatedMs: z.number(),
  plaintextHash: z.string(),
  keyFingerprint: z.string(),
  syncedAt: z.string(),
  label: z.string().nullable().optional(),
  pullId: z.string().optional()
});
export type SessionState = z.infer<typeof sessionStateSchema>;

/**
 * A key pair this machine made for someone who had no key yet, and the
 * passphrase it was wrapped with (so `vibi pending` can show it again).
 */
const pendingRecipientStateSchema = z.object({
  id: z.number().int().nullable(),
  email: z.string(),
  publicKey: z.string(),
  privateKey: z.string(),
  fingerprint: z.string(),
  passphrase: z.string(),
  createdAt: z.string()
});
export type PendingRecipientState = z.infer<typeof pendingRecipientStateSchema>;

const stateSchema = z.object({
  version: z.literal(1),
  sessions: z.record(sessionStateSchema),
  pending: z.record(pendingRecipientStateSchema).default({})
});
export type State = z.infer<typeof stateSchema>;

export const statePath = () => join(configDir(), 'state.json');

export function readState(): State {
  let text: string;
  try {
    text = readFileSync(statePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: {}, pending: {} };
    throw error;
  }
  try {
    return stateSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new Error(`Cannot read local state at ${statePath()}; preserve this file and restore a valid backup before continuing.`, { cause: error });
  }
}

export function writeState(state: State) {
  const validated = stateSchema.parse(state);
  if (existsSync(statePath())) readState();
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const temporary = `${statePath()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(validated, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, statePath());
  } finally { rmSync(temporary, { force: true }); }
}
