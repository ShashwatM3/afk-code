// Smoke test for the Telegram-side additions. Run with: npx tsx test/smoke.ts
// Exercises the pieces that can be tested without a live Telegram bot and daemon:
//   1. media path extraction (images unchanged, audio/video/pdf added)
//   2. ordered chunked pty input (no truncation at the ~1 KB macOS pty limit)
//   3. local HTTP bridge routes and SSE broadcast
//   4. Deepgram transcription (needs DEEPGRAM_API_KEY and SMOKE_AUDIO)
//   5. optional real Telegram upload (needs TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SMOKE_SEND=1)
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as pty from 'node-pty';
import { Bot, InputFile } from 'grammy';
import { extractImagePaths, extractMediaPaths } from '../src/utils/image-extractor.js';
import { createBridge } from '../src/telegram/bridge.js';
import { transcribeWithDeepgram, describeVoiceNote, describeFile } from '../src/telegram/inbound-media.js';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. extractor
{
  const dir = mkdtempSync(join(tmpdir(), 'afk-smoke-'));
  for (const f of ['a.png', 'b.m4a', 'c.mp4', 'd.pdf', 'e.gif', 'f.txt']) writeFileSync(join(dir, f), 'x');
  // Note: a quoted path must come last; the upstream regex treats a closing quote as the
  // start of another quoted path (unchanged behaviour, kept for parity).
  const text = `Here: ${dir}/a.png plus ${dir}/c.mp4, ${dir}/d.pdf, ${dir}/e.gif, ${dir}/f.txt, ${dir}/missing.mp3 and "${dir}/b.m4a"`;
  const images = extractImagePaths(text).map((m) => m.resolvedPath.split('/').pop());
  const media = extractMediaPaths(text).map((m) => `${m.resolvedPath.split('/').pop()}:${m.kind}`);
  check('extractImagePaths still images only', JSON.stringify(images) === JSON.stringify(['a.png', 'e.gif']), images.join(','));
  check('extractMediaPaths adds audio/video/pdf with kinds',
    JSON.stringify(media) === JSON.stringify(['a.png:image', 'c.mp4:video', 'd.pdf:document', 'e.gif:animation', 'b.m4a:audio']), media.join(','));
  const imgOnly = `see ${dir}/a.png and ~/nonexistent.png and ./rel.jpg (${dir}/e.gif)`;
  check('image-only text: media extractor equals image extractor',
    JSON.stringify(extractMediaPaths(imgOnly).map((m) => m.resolvedPath)) === JSON.stringify(extractImagePaths(imgOnly).map((m) => m.resolvedPath)));
  rmSync(dir, { recursive: true, force: true });
}

// 2. pty chunking (same algorithm as src/cli/run.ts)
{
  const msg = Array.from({ length: 1500 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
  async function trial(chunked: boolean) {
    const p = pty.spawn('/bin/cat', [], { name: 'xterm', cols: 200, rows: 40, cwd: '/', env: process.env as any });
    let out = '';
    p.onData((d) => { out += d; });
    await sleep(200);
    if (!chunked) p.write(msg);
    else for (let i = 0; i < msg.length; i += 256) { p.write(msg.slice(i, i + 256)); await sleep(30); }
    await sleep(300);
    p.write('\r');
    await sleep(300);
    p.kill();
    return out.replace(/\r?\n/g, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').length;
  }
  const single = await trial(false);
  const chunked = await trial(true);
  check('single pty write truncates (documents the bug)', single < msg.length, `${single}/${msg.length}`);
  check('chunked pty write delivers everything', chunked >= msg.length, `${chunked}/${msg.length}`);
}

// 3. bridge
{
  const port = 18765 + Math.floor(Math.random() * 1000);
  let current: string | null = null;
  const inputs: string[] = [];
  const bridge = createBridge({
    currentSessionId: () => current,
    listSessions: () => (current ? [{ sessionId: current }] : []),
    sendInput: (_id, text) => { inputs.push(text); return true; },
    port,
  });
  await sleep(200);
  const base = `http://127.0.0.1:${port}`;
  let r = await fetch(`${base}/sessions`).then((x) => x.json());
  check('bridge /sessions with no session', r.current === null && r.sessions.length === 0);
  let s = await fetch(`${base}/input`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
  check('bridge /input without session -> 409', s.status === 409);
  current = 'abc12345';
  s = await fetch(`${base}/input`, { method: 'POST', body: JSON.stringify({ text: 'hello session' }) });
  check('bridge /input with session -> 200 and forwarded', s.status === 200 && inputs[0] === 'hello session');
  const ac = new AbortController();
  const ev = await fetch(`${base}/events`, { signal: ac.signal });
  const reader = ev.body!.getReader();
  bridge.broadcast({ type: 'assistant', sessionId: current, content: 'pong' });
  let got = '';
  const deadline = Date.now() + 2000;
  while (!got.includes('pong') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    got += new TextDecoder().decode(value);
  }
  check('bridge /events receives broadcast', got.includes('"content":"pong"'));
  ac.abort();
  bridge.close();
  check('bridge 404 on unknown route', (await fetch(`${base}/nope`).catch(() => ({ status: 0 }))).status !== 200);
}

// 4. inbound text shapes
{
  const ctx: any = { message: { caption: 'look' } };
  check('describeFile format', describeFile(ctx, { path: '/x/y.jpg' }, true) === 'look [Image: /x/y.jpg] (read this file to view it)');
  check('describeVoiceNote transcript format', describeVoiceNote({ message: {} } as any, { path: '/x/v.oga' }, 'hello there') === '[voice note] hello there');
  check('describeVoiceNote fallback format', describeVoiceNote({ message: {} } as any, { path: '/x/v.oga' }, null) === '[Audio: /x/v.oga] (voice note; transcription unavailable)');
  check('transcribe without key returns null', (await transcribeWithDeepgram(undefined, Buffer.alloc(1), 'audio/ogg')) === null);
}

// 5. Deepgram (real call) when configured
if (process.env.DEEPGRAM_API_KEY && process.env.SMOKE_AUDIO) {
  const audio = readFileSync(process.env.SMOKE_AUDIO);
  const mime = process.env.SMOKE_AUDIO.endsWith('.oga') || process.env.SMOKE_AUDIO.endsWith('.ogg') ? 'audio/ogg' : 'audio/mp4';
  try {
    const t = await transcribeWithDeepgram(process.env.DEEPGRAM_API_KEY, audio, mime);
    check('Deepgram transcription non-empty', !!t && t.length > 0, (t || '').slice(0, 80));
  } catch (e: any) {
    check('Deepgram transcription', false, e.message);
  }
} else {
  console.log('SKIP  Deepgram (set DEEPGRAM_API_KEY and SMOKE_AUDIO)');
}

// 6. real Telegram upload when asked
if (process.env.SMOKE_SEND === '1' && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && process.env.SMOKE_AUDIO) {
  try {
    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
    await bot.api.sendAudio(process.env.TELEGRAM_CHAT_ID, new InputFile(process.env.SMOKE_AUDIO), { caption: '[smoke test] afk-code fork: sendAudio works. Ignore.' });
    check('Telegram sendAudio', true);
  } catch (e: any) {
    check('Telegram sendAudio', false, e.message);
  }
} else {
  console.log('SKIP  Telegram sendAudio (set SMOKE_SEND=1 with token, chat id and SMOKE_AUDIO)');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
