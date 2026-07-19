#!/usr/bin/env node
// Capture README/Marketplace-quality screenshots from the running Spotify desktop
// client over the Chrome DevTools Protocol.
//
// Supersedes `cdp.mjs screenshot` (full-viewport, 1x, no crop) by adding the
// primitives a publishable screenshot needs: element-scoped capture, explicit
// square rects for Marketplace previews, real input dispatch, a readiness
// predicate instead of blind sleeps, and a verified localStorage snapshot/restore.
//
// SESSION MODEL: a CDP emulation override dies with the session that set it, and
// every invocation of this script is a new session. So the active override is
// persisted to .shoot-state.json and re-asserted on connect. Without that, an
// override set by one command silently evaporates during the next one, and
// `reset-viewport` reports success while changing nothing.
//
// Usage:
//   node shoot.mjs viewport <w> <h>           override viewport size
//   node shoot.mjs reset-viewport             clear it (re-asserts first, then clears)
//   node shoot.mjs status                     print live viewport vs. expected
//   node shoot.mjs reload [sec]               reload xpui and wait for the extension
//   node shoot.mjs navigate <path> [sec]      Spicetify History.push, e.g. /album/<id>
//   node shoot.mjs click <selector> [opts]    real mouse dispatch (--text, --index)
//   node shoot.mjs wait "<jsPredicate>" [sec] poll until predicate is truthy
//   node shoot.mjs verify <selector> [opts]   structural proof an element is really rendered
//   node shoot.mjs shot <out.png> [opts]      capture PNG
//   node shoot.mjs snapshot <keys|--prefix p> <out.json>
//   node shoot.mjs restore <in.json>          write back, verify byte-identical
//
// shot options:
//   --selector <css>   clip to that element's box
//   --rect x,y,w,h     explicit rect (use for square Marketplace previews)
//   --pad <px>         grow the clip on every side
//   --scale <n>        re-rasterise at n x (this is what produces hi-dpi output;
//                      deviceScaleFactor is inert on the Spotify client)
//   --allow-overlap    capture even if the clip extends past the viewport
//
// click / verify options:
//   --text <s>         disambiguate by visible text (click), required text (verify)
//   --index <n>        pick the nth match
//   --within <css>     require the match to sit inside this ancestor
//   --svg-path <p>     require a descendant <path d> starting with p
//   --min <n>          verify: require at least n matches (default 1)
//
// Env: CDP_PORT (default 9222).

import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = process.env.CDP_PORT || '9222';
const STATE = join(dirname(fileURLToPath(import.meta.url)), '.shoot-state.json');
const argv = process.argv.slice(2);
const cmd = argv[0];

const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const hasFlag = name => argv.includes(name);

const readState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null);
const writeState = s => (s ? writeFileSync(STATE, JSON.stringify(s)) : existsSync(STATE) && rmSync(STATE));

async function xpuiTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page' && /xpui/.test(t.url || ''))
    || targets.find(t => t.type === 'page');
  if (!page) throw new Error(`No xpui page target on :${PORT} (is Spotify running with --remote-debugging-port?)`);
  return page.webSocketDebuggerUrl;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const handlers = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    for (const h of handlers) h(m);
  });
  const send = (method, params = {}) =>
    new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('CDP websocket refused')));
  });
  return { ws, send, ready, onEvent: h => handlers.push(h) };
}

async function evaluate(conn, expression) {
  const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('eval failed: ' + r.result.exceptionDetails.text);
  return r.result?.result?.value;
}

const pollUntil = async (conn, predicate, timeoutMs) => {
  const started = Date.now();
  for (;;) {
    let ok = false;
    try { ok = Boolean(await evaluate(conn, `(() => (${predicate}))()`)); } catch { /* not ready */ }
    if (ok) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error(`predicate never became true within ${timeoutMs}ms: ${predicate}`);
    await new Promise(r => setTimeout(r, 250));
  }
};

