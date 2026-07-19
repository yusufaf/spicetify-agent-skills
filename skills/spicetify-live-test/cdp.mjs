#!/usr/bin/env node
// Drive the running Spotify desktop client over the Chrome DevTools Protocol.
// Requires Spotify launched with --remote-debugging-port=9222 (set in spicetify
// config-xpui.ini spotify_launch_flags; run `spicetify apply` once to take effect).
//
// Usage:
//   node cdp.mjs reload [seconds]       reload xpui, print console lines captured for N s (default 6)
//   node cdp.mjs console [seconds]      capture console without reloading
//   node cdp.mjs eval "<expression>"    Runtime.evaluate, print returnByValue result
//   node cdp.mjs screenshot <out.png>   save a PNG screenshot of the client
//
// Optional env: CDP_PORT (default 9222), CDP_FILTER (regex to filter console lines).

const PORT = process.env.CDP_PORT || '9222';
const FILTER = process.env.CDP_FILTER ? new RegExp(process.env.CDP_FILTER, 'i') : null;
const [, , cmd, arg] = process.argv;

async function xpuiTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page' && /xpui/.test(t.url || ''))
    || targets.find(t => t.type === 'page');
  if (!page) throw new Error('No xpui page target found on :' + PORT + ' (is Spotify running with --remote-debugging-port?)');
  return page.webSocketDebuggerUrl;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const handlers = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    for (const h of handlers) h(m);
  });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const onEvent = h => handlers.push(h);
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  return { ws, send, onEvent, ready };
}

function collectConsole(conn, seconds, withReload) {
  return new Promise(async resolve => {
    const logs = [];
    conn.onEvent(m => {
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
        logs.push(`[${m.params.type}] ${text}`);
      }
    });
    await conn.send('Runtime.enable');
    await conn.send('Page.enable');
    if (withReload) await conn.send('Page.reload', { ignoreCache: false });
    setTimeout(() => resolve(logs), (Number(seconds) || 6) * 1000);
  });
}

(async () => {
  const wsUrl = await xpuiTarget();
  const conn = connect(wsUrl);
  await conn.ready;

  if (cmd === 'reload' || cmd === 'console') {
    const logs = await collectConsole(conn, arg, cmd === 'reload');
    const shown = FILTER ? logs.filter(l => FILTER.test(l)) : logs;
    console.log(shown.join('\n') || '(no console lines captured)');
    console.log(`--- ${logs.length} total events, ${shown.length} shown ---`);
  } else if (cmd === 'eval') {
    if (!arg) throw new Error('eval needs an expression argument');
    await conn.send('Runtime.enable');
    const r = await conn.send('Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true });
    console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? null, null, 2));
  } else if (cmd === 'screenshot') {
    if (!arg) throw new Error('screenshot needs an output path');
    await conn.send('Page.enable');
    const r = await conn.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
    console.log('saved ' + arg);
  } else {
    console.error('unknown command: ' + cmd + ' (use reload|console|eval|screenshot)');
    process.exit(2);
  }
  conn.ws.close();
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
