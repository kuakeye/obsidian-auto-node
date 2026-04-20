import type { App, TFile } from "obsidian";
import type { Block, BlockConfig, Registries, SourceContext } from "./types";
import { parseBlocks, replaceBlockBody } from "./markers";
import { resolveScope } from "./sources";
import { START_TAG } from "./markers";

/**
 * Engine
 * ======
 *
 * The engine is the single place that knows how to:
 *   1. Find files that contain auto-node blocks.
 *   2. Parse the blocks in a file.
 *   3. For each block, run its source → renderer pipeline.
 *   4. Merge the generated content back into the file, preserving markers.
 *
 * It deliberately stays decoupled from Obsidian events, modals and commands —
 * those live in main.ts and just call into the engine.
 */
export class Engine {
  private readonly isUpdating = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly registries: Registries,
    private readonly options: EngineOptions = {},
  ) {}

  /** Find and refresh every auto-node file in the vault. */
  async refreshAll(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const candidates: TFile[] = [];

    // Cheap pre-filter: known legacy records + quick content substring test.
    // The heavy work (parsing + source iteration) only runs on hits.
    for (const file of files) {
      if (await this.isAutoNodeFile(file)) candidates.push(file);
    }

    for (const file of candidates) {
      try {
        await this.refreshFile(file);
      } catch (err) {
        console.error(`[auto-node] Failed to refresh '${file.path}':`, err);
      }
    }
  }

  /** Refresh a single file's auto-node blocks. */
  async refreshFile(file: TFile): Promise<void> {
    if (this.isUpdating.has(file.path)) return;
    this.isUpdating.add(file.path);
    try {
      const original = await this.app.vault.read(file);
      const blocks = parseBlocks(original);
      if (!blocks.length) return;

      // Apply blocks back-to-front so earlier offsets stay valid after rewrites.
      let content = original;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        const effective = this.resolveEffectiveConfig(block, file);
        if (!effective) continue;
        const generated = await this.generateBlockContent(file, effective);
        content = replaceBlockBody(content, block, generated);
      }

      if (content !== original) {
        await this.app.vault.modify(file, content);
      }
    } finally {
      this.isUpdating.delete(file.path);
    }
  }

  /**
   * For legacy blocks (no inline attrs) we fall back to the file's frontmatter
   * for keyword/caseSensitive/matchWholeWord. This keeps every pre-0.2 note
   * working without a migration.
   */
  private resolveEffectiveConfig(block: Block, host: TFile): BlockConfig | null {
    if (!block.legacy) return block.config;
    const fm = this.app.metadataCache.getFileCache(host)?.frontmatter;
    if (!fm) return null;
    const keyword = (fm.autoNodeKeyword ?? fm["auto-node-keyword"]) as string | undefined;
    if (!keyword) return null;
    return {
      ...block.config,
      source: "keyword",
      render: "bullet-list",
      keyword: keyword.toString(),
      caseSensitive: parseBool(fm.autoNodeCaseSensitive),
      matchWholeWord: parseBool(fm.autoNodeMatchWholeWord),
    };
  }

  private async generateBlockContent(host: TFile, config: BlockConfig): Promise<string> {
    const source = this.registries.sources.get(config.source);
    if (!source) {
      return `_Unknown source '${config.source}'._`;
    }
    const renderer = this.registries.renderers.get(config.render);
    if (!renderer) {
      return `_Unknown renderer '${config.render}'._`;
    }

    const ctx: SourceContext = { app: this.app, host, config };
    const scope = await resolveScope(source, this.app, ctx);
    const candidates = scope ?? this.app.vault.getMarkdownFiles();
    const matched: TFile[] = [];

    for (const candidate of candidates) {
      if (candidate.path === host.path) continue;
      // Only read content if the source actually looks at it.
      const needsContent = sourceReadsContent(config.source);
      const content = needsContent ? await this.app.vault.cachedRead(candidate) : "";
      const ok = await Promise.resolve(source.matches(candidate, content, ctx));
      if (ok) matched.push(candidate);
    }

    // Apply limit after the renderer-specific sort. We pass the full list to
    // the renderer so month-groups can still bucket properly; limit is handled
    // pre-render for bullet/single-link, post-sort for consistency.
    const limit = config.limit && config.limit > 0 ? config.limit : 0;
    const files = limit ? matched.slice(0, limit) : matched;

    return renderer.render({ app: this.app, host, config, files });
  }

  /** Cheap check: does this file plausibly contain auto-node blocks? */
  private async isAutoNodeFile(file: TFile): Promise<boolean> {
    // Legacy: plugin settings listed it, or frontmatter has autoNodeKeyword.
    if (this.options.isKnownLegacy?.(file.path)) return true;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm && (fm.autoNodeKeyword || fm["auto-node-keyword"])) return true;
    // New: inline markers in file body.
    const content = await this.app.vault.cachedRead(file);
    return content.includes(START_TAG);
  }
}

export interface EngineOptions {
  /**
   * Hook so main.ts can contribute known legacy paths (e.g. from persisted
   * settings) to the auto-detection.
   */
  isKnownLegacy?: (path: string) => boolean;
}

/**
 * Sources whose matches() is purely metadata-driven can skip the file read.
 * This is a meaningful perf win in big vaults — content IO is the dominant
 * cost during refreshAll().
 */
function sourceReadsContent(kind: string): boolean {
  return kind === "keyword";
}

function parseBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(true|yes|1|on)$/i.test(value.trim());
  return false;
}
