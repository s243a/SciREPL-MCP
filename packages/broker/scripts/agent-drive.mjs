#!/usr/bin/env node
/**
 * agent-drive.mjs — drive the broker's /agent surface from a script.
 *
 *   node agent-drive.mjs --url ws://HOST:8087/agent --token-file ~/scirepl-broker/broker-token \
 *        --agent agy --prompt-file prompt.txt [--timeout-ms 900000]
 *
 * Speaks the app's own protocol: hello{token} → start{agent} → input{text},
 * prints events as they arrive (assistant text to stdout, everything else to
 * stderr), and exits when the turn's `result` event lands.
 *
 * One-shot profiles (agy, gemini, codex) buffer the CLI's entire output and
 * deliver it at process exit — expect one blob, not a stream. A permission
 * denial inside the CLI surfaces only as stderr here; see the
 * remote-agent-control tutorial for the supervised /term alternative.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const url = arg('url');
const tokenFile = arg('token-file');
if (!url || !tokenFile) {
  console.error('usage: agent-drive.mjs --url ws://HOST:PORT/agent --token-file FILE --agent NAME --prompt-file FILE');
  process.exit(2);
}
const TOKEN = (arg('token', '') || fs.readFileSync(tokenFile, 'utf8')).trim();
const AGENT = arg('agent', 'agy');
const PROMPT = fs.readFileSync(arg('prompt-file'), 'utf8');
const TIMEOUT = Number(arg('timeout-ms', 900000));

const ws = new WebSocket(url);
let started = false;
let done = false;
const die = (msg, code = 1) => { console.error('[drive] ' + msg); try { ws.close(); } catch {} process.exit(code); };
const timer = setTimeout(() => die(`timeout after ${TIMEOUT}ms`), TIMEOUT);

ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN })));
ws.on('error', (e) => die('ws error: ' + e.message));
ws.on('close', (c, r) => { if (!done) die(`ws closed (${c}) ${r || ''}`); });

ws.on('message', (buf) => {
  let m; try { m = JSON.parse(buf.toString()); } catch { return; }
  if (m.type !== 'agent') return;
  switch (m.kind) {
    case 'welcome':
      console.error(`[drive] welcome; agents=${(m.agents || []).join(',')} running=${m.running || 'none'}`);
      if (!(m.agents || []).includes(AGENT)) die(`agent '${AGENT}' not available (workspace ready? CLI on PATH?)`);
      ws.send(JSON.stringify({ type: 'start', agent: AGENT }));
      break;
    case 'started':
      console.error(`[drive] agent '${m.text}' started${m.experimental ? ' (experimental)' : ''}`);
      if (!started) { started = true; ws.send(JSON.stringify({ type: 'input', text: PROMPT })); }
      break;
    case 'assistant':
      process.stdout.write(m.text || '');
      break;
    case 'stderr':
      console.error('[agent stderr] ' + (m.text || '').trimEnd());
      break;
    case 'tool_use':
      console.error(`[agent tool] ${m.tool || ''}`);
      break;
    case 'error':
      die('agent error: ' + m.text);
      break;
    case 'result':
      done = true;
      clearTimeout(timer);
      console.error('\n[drive] turn complete');
      ws.close();
      process.exit(0);
  }
});
