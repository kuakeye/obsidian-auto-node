# Auto Node Plugin

Auto Node maintains plugin-owned regions inside your Obsidian notes. Each region ("block") is driven by two pluggable pieces:

- A **Source**: which notes count as "in scope"?
- A **Renderer**: how should those notes be laid out?

The plugin watches your vault and rewrites each block whenever its inputs change. Everything outside the block markers stays untouched.

That's the whole idea. Keyword MOCs, Daily Notes MOCs, a Launchpad "today" link, an inbox triage list — they're all the same pipeline with different sources and renderers.

## Quick start: a Daily Notes MOC

1. Open the command palette → **Create Daily Notes MOC**.
2. Accept the defaults (note name, and `^\d{4}-\d{2}-\d{2}$` as the filename regex).
3. Open the note. You'll see your daily notes grouped by month, newest first.

When you create a new daily note tomorrow, it's added automatically.

## Block markers

Every auto-populated region is delimited by a pair of HTML comments. The start marker carries the block's config as inline attributes:

```
<!-- auto-node:start id=daily source=filename-regex pattern="^\d{4}-\d{2}-\d{2}$" render=month-groups order=desc -->
...generated content — the plugin owns this...
<!-- auto-node:end id=daily -->
```

You can hand-author blocks, hand-edit their attrs, or let the commands generate them for you (**Insert auto-node block here**).

A single note can contain any number of blocks with different ids. That's how you build a Launchpad page: one block pulls "today's daily note", another pulls inbox items, another pulls recent project notes.

## Built-in sources

| source | matches files that… | key options |
|---|---|---|
| `keyword` | contain a keyword in their content, basename or path | `keyword`, `caseSensitive`, `matchWholeWord` |
| `filename-regex` | have a basename matching a regex | `pattern` |
| `folder` | live under a folder prefix | `folder`, `recursive` |
| `tag` | are tagged with a given tag (inline or frontmatter) | `tag` |
| `frontmatter` | have a frontmatter field (optionally with a value) | `field`, `value` |
| `today` | are today's daily note (basename = today in YYYY-MM-DD) | `pattern` (optional format override) |

## Built-in renderers

| render | output |
|---|---|
| `bullet-list` | flat list of links; the default |
| `month-groups` | `## YYYY-MM` headings with links underneath; designed for dated notes |
| `single-link` | a single inline link; for "today" blocks |

Shared options on every block: `limit` (cap links), `order` (`asc`/`desc`), `sortBy` (`basename`, `path`, `mtime`, `ctime`), `emptyText` (override "No matching notes yet.").

## Recipes

### Daily Notes MOC (grouped by month, newest first)

```
<!-- auto-node:start id=daily source=filename-regex pattern="^\d{4}-\d{2}-\d{2}$" render=month-groups order=desc -->
<!-- auto-node:end id=daily -->
```

### Home / Launchpad — today's daily note

```
## Today
<!-- auto-node:start id=today source=today render=single-link -->
<!-- auto-node:end id=today -->
```

### Home — inbox to triage

```
## +inbox
<!-- auto-node:start id=inbox source=folder folder="+inbox" render=bullet-list order=desc sortBy=mtime -->
<!-- auto-node:end id=inbox -->
```

### Active projects (by tag)

```
<!-- auto-node:start id=active-projects source=tag tag="project/active" render=bullet-list -->
<!-- auto-node:end id=active-projects -->
```

### Anything with `status: draft` in frontmatter

```
<!-- auto-node:start id=drafts source=frontmatter field=status value=draft render=bullet-list -->
<!-- auto-node:end id=drafts -->
```

## Commands

- **Create auto-node page (keyword)** — classic keyword MOC, same as v0.1.
- **Create Daily Notes MOC** — one-shot wizard for a dated-notes MOC.
- **Insert auto-node block here** — picks a source + renderer, inserts a block at the cursor.
- **Refresh all auto-nodes now** — forces an immediate rescan.

## Architecture (for extending the plugin)

Three plug points, each a tiny interface:

```ts
// Types live in src/types.ts
interface Source {
  kind: SourceKind;                     // string discriminator
  scope?(ctx): TFile[] | undefined;     // fast-path candidate set
  matches(file, content, ctx): boolean; // per-file decision
}

interface Renderer {
  kind: RendererKind;
  render(ctx): string;                  // markdown output
}
```

Adding a new capability is one file + one line in a registry:

1. Write a `Source` or `Renderer` object and export it from `src/sources.ts` / `src/renderers.ts`.
2. Add its kind to the union in `src/types.ts`.
3. Add it to `buildSourceRegistry` / `buildRendererRegistry`.
4. If users should see it in the **Insert auto-node block here** picker, add a `Choice` entry in `main.ts`.

That's it — the engine, marker parser, debounced refresh, and legacy compat all keep working without touching them.

Good candidates to add next:

- `recent` source: files modified in the last N days.
- `backlinks-to-host` source: notes that link to this MOC (makes it a "reverse table of contents").
- `table` renderer: columns for date, frontmatter fields, size, etc.
- `callout` renderer: wrap output in an Obsidian callout for visual emphasis.

## Legacy compatibility

Blocks authored before v0.2 (unattributed `<!-- auto-node:start -->` + `autoNodeKeyword` in frontmatter) continue to work. The engine detects the legacy form and fills in `{ source: "keyword", render: "bullet-list" }` automatically. The settings tab still manages those files for rename/edit/delete.

## Build and install

From the repo root:

```bash
npm install
npm run build
```

That produces `build/` with `main.js`, `manifest.json`, `versions.json`, `styles.css`.

Symlink `build/` into your vault as `.obsidian/plugins/auto-node/`:

```bash
ln -s "/abs/path/to/obsidian-auto-node/build" "/path/to/YourVault/.obsidian/plugins/auto-node"
```

In Obsidian: **Settings → Community plugins → Auto Node → enable**. Reload after each `npm run build` (or run `npm run dev` for watch mode).

## Development

- `npm run dev` — watch build.
- `npm run build` — production build.
- `npm run check` — TypeScript typecheck (no emit).

The source tree after v0.2:

```
src/
  main.ts         # Plugin entry, event wiring, commands, settings tab
  types.ts        # BlockConfig, Source, Renderer, registries
  markers.ts      # Parse/write inline-attr markers
  sources.ts      # Keyword, filename-regex, folder, tag, frontmatter, today
  renderers.ts    # Bullet-list, month-groups, single-link
  engine.ts       # Scan + block-level refresh
  modals.ts       # PromptModal, ConfirmModal, ChoiceModal
  graph-filter.ts # Graph view "Hide auto-nodes" toggle
  styles.css
```

Desktop only (`"isDesktopOnly": true`).
