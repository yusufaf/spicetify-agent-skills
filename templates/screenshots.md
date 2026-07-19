# Screenshots — <Extension Name>

Copy this file to the root of your extension repo. The `spicetify-screenshots` skill reads it
so capture is a checklist instead of an exploration.

Extension file: `my-extension.js`
Storage keys: `my-extension-data`, `my-extension-config`

## Readiness predicate

The JS expression that proves the extension has finished rendering. Waited on instead of
sleeping, since injection is MutationObserver-driven and racy.

```js
document.querySelectorAll('.my-ext-badge').length >= 3
```

## Verification

The `verify` invocation that proves those elements are the extension's own output, not native
Spotify UI that happens to look similar. This is the check that stops a fabricated screenshot
shipping — fill it in per surface.

```
node shoot.mjs verify ".my-ext-badge" --min 3 --within ".main-trackList-trackListRow" --svg-path "M13.485"
```

Pin `--svg-path` to the icon path constant in your source, so a native lookalike cannot pass.
Do **not** hand-roll this with `elementFromPoint`: badges usually set `pointer-events: none`,
so hit-testing returns the element behind them and fails on perfectly good badges.

## Disambiguation

Native Spotify UI that could be mistaken for this extension's output.

| Looks like ours | Actually is | How to tell |
|---|---|---|
| green checkmark in track row / now-playing bar | native "Save to Liked Songs" | ours is flat and precedes the title; native is a filled circle in the right-hand column. Ours matches `.my-ext-badge` with our `--svg-path`. |

## Fixtures

Datasets live in `screenshots/fixtures/`. Use well-known public albums so shots are
reproducible and leak no personal taste data.

| File | Represents |
|---|---|
| `fixture-populated.json` | ~12 listened albums, mixed genres, for badge and stats shots |
| `fixture-empty.json` | cleared state, only if an empty-state shot is genuinely wanted |

## Shot list

| Output file | Surface | Selector / rect | Required state | README caption |
|---|---|---|---|---|
| `preview.png` | badge on a track row | `--rect` square centred on badge | `fixture-populated` | (Marketplace card — square, ≥512, legible at 175px) |
| `badges.png` | track list with badges | `.main-trackList-trackList` | `fixture-populated` | "Listened tracks marked inline" |
| `settings.png` | settings modal | `.my-ext-settings` | defaults | "Configurable badge style" |
| `stats.png` | stats tab | `.my-ext-stats` | `fixture-populated` | "Listening totals at a glance" |

## Navigation

Exact steps to reach each surface, so runs are reproducible.

1. `Spicetify.Platform.History.push('/album/<public-album-id>')`
2. `node shoot.mjs wait "<readiness predicate>" 15`
3. capture

## Known limitations

- Anything that cannot currently be captured, and why.
