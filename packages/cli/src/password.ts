import { createInterface } from 'node:readline';
import { MIN_PASSWORD_LENGTH } from '@vibivibi/shared/userkey';

let pipedLines: AsyncIterator<string> | undefined;

async function readPipedLine(): Promise<string> {
  if (!pipedLines) {
    if (process.stdin.readableEnded || process.stdin.destroyed) return '';
    pipedLines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  }
  const line = await pipedLines.next();
  return line.done ? '' : line.value;
}

/**
 * Reads a password without echoing it. VIBI_PASSWORD bypasses the prompt
 * (tests, automation); a non-TTY stdin is read as one line.
 */
export function promptHidden(question: string): Promise<string> {
  if (process.env.VIBI_PASSWORD !== undefined) {
    return Promise.resolve(process.env.VIBI_PASSWORD);
  }
  if (!process.stdin.isTTY) {
    return readPipedLine();
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export async function promptNewPassword(): Promise<string> {
  // VIBI_NEW_PASSWORD lets automation distinguish the new password from the current one.
  if (process.env.VIBI_NEW_PASSWORD !== undefined) {
    if (process.env.VIBI_NEW_PASSWORD.length < MIN_PASSWORD_LENGTH) throw new Error('VIBI_NEW_PASSWORD is too short');
    return process.env.VIBI_NEW_PASSWORD;
  }
  for (;;) {
    const first = await promptHidden(`Choose an encryption password (at least ${MIN_PASSWORD_LENGTH} characters): `);
    if (first.length < MIN_PASSWORD_LENGTH) {
      console.log(`Too short; use at least ${MIN_PASSWORD_LENGTH} characters.`);
      if (process.env.VIBI_PASSWORD !== undefined) throw new Error('VIBI_PASSWORD is too short');
      if (!process.stdin.isTTY) throw new Error('Encryption password input ended or is too short');
      continue;
    }
    const second = await promptHidden('Repeat it: ');
    if (first !== second) {
      console.log('They do not match; try again.');
      if (process.env.VIBI_PASSWORD !== undefined) throw new Error('unreachable');
      if (!process.stdin.isTTY) throw new Error('Encryption passwords do not match or confirmation input ended');
      continue;
    }
    return first;
  }
}

/**
 * Visible yes/no question. `envOverride` names an environment variable that
 * answers it non-interactively (1/true/yes -> yes); without a terminal the
 * fallback is used.
 */
export async function promptYesNo(question: string, fallback: boolean, envOverride?: string): Promise<boolean> {
  const forced = envOverride ? process.env[envOverride] : undefined;
  if (forced !== undefined) return /^(1|true|yes|y)$/i.test(forced.trim());
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  const text = answer.trim().toLowerCase();
  if (!text) return fallback;
  return text === 'y' || text === 'yes';
}
