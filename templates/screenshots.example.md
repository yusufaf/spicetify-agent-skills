# Screenshots — Listening List

Read by the `spicetify-screenshots` skill. Keep selectors and rects accurate; they are what
makes a capture run mechanical instead of exploratory.

Extension file: `listening-list.js`
Storage keys: `listening-list-data`, `listening-list-config`, `listening-list-meta`

## Readiness predicate

```js
document.querySelectorAll('.ll-badge--tracklist').length >= 8
```

## Verification

Proves the badges are the extension's own output, not native Spotify UI:

```
node shoot.mjs verify ".ll-badge--tracklist" --min 8 --within ".main-trackList-trackListRow" --svg-path "M13.485"
node shoot.mjs verify ".ll-badge--header" --min 1 --svg-path "M13.485"
```

`M13.485` pins the icon to `LL_CHECK_SVG_PATH` in the source.

Do **not** verify with `elementFromPoint` — `.ll-badge` sets `pointer-events: none`, so
hit-testing returns the element behind the badge and reports a correct badge as missing.

## Disambiguation

| Looks like ours | Actually is | How to tell |
|---|---|---|
| green check in the now-playing bar | native "Save to Liked Songs" | native is a filled circle in the right-hand column; ours is a flat check immediately before the track title and matches `.ll-badge` |

Both can appear in one frame. Always run `verify` before capturing a feature shot.

## Fixtures

`screenshots/fixtures/albums-8.json` — 8 well-known public albums. Never seed from the
developer's own library: it leaks personal taste into a public README.

Records must mirror what `llMarkOne` writes, `{ listenedAt, source }`. Omitting `source`
renders a literal `undefined` in the Viewer's Source column and in the Stats breakdown.

`listening-list-meta` must be seeded alongside the data, or the Viewer shows blank
name/artist columns — `llFetchMetadata` fills that cache from the Web API, which is easy
to rate-limit (429) during a capture session.

## Capture session

Client geometry below assumes `viewport 1440 900`. Re-measure if that changes.

```
node shoot.mjs snapshot --prefix "listening-list" backup.json
node shoot.mjs restore screenshots/fixtures/albums-8.json
node shoot.mjs viewport 1440 900
node shoot.mjs reload                 # REQUIRED: llData is read once at boot
node shoot.mjs wait "window.Spicetify?.Platform?.History?.push!==undefined" 30
# stock theme: the Marketplace re-injects its CSS a moment after load
node shoot.mjs wait "document.querySelectorAll('style.marketplaceCSS').length>=2" 30
#   then disable both sheets via eval, and re-enable before finishing
node shoot.mjs navigate /album/1bt6q2SruMsBtcerNVtpZB     # Rumours, Fleetwood Mac
```

On Git Bash, prefix commands with `MSYS_NO_PATHCONV=1` or `/album/...` is rewritten into a
Windows path.

## Shot list

| Output | Surface | Rect / selector | README caption |
|---|---|---|---|
| `preview.png` | 4 badged track rows | `--rect 470,430,210,210 --scale 3` | (Marketplace card) |
| `tracklist-badges.png` | tracklist | `--rect 454,392,676,416 --scale 2` | badges beside each track |
| `album-header.png` | album header | `--rect 448,72,700,220 --scale 2` | badge under album title |
| `viewer.png` | Viewer tab | `--selector ".GenericModal" --scale 2` | marked albums list |
| `stats.png` | Stats tab | `--selector ".GenericModal" --scale 2` | totals and breakdown |
| `settings.png` | Settings tab | `--selector ".GenericModal" --scale 2` | surface toggles |

Modal: click `button[aria-label='<your Spotify name>']`, then
`click ".main-contextMenu-menuItemButton" --text "Listening List"`. Tabs via
`click ".ll-tab" --text "Stats"`. `llOpenModal` is IIFE-scoped and cannot be called by eval.

## Framing notes

- Full-viewport shots leak the sidebar playlists, Liked Songs panel, avatar, and the
  currently-playing track. Use tight rects only.
- Keep clips above y≈810: the now-playing bar composites over anything lower, even when the
  clip is inside the viewport.
- The Marketplace card centre-crops to 175×175. `preview.png` at 4 rows stays legible;
  7 rows does not.

## Known gaps

- Per-track badges are only demonstrable via the ambient-album path. On album pages the rows
  expose `/artist/` anchors only, so per-row `uri` is null. Caption accordingly: the album is
  marked, so its rows badge — not "each track marked individually".
- Now-playing badge is uncaptured; it needs active playback and would leak the current track.
- Track-side stats read 0 because the fixture seeds albums only.
