import type { Block, BlockConfig, RendererKind, SortOrder, SourceKind } from "./types";

/**
 * Markers
 * =======
 *
 * Each auto-populated region in a note is delimited by a pair of HTML comments.
 *
 * Legacy form (v0.1.x, still supported for backwards compat):
 *   <!-- auto-node:start -->
 *   ...generated...
 *   <!-- auto-node:end -->
 *
 * New form (v0.2+):
 *   <!-- auto-node:start id=daily source=filename-regex
 *        pattern="^\d{4}-\d{2}-\d{2}$" render=month-groups order=desc -->
 *   ...generated...
 *   <!-- auto-node:end id=daily -->
 *
 * Attribute rules:
 *   - key=value tokens separated by whitespace.
 *   - Values may be bare (no spaces) or double-quoted (supports spaces).
 *   - Double quotes inside a quoted value are escaped as \".
 *   - Unknown keys are preserved on rewrite but ignored.
 *   - Booleans: "true"/"false" (case-insensitive).
 *
 * Start and end markers pair in the order they appear; if the end carries an
 * id and the most recent start has a different id, we treat the end as
 * unmatched and skip the block (defensive — prevents data loss when someone
 * hand-edits markers).
 */

export const START_TAG = "auto-node:start";
export const END_TAG = "auto-node:end";

/** Regex that captures one marker (start or end) along with its attr string. */
const MARKER_REGEX = /<!--\s*(auto-node:start|auto-node:end)(\s+[^>]*?)?\s*-->/g;

