#!/usr/bin/env node
// Sweep a Spicetify extension's UI across popular Marketplace themes in the
// running Spotify desktop client, over the Chrome DevTools Protocol.
//
// Themes are injected at runtime the way Marketplace installs them
// (spicetify/marketplace@9ebdc53, src/logic/Utils.ts injectColourScheme /
// injectUserCSS) instead of via `spicetify apply`, which costs a client restart
// per theme and overwrites the symlinks hot reload depends on.
//
// TRUST MODEL: theme.js runs inside a logged-in client with full
// Spicetify.Platform access. Every theme file is pinned in themes.json by
// sha256 (and by commit SHA where it lives on GitHub). A run executes only bytes
// that match the pin; `refresh` shows the theme.js diff before any pin moves.
//
// Usage:
//   node matrix.mjs list                              pinned themes
//   node matrix.mjs schemes <id>                      colour schemes; * = swept by default
//   node matrix.mjs discover [--top n]                popular Marketplace themes not yet pinned
//   node matrix.mjs add <owner/repo> "<name>" [--id x] [--print]
//                                                     pin a manifest entry (--print: don't write)
//   node matrix.mjs refresh [--accept <id,...|all>]   re-resolve pins, diff theme.js, accept
//   node matrix.mjs inject <id> [--scheme s]          reload, strip current theme, inject <id>
//   node matrix.mjs check <selector> [--kind text|icon]
//   node matrix.mjs restore                           reload, verify nothing injected survives
//   node matrix.mjs run <ext-repo> [--themes a,b] [--schemes all] [--out dir] [--keep-going] [--allow-spec-themes]
//
// Env: CDP_PORT (default 9222), GITHUB_TOKEN or GH_TOKEN (raises the API rate limit).

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const PORT = process.env.CDP_PORT || '9222';
const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '.theme-cache');
const THEMES_FILE = join(HERE, 'themes.json');
const SHOOT = join(HERE, '..', 'spicetify-screenshots', 'shoot.mjs');
const BLACKLIST = 'https://raw.githubusercontent.com/spicetify/marketplace/main/resources/blacklist.json';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const argv = process.argv.slice(2);
const cmd = argv[0];

const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const hasFlag = name => argv.includes(name);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------------------------------------------------------------- pinned files

const readThemes = () => JSON.parse(readFileSync(THEMES_FILE, 'utf8'));
const writeThemes = data => writeFileSync(THEMES_FILE, JSON.stringify(data, null, 2) + '\n');
const findTheme = (themes, id) => {
  const t = themes.find(t => t.id === id);
  if (!t) throw new Error(`no theme "${id}" (see: node matrix.mjs list)`);
  return t;
};

const sha256 = text => createHash('sha256').update(text).digest('hex');
const cachePath = hash => join(CACHE, hash);

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

function store(text) {
  const hash = sha256(text);
  mkdirSync(CACHE, { recursive: true });
  if (!existsSync(cachePath(hash))) writeFileSync(cachePath(hash), text);
  return hash;
}

// Content-addressed: a cache hit is by definition the pinned bytes. A miss
// refetches and refuses anything that no longer hashes to the pin, which is
// what stops a floating URL (GitHub Pages, custom domains) from drifting.
async function loadPinned(file) {
  if (!/^[0-9a-f]{64}$/.test(file.sha256 || '')) throw new Error(`${file.url}: pin has no valid sha256`);
  if (existsSync(cachePath(file.sha256))) return readFileSync(cachePath(file.sha256), 'utf8');
  const text = await fetchText(file.url);
  if (sha256(text) !== file.sha256) {
    throw new Error(`${file.url} no longer matches its pinned sha256 (upstream changed). `
      + 'Run "refresh" to review the change before testing against it.');
  }
  store(text);
  return text;
}

// --------------------------------------------------------------------- GitHub

