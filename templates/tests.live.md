# Live Tests — <Extension Name>

Copy this file to the root of your extension repo. The `spicetify-live-test` skill reads it
before testing, so keep the selectors and log patterns accurate.

Extension file: `my-extension.js`
Use skill `spicetify-live-test` for CDP mechanics (reload, eval, screenshot, console).

## Storage keys

| Key | Contents |
|-----|----------|
| `my-extension-config` | JSON config object |
| `my-extension-data` | JSON map of id → record |

## Smoke test (run after every edit)

1. `node --check my-extension.js` — syntax gate.
2. CDP reload xpui.
3. Console (filter `My Extension`): expect `[My Extension] Booted.`
4. Navigate to the relevant surface; screenshot.

```js
// Read-only state check
Spicetify.LocalStorage.get('my-extension-config')   // → JSON string or null
```

## T1: <core feature renders>

- Navigate to <surface>.
- Assert: `document.querySelectorAll('.my-ext-badge').length > 0`
- Screenshot to confirm placement and alignment.

## T2: <state persists>

- Eval before: count records in `my-extension-data` → N.
- Perform the action that should record one.
- Eval after → N+1.

## T3: defaults survive a missing config key

- `Spicetify.LocalStorage.remove('my-extension-config')`, then reload.
- Assert: boot log present, no errors, config written back with defaults.

## T4: cleared data does not break the extension

- Set the data key to `'{}'`.
- Navigate to the surface; assert no `Failed` errors and the UI still renders.

## T5: hot-reload sanity

- Add `console.log('[My Extension] HOT-RELOAD-MARKER')`.
- CDP reload, filter `HOT-RELOAD-MARKER` — must appear. Revert.

If the marker does not appear, the symlinks were overwritten by a `spicetify apply`.
