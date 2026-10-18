---
name: spicetify-theme-matrix
description: Use when checking whether a Spicetify extension still looks right and works under popular Marketplace themes (Comfy, Dribbblish, Catppuccin, Lucid, Bloom, ...) — including "invisible on theme X" or "broken with theme Y" bug reports, before a release, or after changing anything the extension draws (colours, badges, anchors to native DOM).
---

# Spicetify theme matrix

Sweep an extension's UI across pinned, popular Marketplace themes in the running Spotify
desktop client, and report per theme × colour scheme whether each declared element is
present, visible, unoccluded, and legible.

**The extension is under test; themes are the environment.** A theme that is ugly on its
own is not a finding. An extension element that a theme hides, covers, or renders at 1.3:1
contrast is.

Use `spicetify-live-test` for CDP setup (debug port, symlinks). Captures and `verify` are
delegated to `spicetify-screenshots/shoot.mjs`, which must be installed next to this skill.

## How a theme gets in

`matrix.mjs` installs themes the way Marketplace does, at runtime, never with
`spicetify apply`. That keeps each swap to a few seconds, with no restart, and leaves the
hot-reload symlinks alone. Verified against `spicetify/marketplace@9ebdc53`:

- Reload the renderer, then remove `link[href='user.css']` and any `style.marketplaceCSS`.
  `colors.css` stays, as it does under Marketplace. The injected scheme wins on cascade order.
- Append `<style class="themeMatrix themeMatrixScheme">` with `--spice-K` and
  `--spice-rgb-K` from the chosen `color.ini` section, then the theme's `user.css` with
  relative `url()`s rebased onto its source.
- Run `include` scripts. Classic scripts go through `Runtime.evaluate`, which CSP cannot
  block. ES modules load from a `blob:` URL.
- `restore` (and the end of every `run`) reloads. Nothing is written to Spicetify config,
  or to Marketplace's storage (IndexedDB since mid-2026, not localStorage).

**Theme scripts write localStorage, and that state leaks.** Comfy saves its active scheme
in `comfy:config` and re-applies it on load, overriding the injected one in the next cell.
Lucid and Hazy write settings too. So `run` snapshots localStorage before the first theme,
and reverts it after every reload, before the next theme loads. It does the same on
`restore`. `inject` keeps the snapshot in `.theme-cache/storage-snapshot.json` until
`restore` consumes it. `matrix.md` lists what each cell wrote.

Two consequences:
- Anything Spotify or your extensions wrote during the sweep is reverted as well. Spotify's
  `ES|` telemetry counters are the exception: they are skipped.
- IndexedDB and cookies are not snapshotted. A theme that keeps state there can still leak
  between cells. If two schemes of one theme produce identical colours, suspect this.

**Baseline must be JS-free.** Theme JS that has already run cannot be undone, so the sweep
refuses to start when a Marketplace theme with `include` scripts is active, or when a CLI
theme injects `extensions/theme.js`. A CSS-only CLI theme is fine, because it gets stripped.

Runtime injection is close to what Marketplace users get, but it is not `apply`. If one
cell's result looks implausible, confirm it the slow way:
`spicetify config current_theme <T> color_scheme <S> && spicetify apply`. Then re-create the
hot-reload symlinks (see `spicetify-live-test`).

## Trust: theme.js is third-party code in your logged-in client

Every theme file is pinned in `themes.json` by **sha256**. Where the file lives on GitHub,
it is also pinned to a commit-SHA URL. A run executes only bytes that match the pin, served
from `.theme-cache/` or refetched and re-verified.

Many popular themes serve their JS from GitHub Pages or a custom domain (Comfy, Bloom,
Lucid). Those URLs float. `list` marks them `hash-only`. Once upstream changes, a fresh
clone can no longer fetch the pinned bytes, and the run fails with a pointer to `refresh`.
It never silently tests a different theme.

- `refresh` re-resolves every entry from its repo's `manifest.json`. It prints a
  `git diff --no-index` of each changed theme.js, and writes nothing without
  `--accept <id,...|all>`. **Read the diff before accepting.** Bundled or minified JS is a
  reason to look harder, not to skip it.
- `add` pins a new entry and prints the cached path of each script it will execute.
- Some theme scripts fetch more code at runtime. Pinning covers what the manifest names,
  not what that code downloads later. Only `.mjs` includes load as ES modules, as under
  Marketplace. A module's own `import`s are neither pinned nor resolvable from its `blob:` URL.
- `add` entries in an extension's `themes.md` never went through `add`/`refresh` review.
  Their hashes are the spec author's word. A run that would execute their theme.js stops
  until you pass `--allow-spec-themes`, and you should read those scripts first.

## Order of work

1. The extension repo needs `screenshots.md` first. The theme spec reuses its readiness
   predicate. Template: `templates/screenshots.md`.
2. Write `themes.md` in the extension repo from `templates/themes.md`, and add
   `.theme-matrix/` to its `.gitignore`.
3. Set the stock theme and a fixed viewport (`shoot.mjs viewport 1280 800`), and seed
   fixture state if the surfaces need it. Surface paths must point at public albums or
   playlists, because every cell is screenshotted.
4. `node matrix.mjs run <ext-repo>`
5. Read `matrix.md`, then open `contact-sheet.html` for every warn and fail. Restore
   fixtures and reset the viewport afterwards.

