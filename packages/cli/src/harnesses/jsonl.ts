import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { JsonRecord, LocalSession } from './types';
import type { Harness } from '@vibivibi/shared/sessions';

// Ported from subconscious-cli bin/sessions.js (MIT).

export const MAX_CANDIDATE_FILES = 1000;
export const MAX_METADATA_BYTES = 256 * 1024;
export const MAX_INDEX_BYTES = 4 * 1024 * 1024;

export function cleanText(value: unknown): string {
  return String(value ?? '')
    .replaceAll('\0', '')
    .replace(/\r\n/g, '\n')
    .trim();
}

export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return cleanText(content);
  if (!Array.isArray(content)) return '';
  return cleanText(
    content
      .filter((part) => {
        if (typeof part === 'string') return true;
        return ['text', 'input_text', 'output_text'].includes(part?.type);
      })
      .map((part) => (typeof part === 'string' ? part : part.text || ''))
      .filter(Boolean)
      .join('\n')
  );
}

export function firstLine(value: unknown, fallback = 'Untitled session'): string {
  const line = cleanText(value).split('\n').find(Boolean) || fallback;
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

export function parseLines(text: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (record !== null && typeof record === 'object' && !Array.isArray(record)) records.push(record);
    } catch {
      // Session writers can leave a partial final line after an interrupted run.
    }
  }
  return records;
}

/** Head + tail of a large file, cut on line boundaries. */
export async function readBounded(file: string, limit: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (info.size <= limit) return handle.readFile({ encoding: 'utf8' });
    const half = Math.floor(limit / 2);
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    await handle.read(head, 0, half, 0);
    await handle.read(tail, 0, half, Math.max(0, info.size - half));
    const headText = head.toString('utf8').replace(/[^\n]*$/, '');
    const tailText = tail.toString('utf8').replace(/^[^\n]*\n?/, '');
    return `${headText}\n${tailText}`;
  } finally {
    await handle.close();
  }
}

export async function readTail(file: string, limit = MAX_INDEX_BYTES): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    const size = Math.min(info.size, limit);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, Math.max(0, info.size - size));
    const text = buffer.toString('utf8');
    return info.size > size ? text.replace(/^[^\n]*\n?/, '') : text;
  } finally {
    await handle.close();
  }
}

export async function walkJsonl(root: string, maxDepth = 8): Promise<string[]> {
  const files: string[] = [];
  const pending = [{ directory: root, depth: 0 }];
  while (pending.length) {
    const { directory, depth } = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < maxDepth) {
        pending.push({ directory: resolved, depth: depth + 1 });
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(resolved);
      }
    }
  }
  return files;
}

export type FileEntry = { file: string; mtimeMs: number; sizeBytes: number };

export async function statEntry(file: string): Promise<FileEntry | null> {
  try {
    const info = await stat(file);
    return { file, mtimeMs: info.mtimeMs, sizeBytes: info.size };
  } catch {
    return null;
  }
}

export async function newestFiles(
  root: string,
  limit: number,
  keep: (file: string) => boolean = () => true
): Promise<FileEntry[]> {
  const files = (await walkJsonl(root)).filter(keep);
  const entries = await Promise.all(files.map(statEntry));
  return entries
    .filter((entry): entry is FileEntry => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.min(MAX_CANDIDATE_FILES, limit));
}

export function makeSession(
  harness: Harness,
  id: string,
  values: {
    title?: unknown;
    cwd?: unknown;
    model?: unknown;
    updatedMs?: number;
    entry?: FileEntry | null;
  }
): LocalSession | null {
  if (!id) return null;
  const mtimeMs = values.entry?.mtimeMs ?? 0;
  const updatedMs = Math.max(values.updatedMs ?? 0, mtimeMs) || Date.now();
  return {
    key: `${harness}:${id}`,
    harness,
    id,
    title: firstLine(values.title),
    cwd: cleanText(values.cwd),
    model: cleanText(values.model),
    updatedMs,
    mtimeMs,
    sizeBytes: values.entry?.sizeBytes ?? 0,
    sourcePath: values.entry?.file ?? ''
  };
}

/** Earliest ISO timestamp found on a record, if the harness writes one. */
export function firstTimestamp(records: JsonRecord[]): string | null {
  for (const record of records) {
    const value = record?.timestamp ?? record?.payload?.timestamp ?? record?.time;
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
    if (typeof value === 'number' && value > 0 && Number.isFinite(new Date(value).getTime())) return new Date(value).toISOString();
  }
  return null;
}