// Structural proof that an element was really rendered by the extension.
// Deliberately does NOT use elementFromPoint: decorative badges commonly set
// pointer-events:none, which makes hit-testing return the element behind them
// and report a genuine badge as absent.
const buildVerifier = (selector, { text, within, svgPath, min }) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const checks = els.map(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width <= 0 || r.height <= 0) return 'zero-size';
    if (cs.visibility !== 'visible' || cs.display === 'none' || Number(cs.opacity) === 0) return 'not-visible';
    ${within ? `if (!el.closest(${JSON.stringify(within)})) return 'not-within';` : ''}
    ${text ? `if (!(el.textContent || '').includes(${JSON.stringify(text)}) && el.getAttribute('title') !== ${JSON.stringify(text)}) return 'text-mismatch';` : ''}
    ${svgPath ? `{ const d = el.querySelector('svg path')?.getAttribute('d') || '';
       if (!d.startsWith(${JSON.stringify(svgPath)})) return 'svg-mismatch'; }` : ''}
    return 'ok';
  });
  const ok = checks.filter(c => c === 'ok').length;
  return { total: els.length, ok, min: ${min}, pass: ok >= ${min},
           reasons: [...new Set(checks.filter(c => c !== 'ok'))] };
})()`;

async function resolveTarget(conn, selector, { text, index }) {
  return evaluate(conn, `(() => {
    let els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    ${text ? `els = els.filter(e => (e.textContent || '').trim().includes(${JSON.stringify(text)}));` : ''}
    if (!els.length) return { error: 'no match' };
    ${index === null ? `if (els.length > 1) return { error: els.length + ' matches; disambiguate with --text or --index' };`
      : `if (els.length <= ${index}) return { error: 'only ' + els.length + ' matches, --index ${index} out of range' };`}
    const el = els[${index === null ? 0 : index}];
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { error: 'matched element has no layout' };
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
}

(async () => {
  const conn = connect(await xpuiTarget());
  await conn.ready;
  await conn.send('Runtime.enable');
  await conn.send('Page.enable');

  // Re-assert any persisted override so it survives across invocations.
  const state = readState();
  if (state?.viewport && cmd !== 'viewport') {
    await conn.send('Emulation.setDeviceMetricsOverride', {
      width: state.viewport.width, height: state.viewport.height,
      deviceScaleFactor: 0, mobile: false,
    });
  }

  const opts = {
    text: flag('--text'),
    index: flag('--index') === null ? null : Number(flag('--index')),
    within: flag('--within'),
    svgPath: flag('--svg-path'),
    min: Number(flag('--min', 1)),
  };

  if (cmd === 'viewport') {
    const [w, h] = [Number(argv[1]), Number(argv[2])];
    if (!w || !h) throw new Error('viewport needs <width> <height>');
    await conn.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 0, mobile: false,
    });
    writeState({ viewport: { width: w, height: h } });
    const live = await evaluate(conn, 'innerWidth');
    if (live !== w) throw new Error(`override did not take: innerWidth=${live}, wanted ${w}`);
    console.log(`viewport ${w}x${h} (use --scale for hi-dpi output; deviceScaleFactor is inert here)`);

  } else if (cmd === 'reset-viewport') {
    // Re-assert in THIS session first: clearing an override owned by a dead
    // session is a silent no-op that reports success.
    await conn.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 0, mobile: false });
    await conn.send('Emulation.clearDeviceMetricsOverride');
    writeState(null);
    // The clear is asynchronous — the page relayouts a few frames later. Checking
    // once races it and reports a stuck viewport (or worse, leaves one).
    try {
      await pollUntil(conn, 'Math.abs(innerWidth - outerWidth) <= 40', 10000);
    } catch {
      const [w, outer] = await evaluate(conn, '[innerWidth, outerWidth]');
      throw new Error(`viewport still overridden after 10s: innerWidth=${w} vs outerWidth=${outer}. `
        + 'Re-run reset-viewport; if it persists, restart Spotify.');
    }
    const [w, outer] = await evaluate(conn, '[innerWidth, outerWidth]');
    console.log(`viewport override cleared and verified (innerWidth=${w}, outerWidth=${outer})`);

  } else if (cmd === 'status') {
    const [w, h, outer, dpr] = await evaluate(conn, '[innerWidth, innerHeight, outerWidth, devicePixelRatio]');
    const want = readState()?.viewport;
    console.log(`live ${w}x${h} (outerWidth=${outer}, dpr=${dpr})`);
    console.log(want ? `expected override ${want.width}x${want.height} — ${w === want.width ? 'OK' : 'MISMATCH'}`
      : `no override expected — ${Math.abs(w - outer) > 40 ? 'MISMATCH, something is overriding' : 'OK'}`);

  } else if (cmd === 'reload') {
    const seconds = Number(argv[1]) || 10;
    await conn.send('Page.reload', { ignoreCache: false });
    await pollUntil(conn, 'document.readyState === "complete"', seconds * 1000);
    console.log('reloaded (extensions re-init on load; wait on your readiness predicate before capturing)');

  } else if (cmd === 'navigate') {
    const path = argv[1];
    if (!path) throw new Error('navigate needs a path, e.g. /album/<id>');
    if (!path.startsWith('/')) {
      throw new Error(`path must start with "/" (got "${path}"). On Git Bash, prefix the command `
        + 'with MSYS_NO_PATHCONV=1 — it rewrites leading-slash arguments into Windows paths.');
    }
    // Spicetify is injected after load; pushing before it exists throws.
    await pollUntil(conn, 'window.Spicetify?.Platform?.History?.push !== undefined', 30000);
    await evaluate(conn, `Spicetify.Platform.History.push(${JSON.stringify(path)})`);
    // Spotify routes through Spicetify's history object, not window.location.
    await pollUntil(conn,
      `(Spicetify.Platform.History.location?.pathname || '').includes(${JSON.stringify(path)})`, 10000);
    console.log(`navigated to ${path}`);

  } else if (cmd === 'click') {
    const selector = argv[1];
    if (!selector) throw new Error('click needs a selector');
    const box = await resolveTarget(conn, selector, opts);
    if (box?.error) throw new Error(`click ${selector}: ${box.error}`);
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    // Real input dispatch. Synthetic el.click() no-ops on Spotify's React menus,
    // which listen for pointer events.
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await conn.send('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1,
      });
    }
    console.log(`clicked ${selector} at ${x},${y}`);

  } else if (cmd === 'wait') {
    const predicate = argv[1];
    if (!predicate) throw new Error('wait needs a JS predicate');
    console.log(`ready after ${await pollUntil(conn, predicate, (Number(argv[2]) || 15) * 1000)}ms`);

  } else if (cmd === 'verify') {
    const selector = argv[1];
    if (!selector) throw new Error('verify needs a selector');
    const r = await evaluate(conn, buildVerifier(selector, opts));
    console.log(JSON.stringify(r, null, 2));
    if (!r.pass) {
      console.error(`\nNOT VERIFIED: ${r.ok}/${r.min} required elements confirmed rendered.`);
      console.error('Do not capture this as a feature screenshot. Seed fixture state, reload, or fix the bug.');
      process.exit(3);
    }
    console.log(`\nVERIFIED: ${r.ok} element(s) genuinely rendered by the extension.`);

  } else if (cmd === 'shot') {
    const out = argv[1];
    if (!out || out.startsWith('--')) throw new Error('shot needs an output path');
    const pad = Number(flag('--pad', 0));
    const scale = Number(flag('--scale', 1));
    const selector = flag('--selector');
    const rectArg = flag('--rect');

    const want = readState()?.viewport;
    const [liveW, liveH] = await evaluate(conn, '[innerWidth, innerHeight]');
    if (want && liveW !== want.width) {
      throw new Error(`viewport drifted: live ${liveW}px, expected ${want.width}px. Re-run "viewport" before capturing.`);
    }

    let clip = null;
    if (selector) {
      const box = await resolveTarget(conn, selector, opts);
      if (box?.error) throw new Error(`--selector ${selector}: ${box.error} — refusing to capture the wrong region`);
      clip = box;
    } else if (rectArg) {
      const [x, y, width, height] = rectArg.split(',').map(Number);
      if ([x, y, width, height].some(Number.isNaN)) throw new Error('--rect wants x,y,w,h');
      clip = { x, y, width, height };
    }
    if (clip && pad) {
      clip = {
        x: Math.max(0, clip.x - pad), y: Math.max(0, clip.y - pad),
        width: clip.width + pad * 2, height: clip.height + pad * 2,
      };
    }
    // A clip is a rectangle over the composited page, not an isolated render of
    // the element. If it runs past the viewport it will contain whatever floats
    // on top (now-playing bar, overlays) — which is how personal data leaks into
    // a shot that looked element-scoped.
    if (clip && !hasFlag('--allow-overlap')) {
      const over = [];
      if (clip.x < 0 || clip.y < 0) over.push('above/left of the viewport');
      if (clip.x + clip.width > liveW) over.push(`past the right edge (${Math.round(clip.x + clip.width)} > ${liveW})`);
      if (clip.y + clip.height > liveH) over.push(`past the bottom edge (${Math.round(clip.y + clip.height)} > ${liveH}) — will composite the now-playing bar`);
      if (over.length) {
        throw new Error(`clip extends ${over.join(' and ')}. Scroll the element into view, shrink the clip, `
          + 'or pass --allow-overlap after checking the frame for personal data.');
      }
    }

    const params = { format: 'png', captureBeyondViewport: false };
    if (clip) params.clip = { ...clip, scale };
    else if (scale !== 1) params.clip = { x: 0, y: 0, width: liveW, height: liveH, scale };

    const r = await conn.send('Page.captureScreenshot', params);
    if (!r.result?.data) throw new Error('capture returned no data');
    writeFileSync(out, Buffer.from(r.result.data, 'base64'));
    const dims = clip ? `${Math.round(clip.width * scale)}x${Math.round(clip.height * scale)}` : `${liveW}x${liveH}`;
    console.log(`saved ${out} (${dims})`);

  } else if (cmd === 'snapshot') {
    const prefix = flag('--prefix');
    const out = prefix ? argv[argv.indexOf('--prefix') + 2] : argv[2];
    if (!out) throw new Error('snapshot needs <key,key,...|--prefix p> <out.json>');
    const expr = prefix
      ? `Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith(${JSON.stringify(prefix)})).map(k => [k, localStorage.getItem(k)]))`
      : `Object.fromEntries(${JSON.stringify((argv[1] || '').split(',').filter(Boolean))}.map(k => [k, localStorage.getItem(k)]))`;
    const data = await evaluate(conn, expr);
    if (prefix && !Object.keys(data).length) console.warn(`WARNING: no keys match prefix "${prefix}"`);
    writeFileSync(out, JSON.stringify(data, null, 2));
    const present = Object.entries(data).filter(([, v]) => v !== null).map(([k]) => k);
    console.log(`snapshot -> ${out}; ${present.length} key(s) present: ${present.join(', ') || '(none)'}`);

  } else if (cmd === 'restore') {
    const file = argv[1];
    if (!file) throw new Error('restore needs <in.json>');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && typeof v !== 'string') {
        throw new Error(`key "${k}" is ${typeof v}, not a string. localStorage values are strings — `
          + 'JSON payloads must be stringified, e.g. {"my-ext-data": "[{\\"id\\":1}]"}.');
      }
    }
    // null means the key was absent at snapshot time — remove rather than write
    // the string "null", so restore is a true inverse.
    await evaluate(conn, `(() => {
      const d = ${JSON.stringify(data)};
      for (const [k, v] of Object.entries(d)) {
        if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
      }
    })()`);
    const after = await evaluate(conn,
      `Object.fromEntries(${JSON.stringify(Object.keys(data))}.map(k => [k, localStorage.getItem(k)]))`);
    const mismatched = Object.keys(data).filter(k => (after[k] ?? null) !== (data[k] ?? null));
    if (mismatched.length) throw new Error('RESTORE INCOMPLETE, keys differ: ' + mismatched.join(', '));
    console.log(`restored ${Object.keys(data).length} key(s), verified identical`);
    console.log('NOTE: extensions that read storage once at boot need "reload" before this takes effect.');

  } else {
    console.error('unknown command: ' + cmd);
    console.error('use viewport|reset-viewport|status|reload|navigate|click|wait|verify|shot|snapshot|restore');
    process.exit(2);
  }

  conn.ws.close();
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