The first cell is always **stock**, with no theme. If it fails, the extension is broken
regardless of theme, and the sweep stops instead of producing ten identical failures.
`--keep-going` overrides this.

## Commands

```
node matrix.mjs list                                 pinned themes (theme.js, hash-only flags)
node matrix.mjs schemes <id>                         colour schemes; * = swept by default
node matrix.mjs run <ext-repo> [--themes a,b] [--schemes all] [--out dir] [--keep-going] [--allow-spec-themes]
node matrix.mjs inject <id> [--scheme s]             one theme, for poking at by hand
node matrix.mjs check <selector> [--kind text|icon]  the per-element probe, on the live page
node matrix.mjs restore                              reload, verify nothing injected survived
node matrix.mjs discover [--top n]                   popular Marketplace themes, pinned or not
node matrix.mjs add <owner/repo> "<name>" [--id x] [--print]
node matrix.mjs refresh [--accept <id,...|all>]
```

Set `GITHUB_TOKEN` (or `GH_TOKEN=$(gh auth token)`) for `discover`, `add` and `refresh`.
Unauthenticated GitHub allows 60 requests an hour, and `refresh` makes several per theme.

If a `run` or `inject` is interrupted, the client is still themed. Run `restore`.

## What a cell checks

For each element in `themes.md`, the probe first waits up to 5s for animations on the
element and its ancestors to finish. Theme JS often re-renders panels, extensions fade their
UI back in, and a mid-fade probe reads opacity 0. Then up to `sample` matches (default 3)
are scrolled into view and probed:

| Result | Meaning |
|---|---|
| `missing (n/min)` | fewer matches than `min`: the theme's DOM changes broke the anchor |
| `zero-size`, `not-visible` | laid out at 0×0, or `visibility`/effective `opacity` hides it |
| `off-viewport` | still outside the viewport after `scrollIntoView` |
| `occluded by <el>` | hit-testing at its centre lands on another element. `pointer-events` is forced on for the probe, so decorative badges are not false positives |
| `low-contrast r < t` | WCAG ratio below 4.5 (text) or 3 (icon, large text) |
| `verify-failed` | `shoot.mjs verify` rejected it (`svgPath`, `within`, `text`) |
| `contrast-unknown` (warn) | a `url()` background image, or no opaque ancestor. Judge from the screenshot |
| `still animating` (warn) | something was still transitioning after 5s. Colours may be mid-blend |
| extension errors | console errors or exceptions whose stack is in `extensionFile`, or that match `consoleFilter`. Theme-script errors are listed as "not your bug" |

Contrast composites background layers up the **ancestor** chain. A colour-stop gradient
counts as one layer per stop, and the worst stop wins. That keeps Spotify's own flat
`rgba(255,255,255,.03)` panel tint measurable. The probe cannot see a sibling painted
underneath, such as an absolutely positioned badge over album art. Expect
`contrast-unknown` on image-backed themes, and check the screenshot.

The classic failure this catches: an extension colours its text with `--spice-text`, but
sits on a panel whose background Spotify hardcodes. On a light scheme that becomes dark
text on a dark panel.

### Schemes

By default each theme runs three schemes: its first, its lightest, and its darkest, ranked
by `--spice-main` luminance and deduplicated. Contrast bugs show up at the extremes. Layout
bugs don't depend on the scheme, because the CSS is the same and only the variables change.
`--schemes all` runs every section and is the release check.

Dynamic themes (Default Dynamic, Bloom with album colours) derive colours from the playing
track's artwork. Their ratios move between runs. Treat a borderline fail there as "check
with a few tracks", not as a regression.

`matrix.md` notes themes with **no light scheme** (lightest `main` luminance < 0.4). For
those, a pass only covers dark backgrounds. Some themes (Lucid, Default Dynamic) set no
`main` in `color.ini` and colour everything from theme.js. Only their first section is
swept. A malformed colour value drops that one variable, not the run.

## Output

`<ext-repo>/.theme-matrix/<timestamp>/`, which should be gitignored. It is evidence, not
docs:

- `report.json`: every cell, probe result, contrast pair, and error. It is rewritten after
  each cell, so an interrupted run still leaves data.
- `matrix.md`: a theme × element grid of pass / warn / **FAIL** with reasons, then notes
  and console errors.
- `contact-sheet.html`: every cell's screenshot, failures first.
- `<theme>--<scheme>--<surface>.png`, always clipped to the surface's `shot` selector. A
  full-viewport shot would carry your library sidebar and now-playing bar into the report.

Screenshots are evidence for the grid, not a substitute for it. Do not report "looks fine
under Comfy" from a screenshot when the grid says FAIL, or the reverse, without saying
which one you believe and why.

## Common mistakes

| Mistake | Fix |
|---|---|
| Testing with a Marketplace theme active | Set Marketplace to no theme. The guard refuses otherwise |
| Surfaces on personal pages (Liked Songs, your playlists) | Public albums and playlists only. Every cell is screenshotted |
| Accepting `refresh` without reading the diff | That diff is code about to run with your Spotify session |
| Treating `contrast-unknown` as pass | It means "look at the screenshot" |
| Calling every FAIL the extension's bug | Check the stock cell and the "not your bug" theme errors first. Some themes break native UI too. `skip` the theme in `themes.md` with a reason if you won't support it |
| Running `spicetify apply` to confirm, then wondering why hot reload died | Apply replaces the symlinks. Re-create them |
