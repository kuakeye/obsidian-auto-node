import type { TFile } from "obsidian";
import type { RenderContext, Renderer, RendererKind } from "./types";

/**
 * Renderers
 * =========
 *
 * Each renderer turns an ordered list of TFiles into markdown. They receive
 * the full RenderContext so they can call `app.fileManager.generateMarkdownLink`
 * to produce links that honor the user's wikilink / markdown-link preference.
 */

// --- bullet-list ----------------------------------------------------------

export const bulletListRenderer: Renderer = {
  kind: "bullet-list",
  render(ctx: RenderContext): string {
    const { files, host, config } = ctx;
    if (!files.length) return config.emptyText ?? "_No matching notes yet._";
    return sorted(files, config.sortBy ?? "basename", config.order ?? "asc")
      .map((f) => `- ${ctx.app.fileManager.generateMarkdownLink(f, host.path)}`)
      .join("\n");
  },
};

// --- month-groups ---------------------------------------------------------

/**
 * Groups files by YYYY-MM, derived from the leading date in the basename. If a
 * file's basename doesn't start with a YYYY-MM-DD prefix it's placed under an
 * "Undated" bucket. Designed for a Daily Notes MOC.
 *
 * Output example (order=desc):
 *   ## 2026-04
 *   - [[2026-04-19]]
 *   - [[2026-04-18]]
 *
 *   ## 2026-03
 *   ...
 */
export const monthGroupsRenderer: Renderer = {
  kind: "month-groups",
  render(ctx: RenderContext): string {
    const { files, host, config } = ctx;
    if (!files.length) return config.emptyText ?? "_No dated notes yet._";

    const order = config.order ?? "desc";
    const buckets = new Map<string, TFile[]>();

    for (const file of files) {
      const month = extractMonth(file.basename);
      const key = month ?? "Undated";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(file);
    }

    const monthKeys = Array.from(buckets.keys())
      .filter((k) => k !== "Undated")
      .sort();
    if (order === "desc") monthKeys.reverse();
    const hasDatedBuckets = monthKeys.length > 0;
    if (hasDatedBuckets && buckets.has("Undated")) monthKeys.push("Undated");

    const blocks: string[] = [];
    for (const key of monthKeys) {
      const filesInBucket = buckets.get(key)!;
      filesInBucket.sort((a, b) => a.basename.localeCompare(b.basename));
      if (order === "desc") filesInBucket.reverse();

      const items = filesInBucket
        .map((f) => `- ${ctx.app.fileManager.generateMarkdownLink(f, host.path)}`)
        .join("\n");
      blocks.push(`## ${key}\n${items}`);
    }

    // No dated buckets — render as flat list without any heading
    if (!hasDatedBuckets && buckets.has("Undated")) {
      const undated = buckets.get("Undated")!;
      undated.sort((a, b) => a.basename.localeCompare(b.basename));
      if (order === "desc") undated.reverse();
      return undated
        .map((f) => `- ${ctx.app.fileManager.generateMarkdownLink(f, host.path)}`)
        .join("\n");
    }

    return blocks.join("\n\n");
  },
};

// --- single-link ----------------------------------------------------------

/**
 * Renders at most one file as a single inline link. Used by the `today`
 * source for a launchpad's "Today's note" field.
 */
export const singleLinkRenderer: Renderer = {
  kind: "single-link",
  render(ctx: RenderContext): string {
    const { files, host, config } = ctx;
    if (!files.length) return config.emptyText ?? "_No note yet._";
    const file = files[0];
    return ctx.app.fileManager.generateMarkdownLink(file, host.path);
  },
};

// --- helpers --------------------------------------------------------------

function sorted(files: TFile[], by: string, order: "asc" | "desc"): TFile[] {
  const arr = [...files];
  arr.sort((a, b) => {
    switch (by) {
      case "path":
        return a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
      case "mtime":
        return a.stat.mtime - b.stat.mtime;
      case "ctime":
        return a.stat.ctime - b.stat.ctime;
      case "basename":
      default:
        return a.basename.localeCompare(b.basename, undefined, { sensitivity: "base" });
    }
  });
  if (order === "desc") arr.reverse();
  return arr;
}

function extractMonth(basename: string): string | null {
  // YYYY-MM-DD (standard ISO)
  let m = basename.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (m) return `${m[1]}-${m[2]}`;
  // MM.DD.YYYY — optionally prefixed (e.g. "02.23.2026")
  m = basename.match(/(?:^|[^0-9])(\d{1,2})\.(\d{2})\.(\d{4})(?:$|[^0-9])/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}`;
  // MM.DD.YY — optionally prefixed, assumes 20XX (e.g. "02.23.26", "WR 02.08.26")
  m = basename.match(/(?:^|[^0-9])(\d{1,2})\.(\d{2})\.(\d{2})(?:$|[^0-9])/);
  if (m) return `20${m[3]}-${m[1].padStart(2, "0")}`;
  return null;
}

// --- registry -------------------------------------------------------------

export function buildRendererRegistry(): Map<RendererKind, Renderer> {
  const map = new Map<RendererKind, Renderer>();
  for (const r of [bulletListRenderer, monthGroupsRenderer, singleLinkRenderer]) {
    map.set(r.kind, r);
  }
  return map;
}