async function gh(path) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { Accept: 'application/vnd.github+json', ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub ${path} -> HTTP ${res.status}${res.status === 403 ? ' (rate limited? set GITHUB_TOKEN)' : ''}`);
  return res.json();
}

const memo = new Map();
const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
const defaultBranch = repo => once(`branch:${repo}`.toLowerCase(), () => gh(`repos/${repo}`).then(r => r.default_branch));
const commitSha = (repo, ref) => once(`sha:${repo}@${ref}`.toLowerCase(),
  () => gh(`repos/${repo}/commits/${encodeURIComponent(ref)}`).then(c => c.sha));

const rawAt = (repo, sha, path) => ({ url: `https://raw.githubusercontent.com/${repo}/${sha}/${path}`, commit: sha });

// The most immutable URL available for a manifest path or URL. GitHub-hosted
// files resolve to raw URLs at a commit; GitHub Pages and custom domains can
// only be pinned by content hash, so they are kept as-is.
async function resolveRef(ref, repo, branch) {
  let m;
  try {
    if (!/^https?:/.test(ref)) return rawAt(repo, await commitSha(repo, branch), ref.replace(/^\.?\//, ''));
    if ((m = ref.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/(refs\/(?:heads|tags)\/[^/]+|[^/]+)\/([^?#]+)/))) {
      return rawAt(m[1], await commitSha(m[1], m[2].replace(/^refs\/(heads|tags)\//, '')), m[3]);
    }
    if ((m = ref.match(/^https:\/\/cdn\.jsdelivr\.(?:net|xyz)\/gh\/([^/@]+\/[^/@]+)(?:@(refs\/(?:heads|tags)\/[^/]+|[^/]+))?\/([^?#]+)/))) {
      if (m[2]) m[2] = m[2].replace(/^refs\/(heads|tags)\//, '');
      return rawAt(m[1], await commitSha(m[1], m[2] || await defaultBranch(m[1])), m[3]);
    }
  } catch { /* unresolvable ref (e.g. jsDelivr @latest): fall through to hash-only pinning */ }
  return { url: ref, commit: null };
}

async function manifestList(repo) {
  const sha = await commitSha(repo, await defaultBranch(repo));
  const list = [JSON.parse(await fetchText(`https://raw.githubusercontent.com/${repo}/${sha}/manifest.json`))].flat();
  // Marketplace's own test for "is a theme" (FetchRemotes.ts#L268).
  return list.filter(e => e && e.name && e.usercss && e.description);
}

async function findManifestEntry(repo, name) {
  const list = await manifestList(repo);
  const m = list.find(e => e.name === name);
  if (!m) throw new Error(`${repo} has no theme "${name}"; has: ${list.map(e => `"${e.name}"`).join(', ')}`);
  return m;
}

// Same rule as Marketplace (extension.tsx): only .mjs loads as a module.
// Sniffing source for import/export misfires on comments and strings.
const isModuleUrl = url => /\.mjs(\?|#|$)/.test(url);

async function pinEntry(repo, m, id) {
  // Marketplace resolves relative paths against the entry's own branch first.
  const branch = m.branch || await defaultBranch(repo);
  const pin = async ref => {
    const r = await resolveRef(ref, repo, branch);
    const text = await fetchText(r.url);
    return { ...r, sha256: store(text), text };
  };
  const strip = ({ text, ...f }) => f;
  const include = await Promise.all((m.include || []).map(async u => ({ ...strip(await pin(u)), module: isModuleUrl(u) })));
  return {
    id,
    name: m.name,
    repo,
    usercss: strip(await pin(m.usercss)),
    schemes: m.schemes ? strip(await pin(m.schemes)) : null,
    include,
    pinned: new Date().toISOString().slice(0, 10),
  };
}

function showDiff(a, b, label) {
  if (!b) { console.log(`    removed: ${a.url}`); return; }
  if (!a || !existsSync(cachePath(a.sha256))) {
    console.log(`    old version not in cache — review the whole new file: ${cachePath(b.sha256)}`);
    return;
  }
  const r = spawnSync('git', ['diff', '--no-index', '--no-color', cachePath(a.sha256), cachePath(b.sha256)], { encoding: 'utf8' });
  if (r.error) {
    console.log(`    git unavailable (${r.error.message}); compare by hand:\n      ${cachePath(a.sha256)}\n      ${cachePath(b.sha256)}`);
    return;
  }
  const dir = join(CACHE, 'diffs');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${label.replace(/[^\w.-]+/g, '_')}.diff`);
  writeFileSync(out, r.stdout);
  const lines = r.stdout.split('\n');
  console.log(lines.slice(0, 80).map(l => '    ' + l).join('\n'));
  if (lines.length > 80) console.log(`    ... ${lines.length - 80} more lines: ${out}`);
}

// ------------------------------------------------------------------ schemes

// Marketplace's parseIni (Utils.ts#L98-L137), made tolerant of a leading "#"
// the way the CLI is: sections are schemes, `key = hex`, ";" comments, xrdb skipped.
function parseColorIni(text) {
  const schemes = {};
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line || line.includes('xrdb')) continue;
    const section = line.match(/^\[(.+)\]$/);
    if (section) { current = schemes[section[1].trim()] = {}; continue; }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (kv && current) current[kv[1].trim()] = kv[2].trim().replace(/^#/, '');
  }
  return schemes;
}

const hexToRgb = hex => {
  const h = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`not a hex colour: "${hex}"`);
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
};

// WCAG relative luminance of an [r,g,b] triple, 0 (black) .. 1 (white).
const luminance = rgb => {
  const [r, g, b] = rgb.map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const mainLuminance = vars => {
  try { return luminance(hexToRgb(vars.main)); } catch { return null; }
};

// The schemes worth sweeping: the default (first) plus the lightest and darkest
// by background (`main`) luminance. Contrast bugs show at the extremes; layout
// bugs are scheme-independent, so middle schemes add runtime, not signal.
// Schemes without a parseable `main` are left out of the ranking, not fatal.
// A color.ini with no sections yields [null]: one cell on Spotify's colours.
function pickSchemes(schemes) {
  const names = Object.keys(schemes);
  if (!names.length) return [null];
  const ranked = names
    .map(n => [n, mainLuminance(schemes[n])])
    .filter(([, l]) => l !== null)
    .sort((a, b) => a[1] - b[1]);
  if (!ranked.length) return [names[0]];
  return [...new Set([names[0], ranked.at(-1)[0], ranked[0][0]])];
}

// Below this, a scheme's background is dark. Mid-grey (#777) is ~0.18.
const LIGHT_THRESHOLD = 0.4;

// A malformed value drops that one variable, as the CLI would, instead of
// aborting the sweep. Skipped keys are returned for the report.
function schemeCss(scheme) {
  const skipped = [];
  const decls = Object.entries(scheme).map(([k, v]) => {
    try { return `--spice-${k}:#${v};--spice-rgb-${k}:${hexToRgb(v).join(',')};`; }
    catch { skipped.push(`${k}=${v}`); return ''; }
  });
  return { css: ':root{' + decls.join('') + '}', skipped };
}

// Relative url(...) in user.css must resolve against the stylesheet's own
// location, since an injected <style> has none. Raw GitHub serves assets with
// the wrong MIME type, so commit-pinned files rebase onto jsDelivr instead.
function assetBase(url) {
  const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([0-9a-f]{40})\/(.+)$/);
  return m ? `https://cdn.jsdelivr.net/gh/${m[1]}@${m[2]}/${m[3]}` : url;
}

const rebaseCssUrls = (css, base) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, q, u) =>
  /^(data:|https?:|blob:|#)/.test(u) ? match : `url("${new URL(u, base).href}")`);

async function prepareTheme(t, schemeName) {
  const schemes = t.schemes ? parseColorIni(await loadPinned(t.schemes)) : {};
  let scheme = { css: null, skipped: [] };
  if (schemeName !== null) {
    if (!schemes[schemeName]) throw new Error(`${t.id} has no scheme "${schemeName}"; has: ${Object.keys(schemes).join(', ')}`);
    scheme = schemeCss(schemes[schemeName]);
  }
  return {
    theme: t,
    schemeName,
    schemeCss: scheme.css,
    skippedVars: scheme.skipped,
    userCss: rebaseCssUrls(await loadPinned(t.usercss), assetBase(t.usercss.url)),
    scripts: await Promise.all(t.include.map(async f => ({ ...f, text: await loadPinned(f) }))),
  };
}

async function schemesFor(t, all) {
  if (!t.schemes) return { names: [null], schemes: {} };
  const schemes = parseColorIni(await loadPinned(t.schemes));
  const names = all && Object.keys(schemes).length ? Object.keys(schemes) : pickSchemes(schemes);
  return { names, schemes };
}

// ----------------------------------------------------------------------- CDP

async function xpuiTarget() {
  let targets;
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); }
  catch { throw new Error(`nothing on :${PORT} — start Spotify with --remote-debugging-port=${PORT}`); }
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
  // Every call times out, and a closed socket fails everything in flight: a
  // hung call would otherwise skip the `finally` that un-themes the client.
  const send = (method, params = {}, timeoutMs = 60000) => new Promise((res, rej) => {
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    pending.set(i, m => { clearTimeout(timer); res(m); });
    pending.get(i).reject = e => { clearTimeout(timer); rej(e); };
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) p.reject(new Error('CDP websocket closed (did the renderer crash?)'));
    pending.clear();
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('CDP websocket refused')));
  });
  return { ws, send, ready, onEvent: h => handlers.push(h) };
}

async function evaluate(conn, expression, { awaitPromise = true } = {}) {
  const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.error) throw new Error(`CDP error: ${r.error.message}`);
  if (r.result?.exceptionDetails) {
    const d = r.result.exceptionDetails;
    throw new Error('eval failed: ' + (d.exception?.description || d.text));
  }
  return r.result?.result?.value;
}

// Run a self-contained function in the page. It is serialised with
// toString(), so it must not close over anything in this file.
const call = (conn, fn, ...args) => evaluate(conn, `(${fn})(${args.map(a => JSON.stringify(a ?? null)).join(',')})`);

const pollUntil = async (conn, predicate, timeoutMs) => {
  const started = Date.now();
  for (;;) {
    let ok = false;
    try { ok = Boolean(await evaluate(conn, `(() => (${predicate}))()`)); } catch { /* not ready */ }
    if (ok) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error(`predicate never became true within ${timeoutMs}ms: ${predicate}`);
    await sleep(250);
  }
};

async function reloadAndWait(conn) {
  await conn.send('Page.reload', { ignoreCache: false });
  await sleep(500);
  await pollUntil(conn, 'document.readyState === "complete" && window.Spicetify?.Platform?.History', 30000);
}

async function navigate(conn, path) {
  await evaluate(conn, `Spicetify.Platform.History.push(${JSON.stringify(path)})`);
  await pollUntil(conn, `(Spicetify.Platform.History.location?.pathname || '').includes(${JSON.stringify(path)})`, 10000);
}

function shoot(args) {
  const r = spawnSync(process.execPath, [SHOOT, ...args], { encoding: 'utf8', env: { ...process.env, CDP_PORT: PORT } });
  return { ok: r.status === 0, out: (r.stdout + r.stderr).trim() };
}

// ------------------------------------------------------------ page functions

// A theme whose JS has already run cannot be removed at runtime: it may have
// restructured the DOM or registered listeners. Refuse rather than test on top
// of it and blame its breakage on the theme under test.
function pageGuard(marketplaceOnly) {
  if (document.querySelector('script.marketplaceScript')) {
    return 'a Marketplace theme with theme.js is active. Set Marketplace to no theme first';
  }
  if (marketplaceOnly) return null;
  const cliTheme = window.Spicetify?.Config?.current_theme;
  if (cliTheme && !/^marketplace$/i.test(cliTheme) && document.querySelector("script[src='extensions/theme.js']")) {
    return `CLI theme "${cliTheme}" injects theme.js. Run with no CLI theme or a CSS-only one`;
  }
  return null;
}

// The same removals as Marketplace's injectUserCSS. colors.css stays, as it
// does under Marketplace: the injected scheme wins on cascade order.
function pageStrip() {
  const removed = [];
  for (const el of document.querySelectorAll("link[href='user.css'], style.marketplaceCSS, .themeMatrix")) {
    removed.push(el.tagName.toLowerCase() + (el.getAttribute('href') ? `[href=${el.getAttribute('href')}]` : '.' + el.className.split(' ').join('.')));
    el.remove();
  }
  return removed;
}

// Marketplace CSS that arrived after the first strip. Unlike pageStrip, this
// leaves the injected .themeMatrix styles alone.
function pageLateMarketplaceCss() {
  const removed = [];
  for (const el of document.querySelectorAll("link[href='user.css'], style.marketplaceCSS")) {
    removed.push('late ' + el.tagName.toLowerCase() + '.' + (el.className || el.getAttribute('href')));
    el.remove();
  }
  return removed;
}

function pageStyle(cls, css) {
  const s = document.createElement('style');
  s.className = 'themeMatrix ' + cls;
  s.textContent = css;
  document.body.appendChild(s);
}

// ES-module theme scripts cannot go through Runtime.evaluate, so they load from
// a blob: URL. Classic scripts are evaluated directly, which CSP cannot block.
function pageModule(src, label) {
  return new Promise(resolve => {
    const s = document.createElement('script');
    s.type = 'module';
    s.className = 'themeMatrix';
    s.src = URL.createObjectURL(new Blob([src + `\n//# sourceURL=theme-matrix/${label}`], { type: 'text/javascript' }));
    s.onload = () => resolve(null);
    s.onerror = () => resolve(`${label}: module failed to load (CSP may block blob: scripts)`);
    document.body.appendChild(s);
  });
}

// True once no finite animation or transition is running on the first match
// or any ancestor. Theme JS often re-renders panels, and extensions fade their
// UI back in; probing mid-fade reads opacity 0 or a half-blended colour.
// Infinite animations (spinners, visualisers) never settle and are ignored.
function pageSettled(selector) {
  const el = document.querySelector(selector);
  if (!el) return true;
  for (let n = el; n; n = n.parentElement) {
    if (n.getAnimations().some(a => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime))) return false;
  }
  return true;
}

async function settledProbe(conn, selector, kind, sample) {
  let settled = true;
  try { await pollUntil(conn, `(${pageSettled})(${JSON.stringify(selector)})`, 5000); } catch { settled = false; }
  const probed = await call(conn, probe, selector, kind, sample);
  return { ...probed, settled };
}

function probe(selector, kind, sample) {
  const parse = s => {
    let m = s && s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    m = s && s.match(/^color\(srgb ([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
    }
    return null;
  };
  const lum = ([r, g, b]) => {
    const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const hex = c => '#' + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const name = n => n.tagName.toLowerCase()
    + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\s+/).join('.') : '');

  // Composites background layers up the ancestor chain until one is opaque.
  // Colour-stop gradients count as one layer per stop and the worst stop wins,
  // so the common flat tint (Spotify's own rgba(255,255,255,.03) overlay) stays
  // measurable. Cannot see siblings painted underneath (absolutely positioned
  // overlays), and gives up on url() images rather than guess.
  const contrast = el => {
    const cs = getComputedStyle(el);
    let fgRaw = cs.color;
    if (kind === 'icon') {
      const svg = el.matches('svg') ? el : el.querySelector('svg');
      const shape = svg && (svg.querySelector('path, circle, rect, polygon, ellipse, line') || svg);
      if (shape) {
        const scs = getComputedStyle(shape);
        fgRaw = scs.fill !== 'none' ? scs.fill : scs.stroke;
      }
    }
    const fg = parse(fgRaw);
    if (!fg) return { unknown: `foreground ${fgRaw}` };
    if (fg[3] === 0) return { unknown: 'transparent foreground (gradient or clipped text?)' };
    const layers = [];
    let opacity = 1;
    for (let n = el; n; n = n.parentElement) {
      const ncs = getComputedStyle(n);
      opacity *= Number(ncs.opacity);
      const img = ncs.backgroundImage;
      if (img !== 'none') {
        if (/url\(/.test(img)) return { unknown: `background image on ${name(n)}` };
        const stops = [...img.matchAll(/(?:rgba?|color)\([^()]*\)/g)].map(m => parse(m[0])).filter(Boolean);
        if (!stops.length) return { unknown: `unparsed gradient on ${name(n)}` };
        layers.push(stops);
      }
      const bg = parse(ncs.backgroundColor);
      if (!bg) return { unknown: `background ${ncs.backgroundColor} on ${name(n)}` };
      if (bg[3] > 0) layers.push([bg]);
      if (layers.length && layers[layers.length - 1].every(c => c[3] >= 1)) break;
    }
    if (!layers.length || !layers[layers.length - 1].every(c => c[3] >= 1)) {
      return { unknown: 'no opaque background behind element' };
    }
    let variants = layers.pop();
    while (layers.length) {
      const stops = layers.pop();
      variants = stops.flatMap(s => variants.map(v => over(s, v))).slice(0, 64);
    }
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    let result = null;
    for (const bg of variants) {
      const seen = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
      const [hi, lo] = [lum(seen), lum(bg)].sort((a, b) => b - a);
      const ratio = Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
      if (!result || ratio < result.ratio) result = { ratio, fg: hex(seen), bg: hex(bg) };
    }
    return { ...result, threshold: kind === 'icon' || large ? 3 : 4.5 };
  };

  const all = [...document.querySelectorAll(selector)];
  const items = all.slice(0, sample).map(el => {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const item = { rect: [r.x, r.y, r.width, r.height].map(Math.round), issues: [] };
    let opacity = 1;
    for (let n = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
    if (r.width <= 0 || r.height <= 0) item.issues.push('zero-size');
    else if (cs.visibility !== 'visible' || opacity === 0) item.issues.push('not-visible');
    else if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) item.issues.push('off-viewport');
    else {
      // Decorative badges often set pointer-events:none, which hit-testing
      // skips. Force it on for the duration of the probe.
      const prev = el.style.getPropertyValue('pointer-events');
      const prio = el.style.getPropertyPriority('pointer-events');
      el.style.setProperty('pointer-events', 'auto', 'important');
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      el.style.setProperty('pointer-events', prev, prio);
      if (!hit || !(hit === el || el.contains(hit))) {
        item.issues.push('occluded');
        item.occludedBy = hit ? name(hit) : null;
      }
    }
    if (!item.issues.length) item.contrast = contrast(el);
    return item;
  });
  return { count: all.length, items };
}

// ---------------------------------------------------------------- applying

const BASELINE_HINT = 'The sweep needs a client with no theme JS running.';

// Theme scripts persist their own settings in localStorage and re-apply them on
// load. Comfy stores its active colour scheme there, which silently overrides
// the injected one in the next cell. So storage is snapshotted before the first
// theme runs and reverted after every reload, before the next theme loads.
// Spotify's ES| telemetry counters are left alone: it rewrites them constantly
// and no theme touches them. IndexedDB is not covered.
const STORAGE_SNAPSHOT = join(CACHE, 'storage-snapshot.json');

function pageStorageDump() {
  const out = {};
  for (const k of Object.keys(localStorage)) if (!k.startsWith('ES|')) out[k] = localStorage.getItem(k);
  return out;
}

function pageStorageReset(snap) {
  const changed = [];
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('ES|')) continue;
    if (!(k in snap)) { localStorage.removeItem(k); changed.push(k); }
    else if (localStorage.getItem(k) !== snap[k]) { localStorage.setItem(k, snap[k]); changed.push(k); }
  }
  for (const k of Object.keys(snap)) {
    if (localStorage.getItem(k) === null) { localStorage.setItem(k, snap[k]); changed.push(k); }
  }
  return changed;
}

// Spotify's own per-user preference keys (`<user-hash>:name`) change during any
// session. They are reverted like everything else, but left out of reports.
const reportableWrites = keys => keys.filter(k => !/^[a-z0-9]{20,}:/.test(k));

// After injection, current_theme names the injected theme, so only the
// Marketplace half of the guard still means anything.
const guard = async (conn, marketplaceOnly = false) => {
  const blocked = await call(conn, pageGuard, marketplaceOnly);
  if (blocked) throw Object.assign(new Error(`baseline not clean: ${blocked}. ${BASELINE_HINT}`), { fatal: true });
};

async function applyTheme(conn, prepared, snapshot) {
  await reloadAndWait(conn);
  // Marketplace restores its theme asynchronously from IndexedDB after
  // Spicetify is up, so give it a moment before checking. The guard runs again
  // after injection in case it lands late anyway.
  await sleep(1000);
  await guard(conn);
  const reverted = snapshot ? await call(conn, pageStorageReset, snapshot) : [];
  const removed = await call(conn, pageStrip);
  const loadErrors = [];
  if (prepared) {
    const { theme: t, schemeName } = prepared;
    if (prepared.schemeCss) await call(conn, pageStyle, 'themeMatrixScheme', prepared.schemeCss);
    await call(conn, pageStyle, 'themeMatrixUserCSS', prepared.userCss);
    await evaluate(conn, `Spicetify.Config.current_theme = ${JSON.stringify(t.name)};`
      + `Spicetify.Config.color_scheme = ${JSON.stringify(schemeName ?? '')};`);
    for (const [i, s] of prepared.scripts.entries()) {
      const label = `${t.id}/include-${i}.js`;
      if (s.module) {
        const err = await call(conn, pageModule, s.text, label);
        if (err) loadErrors.push(err);
      } else {
        // Global scope, so top-level declarations behave as from a <script> tag.
        // Not awaited: many theme scripts end in an async IIFE whose init can
        // wait forever on an event that already fired. A <script> tag would not
        // wait either. The trailing `void 0` keeps the completion value inert.
        try { await evaluate(conn, s.text + `\n;void 0\n//# sourceURL=theme-matrix/${label}`, { awaitPromise: false }); }
        catch (e) { loadErrors.push(`${label}: ${e.message}`); }
      }
    }
    // Theme JS typically waits on DOM nodes before restructuring; give it a beat.
    await sleep(prepared.scripts.length ? 2500 : 300);
  }
  await guard(conn, true);
  const late = await call(conn, pageLateMarketplaceCss);
  if (late.length) removed.push(...late);
  return { removed, loadErrors, reverted };
}

async function restore(conn, snapshot) {
  await reloadAndWait(conn);
  const reverted = snapshot ? await call(conn, pageStorageReset, snapshot) : [];
  const leftover = await evaluate(conn, `document.querySelectorAll('.themeMatrix').length`);
  if (leftover) throw new Error(`${leftover} injected element(s) survived reload`);
  const userCss = await evaluate(conn, `Boolean(document.querySelector("link[href='user.css']"))`);
  return { userCss, reverted };
}

// ---------------------------------------------------------------------- spec

function loadSpec(repo) {
  const file = join(repo, 'themes.md');
  if (!existsSync(file)) throw new Error(`${file} not found. Copy templates/themes.md into the extension repo.`);
  // Normalised: with core.autocrlf the checkout has CRLF, and every \n below
  // would silently stop matching.
  const md = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const blocks = [...md.matchAll(/```json([^\n]*)\n([\s\S]*?)```/g)];
  const block = blocks.find(b => b[1].includes('theme-matrix')) || blocks[0];
  if (!block) throw new Error(`${file} has no \`\`\`json theme-matrix block`);
  let spec;
  try { spec = JSON.parse(block[2]); } catch (e) { throw new Error(`${file}: theme-matrix block is not valid JSON: ${e.message}`); }

  // The readiness predicate lives in screenshots.md already; reuse it so the
  // two specs cannot drift.
  let defaultReady = null;
  const shots = join(repo, 'screenshots.md');
  if (existsSync(shots)) {
    const text = readFileSync(shots, 'utf8').replace(/\r\n/g, '\n');
    // Only the section's own block: a section without one must not borrow the
    // next section's.
    const section = text.match(/^##\s*Readiness predicate[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im);
    const m = section?.[1].match(/```js\n([\s\S]*?)```/);
    if (m) defaultReady = m[1].trim();
    else console.warn(`WARNING: ${shots} has no js block under "## Readiness predicate"; surfaces without "ready" will not wait`);
  }

  if (!spec.surfaces || !Object.keys(spec.surfaces).length) throw new Error(`${file}: "surfaces" is empty`);
  if (!spec.elements?.length) throw new Error(`${file}: "elements" is empty`);
  for (const [k, s] of Object.entries(spec.surfaces)) {
    if (!s.path?.startsWith('/')) throw new Error(`${file}: surface "${k}" needs a "path" starting with "/"`);
    if (!s.shot) throw new Error(`${file}: surface "${k}" needs a "shot" selector (shots are always clipped)`);
    s.ready ??= defaultReady ?? 'true';
  }
  for (const e of spec.elements) {
    if (!spec.surfaces[e.surface]) throw new Error(`${file}: element ${e.selector} names unknown surface "${e.surface}"`);
    e.kind ??= 'text';
    e.label ??= `${e.selector} @${e.surface}`;
  }
  spec.skip ??= {};
  spec.add ??= [];
  // Spec entries name their own hashes, and a cache hit is trusted as-is, so a
  // malformed sha256 could point loadPinned at any local file.
  const isFile = f => f && typeof f.url === 'string' && /^[0-9a-f]{64}$/.test(f.sha256 || '');
  for (const t of spec.add) {
    const where = `${file}: add entry "${t?.id}"`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(t?.id || '')) throw new Error(`${where}: id must be lowercase letters, digits, dashes`);
    if (typeof t.name !== 'string' || typeof t.repo !== 'string') throw new Error(`${where}: needs "name" and "repo"`);
    if (!isFile(t.usercss) || (t.schemes !== null && !isFile(t.schemes))) throw new Error(`${where}: usercss/schemes need {url, sha256}`);
    if (!Array.isArray(t.include) || !t.include.every(isFile)) throw new Error(`${where}: include must be an array of {url, sha256}`);
  }
  return spec;
}

// Attribute a console error or exception to the extension, a theme script, or
// Spotify itself (whose own noise is ignored).
function attribute(m, spec) {
  let text, urls = [];
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    text = d.exception?.description || d.text;
    urls = [d.url, ...(d.stackTrace?.callFrames || []).map(f => f.url)];
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    text = m.params.args.map(a => a.value ?? a.description).join(' ');
    urls = (m.params.stackTrace?.callFrames || []).map(f => f.url);
  } else return null;
  urls = urls.filter(Boolean);
  if (urls.some(u => u.includes('theme-matrix/') || u.startsWith('blob:'))) return { source: 'theme', text };
  const fromExtension = (spec.extensionFile && urls.some(u => u.includes(spec.extensionFile)))
    || (spec.consoleFilter && text.includes(spec.consoleFilter));
  return fromExtension ? { source: 'extension', text } : null;
}

function judge(el, probed, verified) {
  const reasons = [];
  const warnings = [];
  const min = el.min ?? 1;
  if (probed.count < min) reasons.push(`missing (${probed.count}/${min})`);
  for (const item of probed.items) {
    reasons.push(...item.issues.map(i => (i === 'occluded' && item.occludedBy ? `occluded by ${item.occludedBy}` : i)));
    const c = item.contrast;
    if (!c) continue;
    if (c.unknown) warnings.push(`contrast-unknown: ${c.unknown}`);
    else if (c.ratio < c.threshold) reasons.push(`low-contrast ${c.ratio} < ${c.threshold} (${c.fg} on ${c.bg})`);
  }
  if (verified && !verified.ok) reasons.push('verify-failed');
  if (probed.settled === false) warnings.push('still animating after 5s; colours may be mid-transition');
  const dedupe = a => [...new Set(a)];
  return {
    status: reasons.length ? 'fail' : warnings.length ? 'warn' : 'pass',
    reasons: dedupe(reasons),
    warnings: dedupe(warnings),
    probe: probed,
  };
}

const RANK = { pass: 0, warn: 1, fail: 2, error: 3 };
const worst = statuses => statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'pass');

async function runCell(conn, spec, prepared, ctx) {
  const cell = {
    theme: prepared?.theme.id ?? 'stock',
    scheme: prepared?.schemeName ?? null,
    elements: {},
    shots: {},
    errors: { extension: [], theme: [] },
  };
  ctx.errors = cell.errors;
  try {
    const { loadErrors, reverted } = await applyTheme(conn, prepared, ctx.snapshot);
    // Reverted on this cell's reload, so written during the previous cell.
    if (ctx.prev) ctx.prev.storageWrites = reportableWrites(reverted);
    cell.errors.theme.push(...loadErrors);
    if (prepared?.skippedVars.length) cell.skippedVars = prepared.skippedVars;
  } catch (e) {
    if (e.fatal) throw e;
    cell.status = 'error';
    cell.error = e.message;
    return cell;
  }

  const surfaces = [...new Set(spec.elements.map(e => e.surface))];
  for (const sk of surfaces) {
    const s = spec.surfaces[sk];
    const els = spec.elements.filter(e => e.surface === sk);
    let notReady = null;
    try {
      await navigate(conn, s.path);
      for (const c of s.click || []) {
        const o = typeof c === 'string' ? { selector: c } : c;
        const r = shoot(['click', o.selector, ...(o.text ? ['--text', o.text] : []), ...(o.index != null ? ['--index', String(o.index)] : [])]);
        if (!r.ok) throw new Error(`click ${o.selector}: ${r.out}`);
        await sleep(400);
      }
      await pollUntil(conn, s.ready, (s.timeout ?? 15) * 1000);
    } catch (e) {
      notReady = e.message;
    }

    for (const el of els) {
      if (notReady) {
        cell.elements[el.label] = { status: 'fail', reasons: [`surface not ready: ${notReady}`], warnings: [] };
        continue;
      }
      let probed;
      try { probed = await settledProbe(conn, el.selector, el.kind, el.sample ?? 3); }
      catch (e) {
        cell.elements[el.label] = { status: 'fail', reasons: [`probe error: ${e.message}`], warnings: [] };
        continue;
      }
      let verified = null;
      if (el.svgPath || el.within || el.text) {
        verified = shoot(['verify', el.selector, '--min', String(el.min ?? 1),
          ...(el.within ? ['--within', el.within] : []),
          ...(el.svgPath ? ['--svg-path', el.svgPath] : []),
          ...(el.text ? ['--text', el.text] : [])]);
      }
      cell.elements[el.label] = judge(el, probed, verified);
    }

    // Always clipped: a full-viewport shot carries the user's library sidebar
    // and now-playing bar into a report that may get shared.
    const file = `${slug(cell.theme)}--${slug(cell.scheme ?? 'default') || 'default'}--${slug(sk)}.png`;
    const shot = shoot(['shot', join(ctx.out, file), '--selector', s.shot, '--pad', String(s.pad ?? 8)]);
    if (shot.ok) cell.shots[sk] = file;
    else cell.shotErrors = { ...cell.shotErrors, [sk]: shot.out.split('\n').pop() };
  }

  // Exceptions from async work land after the checks; collect what has arrived.
  await sleep(300);
  cell.status = worst([
    ...Object.values(cell.elements).map(e => e.status),
    cell.errors.extension.length ? 'fail' : 'pass',
  ]);
  return cell;
}

// ------------------------------------------------------------------ reports

const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function renderMatrix(report) {
  const labels = report.elements.map(e => e.label);
  const lines = [
    `# Theme matrix: ${report.extension}`,
    '',
    `Run ${report.started}, ${report.cells.length} cells. `
      + `Themes pinned by sha256 in \`themes.json\`; screenshots are evidence, open \`contact-sheet.html\`.`,
    '',
    `| Theme | Scheme | ${labels.map(esc).join(' | ')} | Extension errors |`,
    `|---|---|${labels.map(() => '---').join('|')}|---|`,
  ];
  for (const c of report.cells) {
    const name = c.theme === 'stock' ? '_stock (no theme)_' : c.theme;
    if (c.status === 'error') {
      lines.push(`| ${name} | ${esc(c.scheme ?? '')} | **ERROR** ${esc(c.error)} |${labels.slice(1).map(() => ' |').join('')} |`);
      continue;
    }
    const cells = labels.map(l => {
      const e = c.elements[l];
      if (!e) return '';
      if (e.status === 'pass') return 'pass';
      if (e.status === 'warn') return `warn: ${esc(e.warnings.join('; '))}`;
      return `**FAIL** ${esc(e.reasons.join('; '))}`;
    });
    const errs = c.errors.extension.length ? `**FAIL** ${c.errors.extension.length}` : 'none';
    lines.push(`| ${name} | ${esc(c.scheme ?? '(none)')} | ${cells.join(' | ')} | ${errs} |`);
  }

  const counts = Object.fromEntries(Object.keys(RANK).map(k => [k, report.cells.filter(c => c.status === k).length]));
  lines.push('', `**${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail, ${counts.error} error.**`);

  if (report.notes.length) lines.push('', '## Notes', '', ...report.notes.map(n => `- ${n}`));

  const wrote = report.cells.filter(c => c.storageWrites?.length);
  if (wrote.length) {
    lines.push('', '## localStorage written during a cell (reverted)', '');
    for (const c of wrote) lines.push(`- ${c.theme} / ${c.scheme ?? '(none)'}: ${c.storageWrites.map(k => `\`${esc(k)}\``).join(', ')}`);
  }

  const withErrors = report.cells.filter(c => c.errors && (c.errors.extension.length || c.errors.theme.length));
  if (withErrors.length) {
    lines.push('', '## Console errors', '');
    for (const c of withErrors) {
      lines.push(`### ${c.theme} / ${c.scheme ?? '(none)'}`, '');
      for (const e of c.errors.extension) lines.push(`- **extension:** \`${esc(e.split('\n')[0])}\``);
      for (const e of c.errors.theme) lines.push(`- theme (not your bug): \`${esc(e.split('\n')[0])}\``);
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}

function renderContactSheet(report) {
  const h = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const surfaceOf = Object.fromEntries(report.elements.map(e => [e.label, e.surface]));
  const order = [...report.cells].sort((a, b) => RANK[b.status] - RANK[a.status]);
  const figs = order.flatMap(c => Object.entries(c.shots || {}).map(([surface, file]) => {
    const why = Object.entries(c.elements)
      .filter(([label]) => surfaceOf[label] === surface)
      .flatMap(([, e]) => [...e.reasons, ...e.warnings]).join('; ');
    return `<figure class="${c.status}"><a href="${h(file)}"><img src="${h(file)}" loading="lazy"></a>`
      + `<figcaption><b>${h(c.status.toUpperCase())}</b> ${h(c.theme)} / ${h(c.scheme ?? '(none)')} / ${h(surface)}`
      + `${why ? `<br><small>${h(why)}</small>` : ''}</figcaption></figure>`;
  }));
  return `<!doctype html><meta charset="utf-8"><title>Theme matrix</title>
<style>
body{font:14px system-ui,sans-serif;margin:16px;background:#111;color:#eee}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px}
figure{margin:0;border:3px solid #444;border-radius:6px;overflow:hidden;background:#1b1b1b}
figure.fail,figure.error{border-color:#e5484d}figure.warn{border-color:#f5a524}figure.pass{border-color:#30a46c}
img{width:100%;display:block}figcaption{padding:6px 8px}small{color:#aaa}
</style>
<h1>Theme matrix: ${h(report.extension)}</h1>
<main>${figs.join('\n')}</main>
`;
}

// ---------------------------------------------------------------------- run

async function run(conn, repo, spec) {
  if (!existsSync(SHOOT)) throw new Error(`${SHOOT} not found. Install the spicetify-screenshots skill next to this one.`);

  const all = hasFlag('--schemes') && flag('--schemes') === 'all';
  const only = flag('--themes')?.split(',');
  const pinned = readThemes().themes;
  for (const t of spec.add) {
    if (pinned.some(p => p.id === t.id) || spec.add.filter(a => a.id === t.id).length > 1) {
      throw new Error(`themes.md: add entry id "${t.id}" collides with another theme`);
    }
  }
  const pool = [...pinned, ...spec.add];
  const themes = pool.filter(t => (only ? only.includes(t.id) : !spec.skip[t.id]));
  if (only) for (const id of only) if (!pool.some(t => t.id === id)) throw new Error(`no theme "${id}"`);

  // Spec-supplied themes never went through add/refresh review: the hashes
  // are the spec author's word. Their scripts need an explicit opt-in.
  const specScripts = themes.filter(t => spec.add.includes(t) && t.include.length);
  if (specScripts.length && !hasFlag('--allow-spec-themes')) {
    throw new Error(`themes.md adds theme(s) with theme.js (${specScripts.map(t => t.id).join(', ')}) that were not `
      + 'reviewed through "add"/"refresh". Read their scripts, then re-run with --allow-spec-themes.');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = resolve(flag('--out') || join(repo, '.theme-matrix', stamp));
  mkdirSync(out, { recursive: true });
  const gitignore = join(repo, '.gitignore');
  if (out.startsWith(join(repo, '.theme-matrix')) && !(existsSync(gitignore) && /\.theme-matrix/.test(readFileSync(gitignore, 'utf8')))) {
    console.warn('WARNING: .theme-matrix/ is not in the extension repo\'s .gitignore');
  }

  const report = {
    extension: spec.name || repo.split(/[\\/]/).pop(),
    started: new Date().toISOString(),
    themes: themes.map(t => ({ id: t.id, name: t.name, repo: t.repo, pinned: t.pinned })),
    skipped: Object.entries(spec.skip).map(([id, why]) => ({ id, why })),
    elements: spec.elements,
    notes: [],
    cells: [],
  };
  for (const s of report.skipped) report.notes.push(`skipped ${s.id}: ${s.why}`);

  // Resolve every theme's files up front, so a broken pin fails before the
  // client is touched rather than halfway through the sweep.
  const plan = [];
  for (const t of themes) {
    const { names, schemes } = await schemesFor(t, all);
    const lums = Object.values(schemes).map(mainLuminance).filter(l => l !== null);
    if (t.schemes && !lums.length) {
      report.notes.push(`${t.id} sets no background in color.ini (its theme.js colours the UI); only its first section was swept`);
    } else if (t.schemes && Math.max(...lums) < LIGHT_THRESHOLD) {
      report.notes.push(`${t.id} has no light scheme; contrast was only tested on dark backgrounds`);
    }
    for (const n of names) plan.push(await prepareTheme(t, n));
  }

  // An un-restored `inject` left a snapshot of the clean state; the live
  // storage is the polluted one. Use the file, and consume it on restore.
  const pendingInject = existsSync(STORAGE_SNAPSHOT);
  const snapshot = pendingInject ? JSON.parse(readFileSync(STORAGE_SNAPSHOT, 'utf8')) : await call(conn, pageStorageDump);
  if (pendingInject) console.log('found the snapshot from an un-restored inject; reverting to it');
  const ctx = { out, errors: null, prev: null, snapshot };
  conn.onEvent(m => {
    const a = ctx.errors && attribute(m, spec);
    if (a) ctx.errors[a.source].push(a.text);
  });

  const cells = [null, ...plan];
  let loopError = null;
  try {
    for (const [i, p] of cells.entries()) {
      const label = p ? `${p.theme.id} / ${p.schemeName ?? '(none)'}` : 'stock (no theme)';
      process.stdout.write(`[${i + 1}/${cells.length}] ${label} ... `);
      const cell = await runCell(conn, spec, p, ctx);
      report.cells.push(cell);
      ctx.prev = cell;
      console.log(cell.status === 'error' ? `ERROR ${cell.error}` : cell.status);
      writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
      // A failure with no theme at all is the extension's bug, and would make
      // every themed cell fail for the same reason.
      if (!p && cell.status !== 'pass' && cell.status !== 'warn' && !hasFlag('--keep-going')) {
        report.notes.push('stopped: the extension fails with no theme applied. Fix that first, or pass --keep-going');
        console.log('stock cell failed; stopping. Fix the extension first, or pass --keep-going.');
        break;
      }
    }
  } catch (e) {
    loopError = e;
  }

  ctx.errors = null;
  let restored = null, restoreError = null;
  try { restored = await restore(conn, ctx.snapshot); } catch (e) { restoreError = e; }
  if (restored && ctx.prev) ctx.prev.storageWrites = reportableWrites(restored.reverted);
  if (restored && pendingInject) rmSync(STORAGE_SNAPSHOT);
  report.finished = new Date().toISOString();
  if (loopError) report.notes.push(`aborted: ${loopError.message}`);
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(out, 'matrix.md'), renderMatrix(report));
  writeFileSync(join(out, 'contact-sheet.html'), renderContactSheet(report));
  // The sweep's own failure is the one worth reading; a restore failure on top
  // of it is reported, not substituted.
  if (restoreError) {
    const hint = `restore failed (${restoreError.message}). The client may still be themed: run "restore" by hand.`;
    throw new Error(loopError ? `${loopError.message}\n${hint}` : hint);
  }
  if (loopError) throw loopError;
  console.log(`\nclient restored, localStorage reverted${restored.userCss ? '' : ' (WARNING: user.css link absent after reload)'}`);
  console.log(`report: ${join(out, 'matrix.md')}`);
  console.log(`contact sheet: ${join(out, 'contact-sheet.html')}`);
  if (report.cells.some(c => c.status === 'fail' || c.status === 'error')) process.exitCode = 3;
}

// --------------------------------------------------------------------- main

async function offline() {
  if (cmd === 'list') {
    for (const t of readThemes().themes) {
      const floating = [t.usercss, t.schemes, ...t.include].filter(f => f && !f.commit).length;
      console.log(`${t.id.padEnd(18)} ${t.name.padEnd(22)} ${t.repo.padEnd(38)} pinned ${t.pinned}`
        + `${t.include.length ? '  theme.js' : ''}${floating ? `  (${floating} hash-only)` : ''}`);
    }
  } else if (cmd === 'schemes') {
    const t = findTheme(readThemes().themes, argv[1]);
    if (!t.schemes) { console.log(`${t.id} ships no color.ini; it runs on Spotify's default colours`); return true; }
    const schemes = parseColorIni(await loadPinned(t.schemes));
    const picked = pickSchemes(schemes);
    for (const [name, vars] of Object.entries(schemes)) {
      const l = mainLuminance(vars);
      console.log(`${picked.includes(name) ? '*' : ' '} ${name.padEnd(24)} main=#${(vars.main ?? '?').padEnd(6)} L=${l === null ? '?' : l.toFixed(3)}`);
    }
    console.log(picked[0] === null ? '\ncolor.ini has no sections: one cell on Spotify\'s colours'
      : `\n* = swept by default: ${picked.join(', ')}`);
  } else if (cmd === 'discover') {
    const top = Number(flag('--top', 20));
    const [search, blacklist] = await Promise.all([
      gh(`search/repositories?q=topic%3Aspicetify-themes&sort=stars&order=desc&per_page=${Math.min(top, 100)}`),
      fetch(BLACKLIST).then(r => r.json()).catch(() => ({ repos: [] })),
    ]);
    // Marketplace's blacklist: repo URLs, "//" comment lines, "*" globs.
    const banned = blacklist.repos.filter(p => !p.startsWith('//')).map(p =>
      new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'));
    const have = new Set(readThemes().themes.map(t => `${t.repo}|${t.name}`.toLowerCase()));
    for (const r of search.items) {
      const head = `${String(r.stargazers_count).padStart(5)}  ${r.full_name}`;
      if (r.archived) { console.log(`${head}  (archived, hidden by Marketplace)`); continue; }
      if (banned.some(re => re.test(r.html_url))) { console.log(`${head}  (blacklisted by Marketplace)`); continue; }
      let list;
      try { list = await manifestList(r.full_name); } catch { console.log(`${head}  (no readable manifest.json)`); continue; }
      if (!list.length) { console.log(`${head}  (no themes in manifest)`); continue; }
      for (const m of list) {
        const pinned = have.has(`${r.full_name}|${m.name}`.toLowerCase());
        console.log(`${head}  "${m.name}"${m.include?.length ? '  theme.js' : ''}${pinned ? '  [pinned]' : ''}`);
      }
    }
    console.log('\nPin one with: node matrix.mjs add <owner/repo> "<name>"');
  } else if (cmd === 'add') {
    const [repo, name] = [argv[1], argv[2]];
    if (!repo || !name) throw new Error('add needs <owner/repo> "<manifest name>"');
    const data = readThemes();
    const id = flag('--id') ?? slug(name);
    if (!hasFlag('--print') && data.themes.some(t => t.id === id)) throw new Error(`id "${id}" already pinned; pass --id`);
    const entry = await pinEntry(repo, await findManifestEntry(repo, name), id);
    if (hasFlag('--print')) { console.log(JSON.stringify(entry, null, 2)); return true; }
    data.themes.push(entry);
    writeThemes(data);
    console.log(`pinned ${id} (${name} from ${repo})`);
    for (const f of entry.include) {
      console.log(`  theme.js will run in your client. Review it: ${cachePath(f.sha256)}  (${f.commit ? 'commit-pinned' : 'hash-only, floating URL'})`);
    }
  } else if (cmd === 'refresh') {
    const data = readThemes();
    const accept = flag('--accept');
    const ids = new Set((accept || '').split(','));
    let pending = 0, accepted = 0;
    for (const [i, t] of data.themes.entries()) {
      let next;
      try { next = await pinEntry(t.repo, await findManifestEntry(t.repo, t.name), t.id); }
      catch (e) { console.log(`${t.id}: cannot re-resolve (${e.message})`); continue; }
      const diffs = [];
      const pair = (label, a, b) => { if (a?.sha256 !== b?.sha256) diffs.push({ label, a, b }); };
      pair('usercss', t.usercss, next.usercss);
      pair('schemes', t.schemes, next.schemes);
      for (let k = 0; k < Math.max(t.include.length, next.include.length); k++) pair(`include[${k}]`, t.include[k], next.include[k]);
      if (!diffs.length) { console.log(`${t.id}: unchanged`); continue; }
      console.log(`\n${t.id}: ${diffs.length} file(s) changed`);
      for (const d of diffs) {
        console.log(`  ${d.label}: ${d.b?.url ?? '(removed)'}`);
        if (d.label.startsWith('include')) showDiff(d.a, d.b, `${t.id}-${d.label}`);
      }
      if (accept === 'all' || ids.has(t.id)) { data.themes[i] = { ...t, ...next }; accepted++; console.log('  ACCEPTED'); }
      else pending++;
    }
    if (accepted) writeThemes(data);
    if (pending) {
      console.log(`\n${pending} theme(s) changed upstream. theme.js runs inside your logged-in client: `
        + 'review the diffs above, then re-run with --accept <id,...|all>.');
    }
  } else {
    return false;
  }
  return true;
}

(async () => {
  if (await offline()) return;

  // Validate the spec before touching the client, so a typo costs nothing.
  const repo = resolve(argv[1] || '.');
  const spec = cmd === 'run' ? loadSpec(repo) : null;

  const conn = connect(await xpuiTarget());
  await conn.ready;
  await conn.send('Runtime.enable');
  await conn.send('Page.enable');

  if (cmd === 'inject') {
    const t = findTheme(readThemes().themes, argv[1]);
    const schemeName = flag('--scheme') ?? (await schemesFor(t, false)).names[0];
    const prepared = await prepareTheme(t, schemeName);
    const errors = [];
    conn.onEvent(m => { const a = attribute(m, {}); if (a) errors.push(a.text); });
    // Kept across invocations so "restore" can revert what the theme writes. An
    // existing file means an earlier inject was never restored: keep that older,
    // cleaner snapshot instead of capturing the polluted state.
    if (!existsSync(STORAGE_SNAPSHOT)) {
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(STORAGE_SNAPSHOT, JSON.stringify(await call(conn, pageStorageDump)));
    }
    const snapshot = JSON.parse(readFileSync(STORAGE_SNAPSHOT, 'utf8'));
    const { removed, loadErrors } = await applyTheme(conn, prepared, snapshot);
    console.log(JSON.stringify({ theme: t.id, scheme: schemeName, removed, themeErrors: [...loadErrors, ...errors] }, null, 2));
    console.log('Run "restore" when done.');

  } else if (cmd === 'check') {
    const selector = argv[1];
    if (!selector) throw new Error('check needs a selector');
    const kind = flag('--kind', 'text');
    const probed = await settledProbe(conn, selector, kind, Number(flag('--sample', 3)));
    const verdict = judge({ min: 1 }, probed, null);
    console.log(JSON.stringify({ selector, kind, ...verdict }, null, 2));
    if (verdict.status === 'fail') process.exitCode = 3;

  } else if (cmd === 'restore') {
    const snapshot = existsSync(STORAGE_SNAPSHOT) ? JSON.parse(readFileSync(STORAGE_SNAPSHOT, 'utf8')) : null;
    const { userCss, reverted } = await restore(conn, snapshot);
    if (snapshot) rmSync(STORAGE_SNAPSHOT);
    const writes = reportableWrites(reverted);
    console.log(`restored: nothing injected survived reload${userCss ? '' : ' (WARNING: user.css link absent)'}`);
    console.log(snapshot ? `localStorage reverted${writes.length ? `; theme had written: ${writes.join(', ')}` : ''}`
      : 'no storage snapshot (no inject since the last restore); localStorage untouched');

  } else if (cmd === 'run') {
    await run(conn, repo, spec);

  } else {
    console.error('unknown command: ' + cmd);
    console.error('use list|schemes|discover|add|refresh|inject|check|restore|run');
    process.exitCode = 2;
  }

  conn.ws.close();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
