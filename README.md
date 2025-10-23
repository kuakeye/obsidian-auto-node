# Auto Node Plugin

This plugin creates and maintains "auto-node" notes (commonly MOCs) that automatically gather links to notes mentioning a specified keyword. Set up a note once, and the plugin keeps the list up to date as your vault changes.

## Features

- **Guided creation**: Command palette action prompts for note name and keyword.
- **Flexible matching**: Choose case sensitivity and whole-word matching.
- **Auto-populated section**: Maintains a block between `<!-- auto-node:start -->` and `<!-- auto-node:end -->` with links to matching notes.
- **Passive maintenance**: Updates when notes are created, modified, or deleted.

## Usage

1. Install the plugin in your vault's `.obsidian/plugins/auto-node` folder.
2. Run `npm install` and `npm run build` to produce the `build/` directory.
3. Copy the contents of `build/` into the plugin folder (keeping `main.js`, `manifest.json`, `versions.json`).
4. Enable **Auto Node** in Obsidian settings.
5. Trigger **Create auto-node page** via the command palette.
6. Enter the note name/path, keyword, and matching options when prompted.

The new note will contain frontmatter such as:

```
---
autoNode: true
autoNodeKeyword: neurostimulation
autoNodeCaseSensitive: false
autoNodeMatchWholeWord: false
---

<!-- Auto-node keyword: neurostimulation -->
<!-- auto-node:start -->
_Collecting links..._
<!-- auto-node:end -->
```

The plugin replaces the content between the markers with a bullet list of wiki-links to notes mentioning the keyword. Edits outside the markers remain untouched.

## Development

- `npm run dev`: build in watch mode
- `npm run build`: create production bundle in `build/`
- `npm run check`: type-check with TypeScript

## Notes

- Ensure your Obsidian vault has third-party plugins enabled.
- Updates rely on Obsidian's metadata cache; newly created notes may take a moment to appear.
- Matching is performed on raw markdown content.

