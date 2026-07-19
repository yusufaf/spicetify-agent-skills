# Spicetify Marketplace: discovery, manifest, and preview reference

Verified against `spicetify/marketplace@main`. Load this when a card renders wrong, an
extension is missing from the Marketplace, or you are writing a `manifest.json`.

## Discovery

`src/logic/FetchRemotes.ts` → `getTaggedRepos()` calls the GitHub search API directly:

```
https://api.github.com/search/repositories?q=topic%3Aspicetify-extensions&per_page=100&page={n}
```

- Topic must be exactly **`spicetify-extensions`**. The valid `RepoTopic` union is
  `"spicetify-extensions" | "spicetify-themes" | "spicetify-apps"`.
- Unauthenticated, no sort params — results come back in GitHub **best-match relevance**
  order. The source comments sorting as "not implemented for Marketplace yet".
- `ITEMS_PER_REQUEST = 100`, so each "Load more" pulls one page of 100 repos.
- Post-filters: `resources/blacklist.json`, and archived repos unless `showArchived`.

**There is no marketplace-side index.** Every load is a live GitHub API call, so a newly
tagged repo appears as soon as GitHub's search index picks it up (minutes to hours).

## The search box does not do what users expect

`src/components/Grid.tsx` filters **client-side, over already-loaded cards only**, matching a
lowercased substring against `title`, `user`, `authors[].name`, and `tags[]`.

Two consequences that explain most "my extension isn't in the Marketplace" reports:

1. **`description` is not searched**, despite being the visible card subtitle.
2. Searching before clicking "Load more" enough times returns nothing, because the card was
   never fetched. A repo ranked #59 needs three pages loaded before it is searchable.

So: an extension can be correctly tagged, correctly manifested, and fully indexed, yet appear
absent. Check rank before debugging the repo. `tags[]` is the main lever an author controls,
since tags are searched and titles rarely match what users type.

## Manifest

Fetched from `https://raw.githubusercontent.com/{user}/{repo}/{defaultBranch}/manifest.json`.
**Root of the default branch only** — subfolder manifests are never fetched.

Required for a card to render at all (`manifest?.name && manifest.description && manifest.main`):

| Field | Notes |
|---|---|
| `name` | Card title. Searched. |
| `description` | Card subtitle. **Not** searched. |
| `main` | Path to the extension `.js` |

Optional: `authors[{name,url}]`, `preview`, `readme`, `tags[]`, `branch`.

A manifest missing any required field is **silently skipped** — the `console.error("Invalid
manifest:")` branch is commented out, so there is no diagnostic. If a card never appears and
the topic is right, check these three fields first.

## Monorepos are supported

`getRepoManifest()` does `if (!Array.isArray(manifest)) manifest = [manifest]` and then
reduces over the entries. So **one root `manifest.json` holding a JSON array yields one card
per entry**, and each entry's `main` / `preview` / `readme` may be subfolder-relative. A
per-entry `branch` key overrides the repo default.

Trade-off worth stating: separate repos each get their own star count and their own shot at
the relevance ranking; a monorepo gets one of each for all extensions.

## Path resolution

For `main`, `preview`, and `readme`:

```
value.startsWith("http") ? value : `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${value}`
```

where `branch = manifest.branch || repoDefaultBranch`. So a relative `preview` **must exist on
the default branch** — a local file that was never committed renders a broken card.

Verify before shipping:

```
curl -sI https://raw.githubusercontent.com/{user}/{repo}/{branch}/{preview} | head -1
```

## Preview rendering

The card image container is **175×175 CSS px, `object-fit: cover`, `object-position: 50% 50%`** —
a hard centre crop. Published previews in the wild are frequently far from square (1742×917,
1742×468, even 1742×206), meaning most are severely cropped on the card without their authors
realising.

Practical spec:

- **Square**, so nothing is cropped away.
- **≥512×512** to stay sharp on hi-dpi displays.
- **Legible at 175px.** One bold visual. Body text at ~30px source becomes ~4px on the card.
- Verify by downscaling to 175×175 and looking at it before committing.

## No minimum bar

There is no star, license, README, or repo-age gate on visibility. Stars only affect display
and the (unimplemented) sort. The only exclusions are the blacklist and archived status.
