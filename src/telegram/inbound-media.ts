import { mkdir, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { extname, join } from 'path';
import type { Api, Context } from 'grammy';

// Files sent from Telegram (photos, documents, voice notes, audio) are saved under
// ~/.afk-code/inbox/ and described to the session as text it can act on.

export const INBOX_DIR = join(homedir(), '.afk-code', 'inbox');

export interface SavedFile {
  path: string;
  mimeType?: string;
}

export async function downloadTelegramFile(api: Api, botToken: string, fileId: string, suggestedName?: string, fallbackExt = ''): Promise<SavedFile> {
  const file = await api.getFile(fileId);
  const ext = extname(file.file_path || '') || fallbackExt;
  const base = suggestedName || `telegram-${Date.now()}${ext}`;
  await mkdir(INBOX_DIR, { recursive: true });
  const dest = join(INBOX_DIR, `${Date.now()}-${base}`);
  const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return { path: dest };
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

/** Text injected into the session for a photo or document. */
export function describeFile(ctx: Context, saved: SavedFile, isPhoto: boolean): string {
  const label = isPhoto || IMAGE_RE.test(saved.path) ? 'Image' : 'File';
  const caption = (ctx.message?.caption || '').trim();
  return `${caption ? caption + ' ' : ''}[${label}: ${saved.path}] (read this file to view it)`;
}

/** Transcribe an audio file with Deepgram. Returns null when no key is configured. */
export async function transcribeWithDeepgram(apiKey: string | undefined, audio: Buffer, mimeType: string): Promise<string | null> {
  if (!apiKey) return null;
  const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=en', {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': mimeType },
    body: new Uint8Array(audio),
  });
  if (!res.ok) throw new Error(`deepgram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  return typeof transcript === 'string' ? transcript.trim() : '';
}

/** Text injected into the session for a voice note or audio message. */
export function describeVoiceNote(ctx: Context, saved: SavedFile, transcript: string | null): string {
  const caption = (ctx.message?.caption || '').trim();
  const prefix = caption ? caption + ' ' : '';
  if (transcript) return `${prefix}[voice note] ${transcript}`;
  return `${prefix}[Audio: ${saved.path}] (voice note; transcription unavailable)`;
}
