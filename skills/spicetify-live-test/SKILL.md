---
name: spicetify-live-test
description: Use when testing, debugging, or verifying a Spicetify extension change in the running Spotify desktop client — reading its console, running JS against Spicetify Platform APIs, inspecting or mutating extension localStorage, hot-reloading after an edit, or confirming a fix actually works in the client rather than only passing a syntax check. NOT for Spotify Web API work (playback/playlists via OAuth), which is a different layer.
---

# Spicetify live-client testing

Test extension changes against the **real Spotify desktop client**, not just `node --check`.
Spicetify only patches the desktop app — the web player never loads extensions, so there is
no browser-based substitute for this.

## How it works

Spotify desktop is Chromium, so it speaks the Chrome DevTools Protocol on a debug port. Point
the extension file Spotify loads at your repo via a symlink, and a repo edit plus a CDP reload
runs the new code — no `spicetify apply`, no restart, no copy, no `spicetify watch`.

## One-time setup

**1. Open the debug port.** Add the launch flag to `config-xpui.ini` (find it with
`spicetify path userdata`), then apply once:

```
spotify_launch_flags = --remote-debugging-port=9222
```
```
spicetify apply     # restarts Spotify
```

Verify: `curl http://127.0.0.1:9222/json/version` should return JSON naming Spotify in the
User-Agent. Connection refused means the flag did not take.

**2. Symlink your extension into both locations.** The Extensions dir is the source Spicetify
copies *from*; the xpui dir is what the client actually *loads*. Link both so the repo file is
authoritative:

```
<userdata>/Extensions/<name>.js          # spicetify path userdata
<spotify>/Apps/xpui/extensions/<name>.js # the loaded bundle
```

On Windows those are typically `%APPDATA%\spicetify\Extensions\` and
`%APPDATA%\Spotify\Apps\xpui\extensions\`; on macOS/Linux use `spicetify path userdata` and
`spicetify path` to resolve them rather than guessing.

**Re-create the symlinks after every `spicetify apply`** — apply overwrites the bundle with a
plain copy and silently breaks hot reload. A change that "isn't taking effect" is almost
always this.

**3. Optional: wire up an MCP server** for richer interaction, pointing a CDP-capable MCP
server at `http://127.0.0.1:9222`. The bundled `cdp.mjs` covers the same ground without one.

## Repo configuration

Copy `extensions.example.json` from the repo root to `extensions.json` and map each local
repo to the extension filename Spotify loads:

```json
{
  "C:/Projects/my-extension": "my-extension.js"
}
```

The mapping matters because the repo directory name and the bundle filename often differ.

## The loop

1. Confirm the port: `curl http://127.0.0.1:9222/json/version`. Refused → Spotify isn't
   running with the flag. Re-applying restarts Spotify and interrupts playback, so confirm
   with the user first.
2. Edit the repo `.js`.
3. `node --check <file>` — syntax gate, cheap, catches most breakage before you touch the client.
4. Reload, read the console, assert.

```
node cdp.mjs reload [sec]          # reload xpui, print console captured for N s (default 6)
node cdp.mjs console [sec]         # capture console without reloading
node cdp.mjs eval "<expression>"   # Runtime.evaluate, print returnByValue result
node cdp.mjs screenshot out.png    # PNG of the client
CDP_FILTER='My Extension' node cdp.mjs reload    # filter console to a regex
```

Set `CDP_PORT` if you did not use 9222.

**Prove the reload actually happened** before trusting any result. Add a temporary marker log,
reload, confirm it appears, then remove it. Stale-bundle debugging otherwise wastes hours.

## Per-repo test specs

Give each repo a `tests.live.md` at its root listing its storage keys, expected console
patterns, and numbered scenarios (T1, T2, …). Read it before testing that repo. See
`templates/tests.live.md` for the format.

## Notes

- Extension state normally lives in `localStorage` (e.g. `my-extension-config`). Read and
  mutate it via `eval`, then reload, to drive the UI into a specific state. **Snapshot before
  you mutate** — this is the user's real client, and their real data.
- `:9222` is a localhost-only debug port. Open it while testing; drop the launch flag when
  done if you would rather it stay closed.
- Some extensions ship a `styles.css` that lives only in the Extensions folder, not the repo.
  Only the `.js` is symlinked, so CSS edits need to be made in the Extensions folder or
  symlinked separately.

## Screenshots

For README or Marketplace images, use the `spicetify-screenshots` skill instead —
`cdp.mjs screenshot` is full-viewport at 1x with no crop, which is fine for debugging and
not good enough to publish.
