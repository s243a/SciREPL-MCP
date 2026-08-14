#!/usr/bin/env node
/**
 * term-drive.mjs — attach to the broker's /term PTY, optionally send input,
 * capture output until a quiet period, print it ANSI-stripped, and detach
 * leaving the session alive (the broker holds the PTY across reconnects).
 *
 *   node term-drive.mjs --url ws://HOST:8087/term --token-file ~/scirepl-broker/broker-token \
 *        [--start agy]         # command to start (must be in BROKER_TERM_CMDS)
 *        [--send 'text']       # text + Enter
 *        [--send-raw 'y']      # exact bytes, no Enter (menu digits, \x07 for ctrl+g)
 *        [--read-ms 8000]      # quiet-period before returning
 *        [--dump raw.log]      # append the raw (unstripped) stream
 *        [--stop]              # terminate the PTY session
 *
 * Built for a blocking connect–act–read–detach loop: each invocation is one
 * step of a supervised session. On reattach the TUI usually redraws the
 * current screen, so a bare invocation (no --send) is "show me where it is".
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const argIdx = (n) => process.argv.indexOf(`--${n}`);
const arg = (n, d) => { const i = argIdx(n); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => argIdx(n) !== -1;

const url = arg('url');
const tokenFile = arg('token-file');
if (!url || !tokenFile) {
  console.error('usage: term-drive.mjs --url ws://HOST:PORT/term --token-file FILE [--start CMD] [--send TEXT|--send-raw BYTES] [--read-ms N] [--dump FILE] [--stop]');
  process.exit(2);
}
const TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
const READ_MS = Number(arg('read-ms', 8000));
const DUMP = arg('dump', null);
const START = arg('start', 'agy');

const ws = new WebSocket(url);
let raw = '';
const finish = (code) => {
  if (DUMP) fs.appendFileSync(DUMP, raw);
  const clean = raw
    .replace(/\][^]*(|\\)/g, '')   // OSC
    .replace(/\[[0-9;?]*[A-Za-z]/g, '')                    // CSI
    .replace(/[=>NOc]/g, '')                               // misc
    .replace(/\r/g, '');
  process.stdout.write(clean);
  try { ws.close(); } catch {}
  process.exit(code);
};

ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN })));
ws.on('error', (e) => { console.error('[term] ws error: ' + e.message); process.exit(1); });

let readTimer = null;
const armRead = () => { if (readTimer) clearTimeout(readTimer); readTimer = setTimeout(() => finish(0), READ_MS); };

ws.on('message', (buf) => {
  let m; try { m = JSON.parse(buf.toString()); } catch { return; }
  if (m.type !== 'term') return;
  switch (m.kind) {
    case 'welcome':
      console.error(`[term] welcome; cmds=${(m.cmds || []).join(',')}`);
      ws.send(JSON.stringify({ type: 'start', cmd: START, cols: 120, rows: 40 }));
      break;
    case 'started': {
      console.error(`[term] '${m.cmd}' ${m.reattached ? 'reattached' : 'started'}`);
      if (has('stop')) { ws.send(JSON.stringify({ type: 'stop' })); setTimeout(() => finish(0), 500); return; }
      const send = arg('send', null);
      const sendRaw = arg('send-raw', null);
      setTimeout(() => {
        if (send != null) ws.send(JSON.stringify({ type: 'input', data: send + '\r' }));
        if (sendRaw != null) ws.send(JSON.stringify({ type: 'input', data: sendRaw }));
      }, 700);
      armRead();
      break;
    }
    case 'data':
      raw += m.data || '';
      armRead();   // quiet-period window: reset on every chunk
      break;
    case 'exit':
      console.error(`[term] process exited (${m.code})`);
      finish(0);
      break;
    case 'error':
      console.error('[term] error: ' + m.text);
      finish(1);
  }
});
setTimeout(() => { console.error('[term] hard timeout'); finish(1); }, Math.max(READ_MS * 6, 120000));
