import { createHash } from 'node:crypto';
import { upload } from '@vercel/blob/client';
import {
  MAX_TRACE_BYTES,
  completeVersionResponseSchema,
  registerSessionResponseSchema,
  type RegisterSessionRequest,
  type UploadInstruction
} from '@vibivibi/shared/sessions';
import { encryptTrace } from '@vibivibi/shared/envelope';
import { putBytes, request } from './api';
import type { Config, LocalUserKey } from './config';
import type { LocalSession, TraceContent } from './harnesses';
import { readState, writeState } from './state';
import type { ProgressReporter } from './progress';

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('base64url');

export class TraceTooLargeError extends Error {
  constructor(bytes: number) {
    super(`${bytes} bytes exceeds the ${MAX_TRACE_BYTES} byte limit`);
    this.name = 'TraceTooLargeError';
  }
}

async function sendCiphertext(config: Config, instruction: UploadInstruction, ciphertext: Buffer, versionId: number, onProgress?: ProgressReporter) {
  const report = (loaded: number, total: number) => onProgress?.({ phase: 'uploading', loaded, total });
  report(0, ciphertext.length);
  if (instruction.transport === 'direct') {
    await putBytes(new URL(instruction.url, config.serverUrl), ciphertext, config.deviceToken, report);
    return undefined;
  }
  // The server issues the upload token only for the version this machine
  // just registered; the pathname embeds the id, the payload names it too.
  const result = await upload(instruction.pathname, ciphertext, {
    access: instruction.access,
    handleUploadUrl: new URL(instruction.handleUploadUrl, config.serverUrl).toString(),
    headers: { authorization: `Bearer ${config.deviceToken}` },
    clientPayload: JSON.stringify({ versionId }),
    contentType: 'application/octet-stream',
    multipart: instruction.multipart,
    onUploadProgress: ({ loaded, total }) => report(loaded, total)
  });
  return result.url;
}

export type UploadInput = {
  session: LocalSession;
  trace: TraceContent;
  plaintextHash: string;
  label?: string | null;
  /** Public keys that may decrypt this version: the user's own, plus anyone it is sent to. */
  recipients: string[];
  shareWith?: string[];
};

export type UploadResult = {
  sessionId: number;
  /** Public handle for `vibi pull`. */
  pullId: string;
  versionId: number;
  /** Version number within the session. */
  seq: number | null;
  /** false when the server already held this exact ciphertext. */
  uploaded: boolean;
};

/**
 * Encrypts one trace as a new version and uploads it. Encryption happens here;
 * the server receives only the envelope and the ciphertext.
 */
export async function uploadVersion(config: Config, key: LocalUserKey, input: UploadInput, onProgress?: ProgressReporter): Promise<UploadResult> {
  const { session, trace } = input;
  if (trace.bytes.length > MAX_TRACE_BYTES) throw new TraceTooLargeError(trace.bytes.length);
  onProgress?.({ phase: 'encrypting', total: trace.bytes.length });

  const { header, ciphertext } = encryptTrace({
    content: trace.bytes,
    metadata: {
      title: session.title,
      cwd: session.cwd,
      model: session.model,
      messageCount: trace.messageCount,
      sourcePath: session.sourcePath,
      startedAt: trace.startedAt
    },
    recipients: input.recipients
  });

  const body: RegisterSessionRequest = {
    harness: session.harness,
    harnessSessionId: session.id,
    harnessUpdatedAt: new Date(session.updatedMs).toISOString(),
    sizeBytes: ciphertext.length,
    contentHash: header.content.hash,
    envelope: header,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.shareWith?.length ? { shareWith: input.shareWith } : {})
  };
  onProgress?.({ phase: 'registering' });
  const registered = await request(config.serverUrl, '/api/client/sessions', {
    method: 'POST',
    token: config.deviceToken,
    body,
    schema: registerSessionResponseSchema
  });

  let seq = registered.seq;
  if (registered.upload) {
    const blobUrl = await sendCiphertext(config, registered.upload, ciphertext, registered.versionId, onProgress);
    onProgress?.({ phase: 'verifying' });
    const completed = await request(config.serverUrl, `/api/client/session-versions/${registered.versionId}/complete`, {
      method: 'POST',
      token: config.deviceToken,
      body: blobUrl ? { blobUrl } : {},
      schema: completeVersionResponseSchema
    });
    seq = completed.seq;
  }

  const state = readState();
  state.sessions[session.key] = {
    sessionId: registered.sessionId,
    versionId: registered.versionId,
    sourcePath: session.sourcePath,
    sizeBytes: session.sizeBytes,
    mtimeMs: session.mtimeMs,
    updatedMs: session.updatedMs,
    plaintextHash: input.plaintextHash,
    keyFingerprint: key.fingerprint,
    syncedAt: new Date().toISOString(),
    label: input.label !== undefined ? input.label : state.sessions[session.key]?.label ?? null,
    pullId: registered.pullId
  };
  writeState(state);
  onProgress?.({ phase: 'done' });

  return { sessionId: registered.sessionId, pullId: registered.pullId, versionId: registered.versionId, seq, uploaded: registered.upload !== null };
}