/** Parse a marker's attr string into a string-keyed map. */
export function parseAttrs(raw: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!raw) return attrs;

  // Tokenize: matches key=value (where value is quoted or bare).
  const tokenRegex = /([\w-]+)\s*=\s*(?:"((?:\\"|[^"])*)"|([^\s"]+))/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(raw)) !== null) {
    const key = m[1];
    const quoted = m[2];
    const bare = m[3];
    attrs[key] = quoted !== undefined ? quoted.replace(/\\"/g, '"') : bare;
  }
  return attrs;
}

/** Serialize attrs back to the compact form used in start markers. */
export function serializeAttrs(attrs: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === "") continue;
    const str = String(value);
    const needsQuotes = /[\s"]/.test(str);
    const escaped = str.replace(/"/g, '\\"');
    parts.push(needsQuotes ? `${key}="${escaped}"` : `${key}=${str}`);
  }
  return parts.join(" ");
}

export interface RawMarker {
  kind: "start" | "end";
  /** Byte offset of the first character of the marker. */
  offset: number;
  /** Length of the matched marker string. */
  length: number;
  /** The exact string that appeared in the source. */
  text: string;
  /** Parsed attrs (empty for legacy markers with no attrs). */
  attrs: Record<string, string>;
}

/** Find every start/end marker in a file. Ordered by offset. */
export function findMarkers(content: string): RawMarker[] {
  const markers: RawMarker[] = [];
  MARKER_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_REGEX.exec(content)) !== null) {
    const tag = m[1];
    const attrsRaw = m[2];
    markers.push({
      kind: tag === START_TAG ? "start" : "end",
      offset: m.index,
      length: m[0].length,
      text: m[0],
      attrs: parseAttrs(attrsRaw),
    });
  }
  return markers;
}

/**
 * Pair start/end markers into blocks. Well-formed files produce a list of
 * matched pairs; malformed regions (orphan start/end, or id-mismatched pairs)
 * are dropped without touching the file.
 *
 * Legacy (no-attr) blocks get `legacy: true` so the engine can either
 * gracefully resolve config from frontmatter or emit a one-time upgrade hint.
 */
export function parseBlocks(content: string): Block[] {
  const markers = findMarkers(content);
  const blocks: Block[] = [];

  for (let i = 0; i < markers.length; i++) {
    const start = markers[i];
    if (start.kind !== "start") continue;
    const next = markers[i + 1];
    if (!next || next.kind !== "end") continue;

    // If either carries an id, they must match.
    const startId = start.attrs.id;
    const endId = next.attrs.id;
    if (startId && endId && startId !== endId) continue;

    const config = attrsToConfig(start.attrs);
    const legacy = Object.keys(start.attrs).length === 0;

    blocks.push({
      config,
      startOffset: start.offset,
      endOffset: next.offset + next.length,
      startMarker: start.text,
      endMarker: next.text,
      legacy,
    });
    // Skip past the end marker we just consumed.
    i += 1;
  }

  return blocks;
}

/** Convert raw marker attrs into a BlockConfig, applying reasonable defaults. */
export function attrsToConfig(attrs: Record<string, string>): BlockConfig {
  const config: BlockConfig = {
    id: attrs.id ?? "default",
    source: (attrs.source as SourceKind) ?? "keyword",
    render: (attrs.render as RendererKind) ?? "bullet-list",
  };

  // Source-specific string options.
  if (attrs.keyword !== undefined) config.keyword = attrs.keyword;
  if (attrs.pattern !== undefined) config.pattern = attrs.pattern;
  if (attrs.folder !== undefined) config.folder = attrs.folder;
  if (attrs.tag !== undefined) config.tag = attrs.tag;
  if (attrs.sources !== undefined) config.sources = attrs.sources;
  if (attrs.field !== undefined) config.field = attrs.field;
  if (attrs.value !== undefined) config.value = attrs.value;
  if (attrs.emptyText !== undefined) config.emptyText = attrs.emptyText;

  // Boolean options.
  if (attrs.caseSensitive !== undefined) config.caseSensitive = parseBool(attrs.caseSensitive);
  if (attrs.matchWholeWord !== undefined) config.matchWholeWord = parseBool(attrs.matchWholeWord);
  if (attrs.recursive !== undefined) config.recursive = parseBool(attrs.recursive);

  // Numeric / enum options.
  if (attrs.limit !== undefined) {
    const n = Number(attrs.limit);
    if (!Number.isNaN(n)) config.limit = n;
  }
  if (attrs.order === "asc" || attrs.order === "desc") config.order = attrs.order as SortOrder;
  if (attrs.sortBy) config.sortBy = attrs.sortBy as BlockConfig["sortBy"];

  return config;
}

/** Compose a start marker string from a BlockConfig. */
export function configToStartMarker(config: BlockConfig): string {
  const attrs: Record<string, string | number | boolean | undefined> = {
    id: config.id,
    source: config.source,
    render: config.render,
    keyword: config.keyword,
    caseSensitive: config.caseSensitive,
    matchWholeWord: config.matchWholeWord,
    pattern: config.pattern,
    folder: config.folder,
    recursive: config.recursive,
    tag: config.tag,
    sources: config.sources,
    field: config.field,
    value: config.value,
    limit: config.limit,
    order: config.order,
    sortBy: config.sortBy,
    emptyText: config.emptyText,
  };
  return `<!-- ${START_TAG} ${serializeAttrs(attrs)} -->`;
}

export function configToEndMarker(config: BlockConfig): string {
  return `<!-- ${END_TAG} id=${config.id} -->`;
}

function parseBool(value: string): boolean {
  return /^(true|yes|1|on)$/i.test(value.trim());
}

/**
 * Replace the generated content inside a specific block. Leaves the start/end
 * markers (and everything outside them) untouched. Returns the new file
 * content string.
 */
export function replaceBlockBody(content: string, block: Block, generated: string): string {
  const before = content.slice(0, block.startOffset + block.startMarker.length);
  const after = content.slice(block.endOffset - block.endMarker.length);
  // Normalize padding around the generated section so rewriting stays stable
  // across refreshes (no unbounded blank-line growth).
  const body = generated.trim().length ? generated.trim() : "";
  return `${before}\n\n${body}\n\n${after}`;
}
