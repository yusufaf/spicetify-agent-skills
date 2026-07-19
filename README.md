# spicetify-agent-skills

Agent skills for developing [Spicetify](https://spicetify.app) extensions — for use with
Claude Code and other AI coding agents that support the
[Agent Skills](https://agentskills.io/specification) format.

Spicetify extensions only run inside the Spotify **desktop** client. There is no web player
equivalent, no dev server, and no headless target — so an agent working on one is normally
flying blind, limited to `node --check` and hoping. These skills give it a way to drive the
real client: read the console, run JS against `Spicetify.Platform`, inspect and seed
extension state, hot-reload after an edit, and capture publishable screenshots.

## Skills

### `spicetify-live-test`

Drives the running Spotify desktop client over the Chrome DevTools Protocol. Hot-reloads a
repo edit without `spicetify apply`, reads filtered console output, evaluates arbitrary JS
against Spicetify's APIs, and inspects extension `localStorage`.

Bundles `cdp.mjs` — no dependencies, Node 22+, works with or without an MCP server.

### `spicetify-screenshots`

Captures README and Marketplace images from the live client. Adds the primitives publishable
screenshots actually need and debugging screenshots don't: element-scoped clipping, true 2x
output, explicit square rects for Marketplace previews, real mouse dispatch, a readiness
predicate instead of blind sleeps, and a verified `localStorage` snapshot/restore cycle for
seeding demo state.

Bundles `shoot.mjs` and a Marketplace reference covering discovery, the manifest schema, and
the preview crop.

## Install

Clone into your agent's skills directory:

```bash
git clone https://github.com/yusufaf/spicetify-agent-skills
cp -r spicetify-agent-skills/skills/* ~/.claude/skills/
```

Then copy `extensions.example.json` to `extensions.json` and map your repos to the extension
filenames Spotify loads.

Setup beyond that — the `--remote-debugging-port` launch flag and the symlinks that make hot
reload work — is documented in the `spicetify-live-test` skill itself.

## Per-repo files

Both skills read a Markdown spec from the root of each extension repo, which is what turns
them from exploratory into mechanical. Templates in `templates/`:

- **`tests.live.md`** — storage keys, expected console patterns, numbered test scenarios
- **`screenshots.md`** — shot list, readiness predicate, fixtures, and a disambiguation table

The disambiguation table is worth calling out. Spotify's native "Save to Liked Songs" control
is a green checkmark, and it sits in exactly the places extensions like to put badges. During
development of these skills, a test agent came within one verification step of shipping a
screenshot of native Spotify UI as proof that an extension's feature worked. The skill now
treats screenshots as evidence and forbids fabricating them — including the tempting shortcut
of injecting badge markup to get a good-looking shot.

## Two things that cost me time, documented so they don't cost you any

**A `spicetify apply` silently breaks hot reload.** Apply overwrites the loaded xpui bundle
with a plain copy of your extension, replacing the symlink. Edits then appear to do nothing.
Re-create the symlinks after every apply.

**`deviceScaleFactor` alone does not produce 2x screenshots.** CDP's screenshot clip is
measured in CSS pixels, so overriding the device pixel ratio improves rasterisation but leaves
output dimensions unchanged. You need the viewport override *and* `--scale 2` to get real 2x
images. Without both you ship soft, low-resolution README shots and won't know why.

## Marketplace notes

`skills/spicetify-screenshots/marketplace-preview.md` documents how the Spicetify Marketplace
actually finds and renders extensions, verified against its source. The short version, since
it explains most "my extension isn't showing up" confusion:

- Discovery is a live GitHub API search for the topic **`spicetify-extensions`**. There is no
  marketplace-side index.
- The search box filters **only cards already loaded**, and matches `title`, `user`,
  `authors`, and `tags` — **not `description`**. An extension ranked past the first 100
  results is invisible to search until the user clicks "Load more" enough times.
- `manifest.json` must sit at the **root of the default branch**. A manifest missing `name`,
  `description`, or `main` is skipped silently, with no error.
- One repo can expose multiple extensions: a root `manifest.json` containing a JSON **array**
  yields one card per entry.
- The preview renders at **175×175, `object-fit: cover`**. Make it square and legible at that
  size, and make sure the file is actually committed — a missing preview renders a broken card.

## License

MIT
