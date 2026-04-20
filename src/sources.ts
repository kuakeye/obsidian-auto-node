import type { App, TFile } from "obsidian";
import type { Source, SourceContext, SourceKind } from "./types";

/**
 * Sources
 * =======
 *
 * Each source decides whether a given file is "in scope" for a block. Adding a
 * new behavior (e.g. "files modified in the last 7 days") is a matter of
 * writing one object with {kind, matches, [scope]} and registering it.
 *
 * The engine calls `scope(ctx)` first if defined; if it returns a concrete
 * list, only those files are considered. Otherwise the engine iterates every
 * markdown file in the vault and calls `matches(file, content, ctx)`.
 */

// --- keyword (legacy behavior) --------------------------------------------

export const keywordSource: Source = {
  kind: "keyword",
  matches(file, content, ctx) {
    const { keyword = "", caseSensitive = false, matchWholeWord = false } = ctx.config;
    if (!keyword) return false;
    const needle = caseSensitive ? keyword : keyword.toLowerCase();
    const hay = caseSensitive ? content : content.toLowerCase();
    const title = caseSensitive ? file.basename : file.basename.toLowerCase();
    const path = caseSensitive ? file.path : file.path.toLowerCase();

    if (!matchWholeWord) {
      return hay.includes(needle) || title.includes(needle) || path.includes(needle);
    }
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = caseSensitive ? "g" : "gi";
    const regex = new RegExp(`\\b${escaped}\\b`, flags);
    return regex.test(content) || regex.test(file.basename) || regex.test(file.path);
  },
};

// --- filename-regex (daily notes, dated files, etc.) ----------------------

export const filenameRegexSource: Source = {
  kind: "filename-regex",
  matches(file, _content, ctx) {
    const pattern = ctx.config.pattern;
    if (!pattern) return false;
    const regex = safeRegex(pattern);
    return regex ? regex.test(file.basename) : false;
  },
};

// --- folder (all files under a path prefix) -------------------------------

export const folderSource: Source = {
  kind: "folder",
  scope(ctx: SourceContext): TFile[] | undefined {
    const folder = normalizeFolder(ctx.config.folder);
    if (folder === undefined) return undefined;
    const recursive = ctx.config.recursive !== false; // default true
    return ctx.app.vault.getMarkdownFiles().filter((f) => inFolder(f.path, folder, recursive));
  },
  matches(_file, _content, _ctx) {
    // All filtering done in scope(). If scope returns a list, matches is never called.
    return true;
  },
};

// --- tag (files tagged with #foo in frontmatter or body) ------------------

export const tagSource: Source = {
  kind: "tag",
  matches(file, _content, ctx) {
    const raw = ctx.config.tag;
    if (!raw) return false;
    const target = raw.startsWith("#") ? raw.slice(1) : raw;
    const cache = ctx.app.metadataCache.getFileCache(file);
    if (!cache) return false;

    // Inline tags from the metadata cache.
    if (cache.tags?.some((t) => stripHash(t.tag) === target)) return true;

    // Frontmatter tags (tags:, tag:, etc. — Obsidian normalizes these).
    const fm = cache.frontmatter;
    if (!fm) return false;
    const values = collectFrontmatterTags(fm);
    return values.some((v) => stripHash(v) === target);
  },
};

// --- frontmatter (field = value) -----------------------------------------

export const frontmatterSource: Source = {
  kind: "frontmatter",
  matches(file, _content, ctx) {
    const field = ctx.config.field;
    if (!field) return false;
    const cache = ctx.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm) return false;
    const present = fm[field];
    if (present === undefined || present === null) return false;
    // If no value specified, match on presence.
    if (ctx.config.value === undefined) return true;
    const needle = ctx.config.value;
    if (Array.isArray(present)) return present.some((v) => String(v) === needle);
    return String(present) === needle;
  },
};

// --- today (single-file source: today's daily note) ----------------------

export const todaySource: Source = {
  kind: "today",
  scope(ctx: SourceContext): TFile[] {
    // Default YYYY-MM-DD matches Obsidian's daily-note default format.
    const today = formatToday(ctx.config.pattern);
    const files = ctx.app.vault.getMarkdownFiles().filter((f) => f.basename === today);
    return files;
  },
  matches(_file, _content, _ctx) {
    return true;
  },
};

// --- helpers --------------------------------------------------------------

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function normalizeFolder(folder: string | undefined): string | undefined {
  if (folder === undefined) return undefined;
  return folder.replace(/^\/+|\/+$/g, "");
}

function inFolder(path: string, folder: string, recursive: boolean): boolean {
  if (!folder) return true; // empty folder = vault root
  if (!path.startsWith(folder + "/")) return false;
  if (recursive) return true;
  const rest = path.slice(folder.length + 1);
  return !rest.includes("/");
}

function stripHash(tag: string): string {
  return tag.startsWith("#") ? tag.slice(1) : tag;
}

function collectFrontmatterTags(fm: Record<string, unknown>): string[] {
  const keys = ["tag", "tags"];
  const out: string[] = [];
  for (const key of keys) {
    const v = fm[key];
    if (Array.isArray(v)) out.push(...v.map(String));
    else if (typeof v === "string") out.push(...v.split(/[\s,]+/).filter(Boolean));
  }
  return out;
}

/**
 * Format today's date. `pattern` is interpreted as a strftime-like template
 * limited to YYYY/MM/DD tokens, since that's what Obsidian's daily-notes
 * default uses. For anything more exotic, add a dedicated source later.
 */
function formatToday(pattern: string | undefined): string {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  if (!pattern) return `${yyyy}-${mm}-${dd}`;
  return pattern
    .replace(/YYYY/g, yyyy)
    .replace(/MM/g, mm)
    .replace(/DD/g, dd);
}

// --- any-of / all-of (composite) -----------------------------------------

function makeCompositeSource(kind: "any-of" | "all-of", registry: Map<SourceKind, Source>): Source {
  return {
    kind,
    matches(file, content, ctx) {
      const kinds = (ctx.config.sources ?? "")
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean) as SourceKind[];
      if (!kinds.length) return false;
      const check = (k: SourceKind) => {
        const source = registry.get(k);
        if (!source) return false;
        const result = source.matches(file, content, { ...ctx, config: { ...ctx.config, source: k } });
        // All built-in sources are synchronous; treat a Promise as non-match.
        return result instanceof Promise ? false : result;
      };
      return kind === "any-of" ? kinds.some(check) : kinds.every(check);
    },
  };
}

// --- registry -------------------------------------------------------------

export function buildSourceRegistry(): Map<SourceKind, Source> {
  const map = new Map<SourceKind, Source>();
  for (const s of [keywordSource, filenameRegexSource, folderSource, tagSource, frontmatterSource, todaySource]) {
    map.set(s.kind, s);
  }
  // Composite sources reference the base registry — safe because matches() is
  // only called after the registry is fully populated.
  map.set("any-of", makeCompositeSource("any-of", map));
  map.set("all-of", makeCompositeSource("all-of", map));
  return map;
}

/** Best-effort scope narrowing for perf: returns a set of files, or undefined
 * to indicate "iterate everything". The engine uses this to avoid O(vault) */
export async function resolveScope(
  source: Source,
  app: App,
  ctx: SourceContext,
): Promise<TFile[] | undefined> {
  if (!source.scope) return undefined;
  const maybe = await Promise.resolve(source.scope(ctx));
  return maybe ?? undefined;
}
