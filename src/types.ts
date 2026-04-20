import type { App, TFile } from "obsidian";

/**
 * Core model
 * =========
 *
 * An "auto-node" file contains one or more **blocks**. A block is a region of a
 * markdown file delimited by matching start/end HTML-comment markers. The
 * plugin fully owns the content between those markers and rewrites it on every
 * refresh. Everything outside the markers is untouched.
 *
 * A block's config describes three things:
 *   1. Which files are "in scope" for the block  → a Source strategy.
 *   2. How the in-scope files become markdown    → a Renderer strategy.
 *   3. Options that tweak (1) and (2).
 *
 * The existing keyword-in-content behavior is represented as a single unnamed
 * block whose source is "keyword" and renderer is "bullet-list". Files authored
 * before this version still work through the legacy-compat path that reads
 * frontmatter into an implicit BlockConfig.
 */

/** Discriminator for source kinds. Add one string per new source strategy. */
export type SourceKind =
  | "keyword"
  | "filename-regex"
  | "folder"
  | "tag"
  | "frontmatter"
  | "today"
  | "any-of"
  | "all-of";

/** Discriminator for renderer kinds. Add one string per new renderer. */
export type RendererKind = "bullet-list" | "month-groups" | "single-link";

export type SortOrder = "asc" | "desc";

/**
 * A block config is what lives inline on a start marker (as key=value attrs).
 * Everything except `id` has a sensible default so markers stay short.
 *
 *   <!-- auto-node:start id=daily source=filename-regex
 *        pattern="^\d{4}-\d{2}-\d{2}$" render=month-groups order=desc -->
 */
export interface BlockConfig {
  /** Unique within the host file. Defaults to "default" for legacy blocks. */
  id: string;
  source: SourceKind;
  render: RendererKind;

  // --- Source options (only some are read per source kind). ---
  /** keyword source */
  keyword?: string;
  /** keyword source */
  caseSensitive?: boolean;
  /** keyword source */
  matchWholeWord?: boolean;
  /** filename-regex + today sources */
  pattern?: string;
  /** folder source — path prefix (e.g. "Daily Notes") */
  folder?: string;
  /** folder source — include files in nested folders */
  recursive?: boolean;
  /** tag source — tag name, with or without leading '#' */
  tag?: string;
  /** any-of / all-of — pipe-separated list of source kinds, e.g. "filename-regex|tag" */
  sources?: string;
  /** frontmatter source — the frontmatter field name */
  field?: string;
  /** frontmatter source — the field value to match (string compare) */
  value?: string;

  // --- Rendering options. ---
  /** Maximum number of links to render. 0 = unlimited. Default: 0. */
  limit?: number;
  /** Sort direction applied before rendering. Default: "asc". */
  order?: SortOrder;
  /** What to sort by. Default depends on renderer. */
  sortBy?: "path" | "basename" | "mtime" | "ctime";
  /** Custom text when the source returns no files. */
  emptyText?: string;
}

/** A parsed block as it appears in a concrete file. */
export interface Block {
  /** Config derived from the start-marker attrs or legacy frontmatter. */
  config: BlockConfig;
  /** Byte offset of the start of the start marker. */
  startOffset: number;
  /** Byte offset of the end of the end marker (exclusive). */
  endOffset: number;
  /** Exact string that appears as the start marker (preserved on rewrite). */
  startMarker: string;
  /** Exact string that appears as the end marker (preserved on rewrite). */
  endMarker: string;
  /**
   * True if this block was inferred from legacy markers + frontmatter rather
   * than the inline-attr form. Used for a gentle, one-time upgrade hint.
   */
  legacy: boolean;
}

/** Inputs every source receives when deciding if a file is in scope. */
export interface SourceContext {
  app: App;
  host: TFile;
  config: BlockConfig;
}

/** A Source selects files that belong to a block. */
export interface Source {
  kind: SourceKind;
  /**
   * Optional fast-path: return the full set of candidate files (e.g. "files in
   * Daily Notes/") so the engine can skip a vault-wide scan. Return undefined
   * to let the engine iterate all markdown files.
   */
  scope?(ctx: SourceContext): Promise<TFile[]> | TFile[] | undefined;
  /** Called once per candidate file with its cached content. */
  matches(file: TFile, content: string, ctx: SourceContext): boolean | Promise<boolean>;
}

/** Inputs every renderer receives after a block's source has selected files. */
export interface RenderContext {
  app: App;
  host: TFile;
  config: BlockConfig;
  files: TFile[];
}

/** A Renderer formats selected files into markdown. */
export interface Renderer {
  kind: RendererKind;
  render(ctx: RenderContext): string;
}

/** Registries keep strategy lookup and "add a new kind" localized. */
export interface Registries {
  sources: Map<SourceKind, Source>;
  renderers: Map<RendererKind, Renderer>;
}

/** Persisted settings shape (v2). */
export interface AutoNodeSettings {
  /**
   * Legacy records keyed by file path. Retained so old installs keep working.
   * New blocks do not live here; they're described inline on their markers.
   */
  nodes: Record<string, LegacyAutoNodeRecord>;
  graphFilterEnabled: boolean;
  /** Schema version, bumped when settings migrate. */
  version?: number;
}

export interface LegacyAutoNodeRecord {
  path: string;
  keyword: string;
  caseSensitive: boolean;
  matchWholeWord: boolean;
}
