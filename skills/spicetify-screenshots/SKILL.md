---
name: spicetify-screenshots
description: Use when a Spicetify extension repo needs screenshots for its README or its Marketplace preview image — including when manifest.json points at a preview file that does not exist, when a README describes a feature it never shows, or when existing shots are stale, low-resolution, or leak personal library data.
---

# Spicetify extension screenshots

Capture publishable images of an extension's UI from the running Spotify desktop client.

**Core principle: a screenshot is evidence. It must show the extension's real code
rendering real state. Never anything else.**

Use `spicetify-live-test` for CDP mechanics (console, symlinks, ports). This skill covers
capture, and adds `shoot.mjs` next to this file.

## Order of work

Write the repo's `screenshots.md` **before capturing anything**. It fixes the shot list,
readiness predicate, fixtures, and the disambiguation table up front — otherwise you
re-derive all four on every run, and the integrity checks below have nothing to check
against. Template: `templates/screenshots.md`.

1. Write / read `screenshots.md`
2. Stock theme, fixed viewport
3. Snapshot storage → seed fixture → **reload**
4. Navigate, wait, **verify**, capture
5. Restore storage, reset viewport

## The integrity rule

**Every pixel presented as extension output must have been rendered by the extension.**

Before capturing any shot that claims to show a feature, prove the elements are real:

```
node shoot.mjs verify ".my-ext-badge" --min 3 --within ".main-trackList-trackListRow" --svg-path "M13.485"
```

`verify` checks each match is present, laid out, visible, inside the expected ancestor, and —
via `--svg-path` — drawn from the extension's own icon data. It exits 3 and tells you to stop
if the bar isn't met.

**Do not hand-roll this with `elementFromPoint`.** Badges routinely set
`pointer-events: none`, so hit-testing returns the element *behind* the badge and reports a
perfectly good badge as absent. That check fails on correct code, which is worse than no check.

If `verify` cannot be made to pass with real data, **you do not have a screenshot yet.** Seed
fixtures, or you have found a bug — report it rather than papering over it.

**Forbidden, without exception:**

- Injecting, styling, or editing DOM to produce a visual the extension did not render
- Capturing native Spotify UI and presenting it as extension output
- Editing the resulting PNG to add, remove, or alter feature content
- Captioning a shot with a feature it does not actually demonstrate

Spotify's native "Save to Liked Songs" control is a **green checkmark** in the now-playing bar
and track rows — the single most likely thing to be mistaken for a custom badge. Both can
appear in the same frame. Record the distinguishing selector in the repo's `screenshots.md`
disambiguation table.

| Rationalization | Reality |
|---|---|
| "Injecting the badge markup shows what users would see" | It shows what *you* drew. If the extension can render it, seed state and let it. If it can't, that's a bug the screenshot would hide. |
| "The empty state is technically accurate" | Accurate and useless. Seed fixtures — a stats panel of zeros costs installs. |
| "That checkmark is close enough / probably ours" | Run `verify`. "Probably" is how fabricated evidence ships. |
| "I'll crop the misleading part out" | Cropping to hide a misidentification is still misidentification. Re-shoot. |
| "It's only the preview thumbnail, nobody inspects it" | It's the first thing every Marketplace user sees. |
| "The feature is broken, but the shot would show the intent" | A screenshot of intent is a lie about behaviour. Report the bug. |

## Setup, every session

**1. Stock theme.** A custom theme retints the whole UI and misrepresents what a new installer
sees. Check first:

```
spicetify config current_theme          # expect empty or "SpicetifyDefault"
```

Switching costs a Spotify restart, which interrupts playback — **ask before doing it**, and
re-run the `spicetify-live-test` symlinks afterwards, since `apply` replaces them with plain
copies and silently breaks hot reload.

If you cannot switch (user declines, playback in progress, apply is risky): **the shots are
diagnostic, not publishable.** Say so explicitly in your report, and do not commit them as
README images.

**2. Fixed viewport.** A stable size makes shots reproducible:

```
node shoot.mjs viewport 1440 900
node shoot.mjs status              # confirm live size matches; check again after navigating
```

Hi-dpi output comes from `--scale`, which re-rasterises vectors at n×. **`deviceScaleFactor`
is inert on the Spotify client** — overriding it leaves `devicePixelRatio` at 1 and changes
nothing. `--scale 2` alone gives you real 2× images.

The override is persisted to `.shoot-state.json` and re-asserted on every invocation, because
a CDP override dies with the session that set it. `shot` refuses to capture if the live
viewport has drifted from what you set. Always finish with:

```
node shoot.mjs reset-viewport      # re-asserts, clears, then verifies against outerWidth
```

