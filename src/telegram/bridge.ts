import { createServer, type ServerResponse } from 'http';

// Local HTTP bridge so other local programs (for example a voice page) can talk to the
// same Claude Code session the Telegram bot is relaying.
//   POST /input   {"text": "..."}  -> typed into the current session
//   GET  /events  (SSE)            -> {"type":"user"|"assistant", sessionId, content}
//   GET  /sessions                 -> {"current": id|null, "sessions": [...]}
// Listens on 127.0.0.1 only. Port from AFK_BRIDGE_PORT, default 8765.

export interface BridgeEvent {
  type: 'user' | 'assistant';
  sessionId: string;
  content: string;
}

export interface BridgeDeps {
  currentSessionId: () => string | null;
  listSessions: () => unknown[];
  sendInput: (sessionId: string, text: string) => boolean;
  port?: number;
}

export function createBridge(deps: BridgeDeps) {
  const clients = new Set<ServerResponse>();
  const port = deps.port ?? Number(process.env.AFK_BRIDGE_PORT || 8765);

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch {}
      }, 20000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/sessions') {
      return json(res, 200, { current: deps.currentSessionId(), sessions: deps.listSessions() });
    }

    if (req.method === 'POST' && req.url === '/input') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { text } = JSON.parse(body || '{}');
          const current = deps.currentSessionId();
          if (!text || !current) {
            return json(res, 409, { ok: false, error: current ? 'empty text' : 'no active session' });
          }
          const sent = deps.sendInput(current, text);
          json(res, sent ? 200 : 502, { ok: sent });
        } catch (e: any) {
          json(res, 400, { ok: false, error: e.message });
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on('error', (e: Error) => console.error('[Bridge] failed to listen:', e.message));
  server.listen(port, '127.0.0.1', () => console.log(`[Bridge] listening on http://127.0.0.1:${port}`));

  return {
    broadcast(evt: BridgeEvent) {
      const data = `data: ${JSON.stringify(evt)}\n\n`;
      for (const res of clients) {
        try { res.write(data); } catch {}
      }
    },
    close() {
      for (const res of clients) { try { res.end(); } catch {} }
      clients.clear();
      server.close();
    },
  };
}
