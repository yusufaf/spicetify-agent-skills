# Theme Matrix — <Extension Name>

Copy this file to the root of your extension repo. The `spicetify-theme-matrix` skill reads
the `json theme-matrix` block below. Everything outside the block is notes for humans.

Add `.theme-matrix/` to the repo's `.gitignore`: each run writes its report and
screenshots there.

Readiness predicates default to the one in `screenshots.md` (`## Readiness predicate`).
Set `ready` on a surface only when it needs something different.

```json theme-matrix
{
  "name": "My Extension",
  "extensionFile": "my-extension.js",
  "consoleFilter": "[My Extension]",

  "surfaces": {
    "album": {
      "path": "/album/<public-album-id>",
      "shot": ".main-trackList-trackList"
    },
    "settings": {
      "path": "/album/<public-album-id>",
      "click": [{ "selector": ".my-ext-settings-button" }],
      "ready": "document.querySelector('.my-ext-settings') !== null",
      "shot": ".my-ext-settings",
      "timeout": 10
    }
  },

  "elements": [
    { "selector": ".my-ext-badge", "kind": "icon", "surface": "album", "min": 3,
      "within": ".main-trackList-trackListRow", "svgPath": "M13.485" },
    { "selector": ".my-ext-settings label", "kind": "text", "surface": "settings" }
  ],

  "skip": {
    "wmpotify": "replaces the track list with a Windows Media Player skin; not supported"
  },

  "add": []
}
```

## Fields

| Field | Meaning |
|---|---|
| `extensionFile` | Console errors whose stack runs through this file count against the extension |
| `consoleFilter` | Errors containing this text also count (for errors logged without a useful stack) |
| `surfaces.<k>.path` | `Spicetify.Platform.History.push` target. **Public** albums and playlists only: every cell is screenshotted |
| `surfaces.<k>.click` | Real mouse clicks before waiting, e.g. to open a modal. `{selector, text?, index?}` |
| `surfaces.<k>.shot` | **Required.** Selector to clip the screenshot to (`pad`, default 8px). There is no full-viewport fallback, because that would capture your library sidebar |
| `elements[].kind` | `text`: contrast ≥ 4.5 (3 for large text). `icon`: SVG fill/stroke, contrast ≥ 3 |
| `elements[].min` | Required match count (default 1). Fewer means the theme broke the anchor |
| `elements[].sample` | How many matches to probe (default 3) |
| `elements[].within` / `svgPath` / `text` | Passed to `shoot.mjs verify`, so a theme's lookalike can't pass as yours |
| `skip` | Theme id → reason. The reason appears in `matrix.md` |
| `add` | Extra theme entries for this extension only. Generate one with `node matrix.mjs add <owner/repo> "<name>" --print` |

## Known theme incompatibilities

Anything you have decided not to fix, and why. Mirror it in `skip`.
