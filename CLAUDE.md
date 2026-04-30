# CLAUDE.md

## Project Overview

Obsidian Auto Node — an Obsidian plugin that automatically maintains MOC (Map of Contents) pages by gathering links to notes mentioning a specified keyword. Desktop-only, MIT licensed.

## Tech Stack

- TypeScript (strict mode), targeting ES2017
- esbuild for bundling (CommonJS output)
- Obsidian Plugin API (`obsidian` is an external dependency, not bundled)

## Commands

- `npm run build` — production build to `build/`
- `npm run dev` — watch mode for development
- `npm run check` — TypeScript type-checking (no emit)
- No tests currently (`npm run test` is a no-op)

## Project Structure

```
src/main.ts      — entire plugin implementation (~1190 lines)
src/styles.css   — plugin UI styles
esbuild.config.mjs — build configuration
manifest.json    — Obsidian plugin metadata
```

The build outputs `main.js`, `manifest.json`, `versions.json`, and `styles.css` into `build/`.

## Architecture

Single-file plugin (`src/main.ts`) exporting `AutoNodePlugin extends Plugin`.

Key components:
- **AutoNodePlugin** — main class; registers commands, event listeners, settings
- **PromptModal** — collects user input for auto-node creation
- **GraphFilterControl** — toggle to hide auto-nodes in graph view
- **AutoNodeSettingTab / AutoNodeSettingsModal** — settings UI

Auto-node notes use YAML frontmatter (`autoNode: true`, `autoNodeKeyword`, etc.) and generated content between `<!-- auto-node:start -->` / `<!-- auto-node:end -->` markers.

## Coding Conventions

- All plugin code lives in `src/main.ts` — no separate module files
- CSS classes use `auto-node-*` prefix
- Async/await with try-catch and `Notice` for user-facing errors
- Debounced refresh (500ms) to batch vault change events
- Concurrent update prevention via `isUpdating` Set
- Use Obsidian API (`generateMarkdownLink`, `createEl`, vault/workspace/metadataCache)