Run it even on failure — chain with `;` not `&&`. A stale override leaves the user's client at
a fake window size.

## Fixture seeding

Most extensions render nothing without data. Seed real state, let the real code draw it, then
restore. Snapshot first — it is the safety net.

```
node shoot.mjs snapshot --prefix "my-ext-" backup.json   # --prefix catches keys you forgot
node shoot.mjs restore fixture.json
node shoot.mjs reload                                    # REQUIRED, see below
node shoot.mjs verify ".my-ext-badge" --min 3
# ... capture ...
node shoot.mjs reset-viewport ; node shoot.mjs restore backup.json
```

**Seeding does nothing until you reload.** Extensions typically read storage once at boot and
guard against re-init, so writing `localStorage` mid-session has no visible effect. If a
fixture "doesn't work", this is why.

Prefer `--prefix` over naming keys: extensions often declare a key far from the others, and a
key you failed to snapshot is a key you cannot restore.

**Fixture file format:** `restore` writes raw `localStorage` values, which are always strings.
JSON payloads must be *stringified inside* the JSON file:

```json
{ "my-ext-data": "[{\"id\":\"abc\",\"listenedAt\":1730000000}]" }
```

Generate these with a small script rather than hand-escaping. `restore` rejects non-string
values with an explanatory error. Commit fixtures to `screenshots/fixtures/` and populate them
with well-known public albums — never the user's own library.

## Privacy

`--selector` is **not** an isolation guarantee. A clip is a rectangle over the composited
page, not a standalone render of the element: anything floating on top — the now-playing bar,
overlays, menus — lands in the frame, and an element box can extend past the visible area.

`shot` refuses clips that overflow the viewport for exactly this reason. `--allow-overlap`
overrides it, but only after you have looked at the frame.

So: prefer tight element-scoped clips, then **read the PNG back and inspect it** for playlist
and folder names, "Liked Songs — <name>", avatar, notification badges, recommendations, and
the currently-playing track. Scroll the target fully into view rather than capturing a clip
that runs off-screen. Personal taste data in a public README is not recoverable after push.

## Marketplace preview spec

The card renders the preview at **175×175 CSS px with `object-fit: cover`**, centre-cropped.

- **Square** — capture with `--rect x,y,w,h` at equal width and height rather than cropping later.
- **≥512×512**, so it stays sharp on hi-dpi.
- **Legible at 175px.** One bold visual. A settings form or text panel becomes an illegible
  dark rectangle. Downscale and look before shipping.
- Watch contrast: a translucent badge disc can vanish against dark album art. Choose a cover
  that makes the feature readable.
- Resolved from `https://raw.githubusercontent.com/{user}/{repo}/{branch}/{preview}` — the path
  must exist on the default branch or the card renders broken.

Full manifest and discovery reference: `marketplace-preview.md`.

## Quick reference

| Need | Command |
|---|---|
| Fixed viewport | `node shoot.mjs viewport 1440 900` |
| Check for drift | `node shoot.mjs status` |
| Go to a page | `node shoot.mjs navigate /album/<id>` |
| Apply seeded state | `node shoot.mjs reload` |
| Prove it's really rendered | `node shoot.mjs verify ".x" --min 3 --within ".row"` |
| Clip to element | `node shoot.mjs shot out.png --selector ".x" --scale 2` |
| Square preview | `node shoot.mjs shot preview.png --rect 400,200,600,600` |
| Breathing room | add `--pad 12` |
| Click an ambiguous menu item | `node shoot.mjs click ".menu-item" --text "Mark as listened"` |
| Wait for render | `node shoot.mjs wait "document.querySelectorAll('.x').length>2" 15` |
| Back up / restore | `node shoot.mjs snapshot --prefix "my-ext-" b.json` / `restore b.json` |

`click` refuses ambiguous selectors rather than guessing — Spotify context menus are a dozen
identical nodes distinguishable only by text, so use `--text`. Synthetic `el.click()` no-ops
on those menus; `click` dispatches real mouse events.

## Common mistakes

- **Seeding without reloading.** The single most common failure. Storage is read at boot.
- **Blind `sleep` after navigating.** Injection is MutationObserver-driven and racy. Use
  `wait`, then `verify`.
- **Trusting `--selector` for privacy.** It clips the composited page. Inspect the PNG.
- **Leaving the viewport overridden.** Always `reset-viewport`, even on failure.
- **Capturing before the extension reloaded.** Edit, reload, *then* capture — otherwise you
  are shooting the old build. Confirm with a marker log if unsure.
- **Trusting the empty state.** Zeros or "Nothing here yet" means seed fixtures.
- **Shipping shots taken under a custom theme.** They misrepresent a fresh install.
