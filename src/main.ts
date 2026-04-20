import {
  App,
  ButtonComponent,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TextComponent,
  ToggleComponent,
  WorkspaceLeaf,
  normalizePath,
  parseYaml,
  stringifyYaml,
} from "obsidian";

import type { AutoNodeSettings, BlockConfig, LegacyAutoNodeRecord, Registries } from "./types";
import { buildSourceRegistry } from "./sources";
import { buildRendererRegistry } from "./renderers";
import { Engine } from "./engine";
import { START_TAG, configToEndMarker, configToStartMarker } from "./markers";
import { ChoiceModal, ConfirmModal, PromptModal } from "./modals";
import { AUTO_NODE_FILTER_CLAUSE, GraphFilterControl, applyGraphFilter } from "./graph-filter";

/**
 * Auto Node plugin (v0.2)
 * =======================
 *
 * The plugin maintains "auto-node" regions inside markdown files. Each region
 * (a "block") is driven by a Source (which notes are in scope?) and a
 * Renderer (how should they be laid out?). Blocks are identified by
 * HTML-comment markers carrying inline attrs:
 *
 *   <!-- auto-node:start id=daily source=filename-regex
 *        pattern="^\d{4}-\d{2}-\d{2}$" render=month-groups order=desc -->
 *   ...generated content...
 *   <!-- auto-node:end id=daily -->
 *
 * Legacy (v0.1.x) files that only had `<!-- auto-node:start -->` +
 * `autoNodeKeyword` in frontmatter continue to work unchanged — the engine
 * resolves their config from frontmatter automatically.
 *
 * Adding a new pattern ("auto-link today in Home", "inbox queue", etc.) means
 * writing one Source and/or one Renderer, registering it, and adding a thin
 * command that writes the right inline-attr markers. No other plumbing.
 */

const AUTO_NODE_INTRO = [
  "# Auto Node",
  "An auto node is a special Obsidian .md note that will aggregate notes based on a rule you choose.",
  "See the plugin README for the inline-attr marker format and all available sources/renderers.",
  "___",
  "",
].join("\n");

export default class AutoNodePlugin extends Plugin {
  private refreshTimeout: number | null = null;
  settings: AutoNodeSettings = { nodes: {}, graphFilterEnabled: false, version: 2 };
  private nodeRecords: Map<string, LegacyAutoNodeRecord> = new Map();
  private registries!: Registries;
  private engine!: Engine;
  private settingsTab?: AutoNodeSettingTab;

  // Graph filter state (public so graph-filter.ts can read it).
  graphFilters: Map<WorkspaceLeaf, GraphFilterControl> = new Map();
  graphQueries: Map<WorkspaceLeaf, string> = new Map();
  activeGraphToggleAnimation?: number;

  async onload() {
    await this.loadSettings();

    this.registries = {
      sources: buildSourceRegistry(),
      renderers: buildRendererRegistry(),
    };
    this.engine = new Engine(this.app, this.registries, {
      isKnownLegacy: (path) => this.nodeRecords.has(path),
    });

    this.settingsTab = new AutoNodeSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    this.addCommand({
      id: "create",
      name: "Create auto-node page (keyword)",
      callback: () => this.handleCreateKeywordAutoNode(),
    });

    this.addCommand({
      id: "create-daily-notes-moc",
      name: "Create Daily Notes MOC",
      callback: () => this.handleCreateDailyNotesMOC(),
    });

    this.addCommand({
      id: "insert-block",
      name: "Insert auto-node block here",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (checking) return true;
        void this.handleInsertBlock(view);
        return true;
      },
    });

    this.addCommand({
      id: "refresh",
      name: "Refresh all auto-nodes now",
      callback: () => this.scheduleRefresh(0),
    });

    const onMaybeChange = (file: unknown) => {
      if (file instanceof TFile && file.extension === "md") this.scheduleRefresh();
    };
    this.registerEvent(this.app.vault.on("modify", onMaybeChange));
    this.registerEvent(this.app.vault.on("create", onMaybeChange));
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.removeLegacyRecord(file.path);
          this.scheduleRefresh();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && file.extension === "md") {
          this.renameLegacyRecord(oldPath, file.path);
          this.scheduleRefresh();
        }
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile && file.extension === "md") this.scheduleRefresh();
      }),
    );

    this.app.workspace.onLayoutReady(() => {
      this.scheduleRefresh(100);
      this.enhanceGraphLeaves();
    });

    this.registerEvent(this.app.workspace.on("layout-change", () => this.enhanceGraphLeaves()));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf && leaf.view.getViewType() === "graph") this.ensureGraphFilterWithRetry(leaf);
      }),
    );
  }

  onunload() {
    if (this.refreshTimeout !== null) {
      window.clearTimeout(this.refreshTimeout);
      this.refreshTimeout = null;
    }
    for (const filter of this.graphFilters.values()) filter.detach();
    this.graphFilters.clear();
    this.settingsTab = undefined;
  }

  private scheduleRefresh(delay = 500) {
    if (this.refreshTimeout !== null) window.clearTimeout(this.refreshTimeout);
    this.refreshTimeout = window.setTimeout(() => {
      this.refreshTimeout = null;
      this.engine.refreshAll().catch((err) => {
        console.error("[auto-node] refresh failed", err);
        new Notice("Auto-node refresh failed. Check console for details.");
      });
    }, delay);
  }

  // --- Commands -----------------------------------------------------------

  /**
   * Classic "Create auto-node page" flow — unchanged semantics from v0.1.x,
   * but writes the new inline-attr marker form. Legacy frontmatter is also
   * emitted so existing tooling/readers still see familiar fields.
   */
  private async handleCreateKeywordAutoNode() {
    const name = await PromptModal.ask(this.app, {
      prompt: "Auto-node note name (path optional)",
      placeholder: "dopamine MOC",
      cta: "Create",
    });
    if (!name) {
      new Notice("Auto-node creation cancelled.");
      return;
    }

    const keyword = await PromptModal.ask(this.app, {
      prompt: "Keyword to match in notes",
      placeholder: "addiction",
      cta: "Set keyword",
    });
    if (!keyword) {
      new Notice("Auto-node creation requires a keyword.");
      return;
    }

    const caseSensitive = yes(
      await PromptModal.ask(this.app, {
        prompt: "Match keyword case-sensitively? (yes/no)",
        placeholder: "no",
        cta: "Confirm",
      }),
    );
    const matchWholeWord = yes(
      await PromptModal.ask(this.app, {
        prompt: "Match whole words only? (yes/no)",
        placeholder: "no",
        cta: "Confirm",
      }),
    );

    const config: BlockConfig = {
      id: "keyword",
      source: "keyword",
      render: "bullet-list",
      keyword: keyword.trim(),
      caseSensitive,
      matchWholeWord,
    };
    await this.createAutoNodeFile(name, config, {
      frontmatterLegacy: {
        autoNode: true,
        autoNodeKeyword: config.keyword,
        autoNodeCaseSensitive: !!config.caseSensitive,
        autoNodeMatchWholeWord: !!config.matchWholeWord,
      },
    });
  }

  /** Prompt once, create a Daily Notes MOC that groups dated notes by month. */
  private async handleCreateDailyNotesMOC() {
    const defaultName = "Daily Notes MOC";
    const name = await PromptModal.ask(this.app, {
      prompt: "Daily Notes MOC note name (path optional)",
      placeholder: defaultName,
      initialValue: defaultName,
      cta: "Create",
    });
    if (!name) return;

    const detectedPattern = this.detectDailyNotePattern();
    const pattern = await PromptModal.ask(this.app, {
      prompt: "Filename regex identifying a daily note",
      placeholder: detectedPattern,
      initialValue: detectedPattern,
      cta: "Set pattern",
    });
    if (!pattern) return;

    const config: BlockConfig = {
      id: "daily",
      source: "filename-regex",
      render: "month-groups",
      pattern,
      order: "desc",
    };
    await this.createAutoNodeFile(name, config);
  }

  /**
   * Inserts a single auto-node block at the cursor position of the active
   * editor. The user picks a source + renderer, then answers a couple of
   * quick follow-ups depending on what they picked.
   */
  private async handleInsertBlock(view: MarkdownView) {
    const sourceKind = await ChoiceModal.pick(this.app, [
      {
        label: "Filename regex (daily notes, dated files)",
        description: "Match files whose basename matches a regex.",
        value: "filename-regex" as const,
      },
      {
        label: "Folder",
        description: "Match all files under a folder path.",
        value: "folder" as const,
      },
      {
        label: "Tag",
        description: "Match files with a given tag.",
        value: "tag" as const,
      },
      {
        label: "Frontmatter field",
        description: "Match files whose frontmatter field has a value.",
        value: "frontmatter" as const,
      },
      {
        label: "Today's daily note",
        description: "Link to today's dated note (for launchpads/home).",
        value: "today" as const,
      },
      {
        label: "Keyword",
        description: "Match files containing a keyword in their content or path.",
        value: "keyword" as const,
      },
    ], "Choose source strategy");
    if (!sourceKind) return;

    const rendererKind = await ChoiceModal.pick(this.app, [
      { label: "Bullet list", description: "Flat list of links.", value: "bullet-list" as const },
      {
        label: "Grouped by month",
        description: "YYYY-MM headings with links underneath.",
        value: "month-groups" as const,
      },
      {
        label: "Single link",
        description: "Render at most one link inline.",
        value: "single-link" as const,
      },
    ], "Choose renderer");
    if (!rendererKind) return;

    const config: BlockConfig = {
      id: await uniqueId(sourceKind),
      source: sourceKind,
      render: rendererKind,
    };

    await this.askSourceDetails(config);

    const editor = view.editor;
    const markdown = [
      configToStartMarker(config),
      "_Collecting..._",
      configToEndMarker(config),
    ].join("\n");
    editor.replaceSelection(markdown + "\n");
    this.scheduleRefresh(100);
    new Notice(`Inserted auto-node block '${config.id}'.`);
  }

  /** Follow-up questions per source kind. Keeps the wizard minimal. */
  private async askSourceDetails(config: BlockConfig) {
    switch (config.source) {
      case "filename-regex": {
        const p = await PromptModal.ask(this.app, {
          prompt: "Filename regex",
          placeholder: "^\\d{4}-\\d{2}-\\d{2}$",
          initialValue: "^\\d{4}-\\d{2}-\\d{2}$",
          cta: "Set pattern",
        });
        if (p) config.pattern = p;
        break;
      }
      case "folder": {
        const folder = await PromptModal.ask(this.app, {
          prompt: "Folder path (no leading slash)",
          placeholder: "Daily Notes",
          cta: "Set folder",
        });
        if (folder) config.folder = folder;
        break;
      }
      case "tag": {
        const tag = await PromptModal.ask(this.app, {
          prompt: "Tag (with or without #)",
          placeholder: "project/active",
          cta: "Set tag",
        });
        if (tag) config.tag = tag;
        break;
      }
      case "frontmatter": {
        const field = await PromptModal.ask(this.app, {
          prompt: "Frontmatter field name",
          placeholder: "status",
          cta: "Set field",
        });
        if (field) config.field = field;
        const value = await PromptModal.ask(this.app, {
          prompt: "Value to match (leave blank to match presence)",
          placeholder: "active",
          cta: "Set value",
        });
        if (value) config.value = value;
        break;
      }
      case "today":
        // default pattern is fine for the YYYY-MM-DD case
        break;
      case "keyword": {
        const keyword = await PromptModal.ask(this.app, {
          prompt: "Keyword to match in notes",
          cta: "Set keyword",
        });
        if (keyword) config.keyword = keyword;
        break;
      }
    }
  }

  private detectDailyNotePattern(): string {
    const candidates = [
      { re: /^\d{2}\.\d{2}\.\d{4}$/, pattern: "^\\d{2}\\.\\d{2}\\.\\d{4}$" },
      { re: /^\d{4}-\d{2}-\d{2}$/, pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      { re: /^\d{2}-\d{2}-\d{4}$/, pattern: "^\\d{2}-\\d{2}-\\d{4}$" },
    ];
    for (const file of this.app.vault.getMarkdownFiles()) {
      for (const c of candidates) {
        if (c.re.test(file.basename)) return c.pattern;
      }
    }
    return "^\\d{4}-\\d{2}-\\d{2}$";
  }

  // --- File creation helper -----------------------------------------------

  private async createAutoNodeFile(
    rawName: string,
    config: BlockConfig,
    options: { frontmatterLegacy?: Record<string, unknown> } = {},
  ): Promise<TFile> {
    const fileName = ensureMarkdownExtension(rawName.trim());
    const normalized = this.getTargetFilePath(fileName);

    // Legacy keyword auto-nodes keep using unattributed markers so the old
    // settings UI remains the single source of truth (frontmatter ↔ UI). For
    // all other (new) block kinds, we write inline-attr markers so the block
    // is self-describing and the settings tab stays out of its way.
    const isLegacy = !!options.frontmatterLegacy;
    const startMarker = isLegacy ? "<!-- auto-node:start -->" : configToStartMarker(config);
    const endMarker = isLegacy ? "<!-- auto-node:end -->" : configToEndMarker(config);

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    const initial = buildInitialContent(config, options.frontmatterLegacy, startMarker, endMarker);
    let file: TFile;

    if (existing instanceof TFile) {
      // Convert an existing note: append a block at the bottom, don't clobber.
      const current = await this.app.vault.read(existing);
      const body = current.trimEnd();
      const appended = ["", startMarker, "_Collecting..._", endMarker, ""].join("\n");
      await this.app.vault.modify(existing, `${body}${appended}`);
      file = existing;
      new Notice(`Appended auto-node block to '${file.basename}'.`, 5000);
    } else {
      file = await this.app.vault.create(normalized, initial);
      new Notice(`Created auto-node '${file.basename}'.`, 5000);
    }

    if (config.source === "keyword") {
      // Keep the legacy settings record populated so old management UI still
      // reflects keyword auto-nodes.
      this.nodeRecords.set(normalized, {
        path: normalized,
        keyword: config.keyword ?? "",
        caseSensitive: !!config.caseSensitive,
        matchWholeWord: !!config.matchWholeWord,
      });
      await this.saveSettings();
    }

    await this.engine.refreshFile(file);
    await this.openFile(file);
    return file;
  }

  private getTargetFilePath(fileName: string): string {
    const activeFile = this.app.workspace.getActiveFile();
    const parentFolder = this.app.fileManager.getNewFileParent(activeFile?.path ?? "");
    const folderPath = parentFolder?.path === "/" ? "" : parentFolder?.path ?? "";
    const targetPath = folderPath ? `${folderPath}/${fileName}` : fileName;
    try {
      return normalizePath(targetPath);
    } catch (error) {
      console.error("[auto-node] Failed to normalize path", targetPath, error);
      return targetPath;
    }
  }

  private async openFile(file: TFile) {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }

  // --- Settings persistence -----------------------------------------------

  async loadSettings() {
    const data = (await this.loadData()) as AutoNodeSettings | null;
    this.settings = data ?? { nodes: {}, graphFilterEnabled: false, version: 2 };
    this.nodeRecords = new Map(
      Object.values(this.settings.nodes ?? {}).map((record) => [record.path, record]),
    );
  }

  async saveSettings() {
    this.settings.nodes = Object.fromEntries(this.nodeRecords.entries());
    await this.saveData(this.settings);
  }

  private removeLegacyRecord(path: string) {
    if (this.nodeRecords.delete(path)) {
      void this.saveSettings().catch((err) => console.error("[auto-node] save failed", err));
      this.settingsTab?.refresh();
    }
  }

  private renameLegacyRecord(oldPath: string, newPath: string) {
    const record = this.nodeRecords.get(oldPath);
    if (record) {
      this.nodeRecords.delete(oldPath);
      record.path = newPath;
      this.nodeRecords.set(newPath, record);
      void this.saveSettings().catch((err) => console.error("[auto-node] save failed", err));
      this.settingsTab?.refresh();
    }
  }

  // --- Legacy management API (used by settings tab) -----------------------

  getAutoNodeRecords() {
    return Array.from(this.nodeRecords.values()).sort((a, b) =>
      a.path.localeCompare(b.path, undefined, { sensitivity: "base" }),
    );
  }

  getAutoNodeRecord(path: string) {
    return this.nodeRecords.get(path) ?? null;
  }

  async refreshAutoNodeByPath(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Auto-node file not found at '${path}'.`);
    await this.engine.refreshFile(file);
  }

  async deleteAutoNode(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.vault.trash(file, true);
    this.removeLegacyRecord(path);
  }

  async renameAutoNodeFile(currentPath: string, desiredPath: string) {
    const record = this.nodeRecords.get(currentPath);
    if (!record) throw new Error(`Unknown auto-node record for '${currentPath}'.`);
    const file = this.app.vault.getAbstractFileByPath(currentPath);
    if (!(file instanceof TFile)) throw new Error(`Auto-node file not found at '${currentPath}'.`);

    const trimmed = desiredPath.trim();
    if (!trimmed) throw new Error("File path cannot be empty.");

    const withExtension = ensureMarkdownExtension(trimmed);
    let normalized: string;
    try {
      normalized = normalizePath(withExtension);
    } catch {
      throw new Error("Invalid file path.");
    }
    if (normalized === currentPath) return normalized;

    if (this.app.vault.getAbstractFileByPath(normalized)) {
      throw new Error(`A file already exists at '${normalized}'.`);
    }
    await ensureFolder(this.app, parentFolder(normalized));
    await this.app.fileManager.renameFile(file, normalized);

    this.nodeRecords.delete(currentPath);
    this.nodeRecords.set(normalized, { ...record, path: normalized });
    await this.saveSettings();
    this.settingsTab?.refresh();
    return normalized;
  }

  async saveAutoNodeConfig(
    path: string,
    update: { keyword: string; caseSensitive: boolean; matchWholeWord: boolean },
  ) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Auto-node file not found at '${path}'.`);
    if (!update.keyword.trim()) throw new Error("Keyword cannot be empty.");

    this.nodeRecords.set(path, {
      path,
      keyword: update.keyword.trim(),
      caseSensitive: update.caseSensitive,
      matchWholeWord: update.matchWholeWord,
    });
    await this.saveSettings();
    await ensureLegacyFrontmatter(this.app, file, update);
    this.settingsTab?.refresh();
    await this.engine.refreshFile(file);
  }

  // --- Graph filter wiring ------------------------------------------------

  private enhanceGraphLeaves() {
    for (const leaf of this.app.workspace.getLeavesOfType("graph")) this.injectGraphFilter(leaf);
  }

  private injectGraphFilter(leaf: WorkspaceLeaf) {
    const view = leaf.view as { containerEl?: HTMLElement };
    const container = view?.containerEl?.querySelector?.(".graph-controls");
    if (!container) return;
    const filtersSection = container.querySelector(".graph-controls-section.filters") ?? container;
    const list = filtersSection.querySelector(".setting-list") ?? filtersSection;

    let filter = this.graphFilters.get(leaf);
    if (filter && filter.isConnected) return;
    if (filter) filter.detach();

    filter = new GraphFilterControl(this, list as HTMLElement, leaf);
    this.graphFilters.set(leaf, filter);
    filter.render();
  }

  private ensureGraphFilterWithRetry(leaf: WorkspaceLeaf, retries = 3) {
    const attempt = () => {
      const view = leaf.view as { containerEl?: HTMLElement };
      const container = view?.containerEl?.querySelector?.(".graph-controls");
      if (container) {
        this.injectGraphFilter(leaf);
      } else if (retries > 0) {
        setTimeout(() => this.ensureGraphFilterWithRetry(leaf, retries - 1), 200);
      }
    };
    setTimeout(attempt, 100);
  }

  applyGraphFilter(leaf: WorkspaceLeaf, explicit?: boolean) {
    applyGraphFilter(this, leaf, explicit);
  }
}

// --- Module-level helpers -------------------------------------------------

function ensureMarkdownExtension(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
}

function parentFolder(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

async function ensureFolder(app: App, folderPath: string) {
  if (!folderPath) return;
  const parts = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      try {
        await app.vault.createFolder(current);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("folder already exists")) throw err;
      }
    }
  }
}

function yes(value: string | null): boolean {
  return value ? value.trim().toLowerCase().startsWith("y") : false;
}

async function uniqueId(prefix: string): Promise<string> {
  const short = prefix.replace(/[^a-z0-9-]/gi, "").slice(0, 12) || "block";
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${short}-${suffix}`;
}

function buildInitialContent(
  config: BlockConfig,
  legacyFrontmatter: Record<string, unknown> | undefined,
  startMarker: string,
  endMarker: string,
): string {
  const parts: string[] = [];
  if (legacyFrontmatter && Object.keys(legacyFrontmatter).length) {
    parts.push("---", stringifyYaml(legacyFrontmatter).trimEnd(), "---", "");
  }
  parts.push(AUTO_NODE_INTRO);
  // Hint comment so humans can find the keyword without parsing attrs.
  if (config.source === "keyword" && config.keyword) {
    parts.push(`<!-- Auto-node keyword: ${config.keyword} -->`);
  }
  parts.push(startMarker);
  parts.push("_Collecting..._");
  parts.push(endMarker);
  parts.push("");
  return parts.join("\n");
}

async function ensureLegacyFrontmatter(
  app: App,
  file: TFile,
  update: { keyword: string; caseSensitive: boolean; matchWholeWord: boolean },
) {
  const original = await app.vault.read(file);
  const cache = app.metadataCache.getFileCache(file);
  const block = cache?.frontmatterPosition;

  if (!block) {
    const fm = stringifyYaml({
      autoNode: true,
      autoNodeKeyword: update.keyword,
      autoNodeCaseSensitive: update.caseSensitive,
      autoNodeMatchWholeWord: update.matchWholeWord,
    });
    const next = `---\n${fm}---\n\n${original.trimStart()}`;
    await app.vault.modify(file, next);
    return;
  }

  const frontmatterLines = original
    .slice(block.start.offset, block.end.offset)
    .split("\n")
    .map((line) => line.replace(/^---/, "").trim())
    .filter(Boolean);
  const obj = (parseYaml(frontmatterLines.join("\n")) as Record<string, unknown>) ?? {};
  obj.autoNode = true;
  obj.autoNodeKeyword = update.keyword;
  obj.autoNodeCaseSensitive = update.caseSensitive;
  obj.autoNodeMatchWholeWord = update.matchWholeWord;
  const fm = stringifyYaml(obj).trimEnd();
  const before = original.slice(0, block.start.offset);
  const after = original.slice(block.end.offset).trimStart();
  await app.vault.modify(file, `${before}---\n${fm}\n---\n\n${after}`);
}

// --- Settings tab -------------------------------------------------------
// (Unchanged in responsibility from v0.1.x: lists legacy keyword auto-nodes
// and lets the user rename/reconfigure/delete them. New block-based auto-nodes
// are managed directly in their source files via inline-attr markers.)

class AutoNodeSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: AutoNodePlugin) {
    super(app, plugin);
  }

  refresh() {
    if (this.containerEl?.isConnected) this.display();
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Auto node").setHeading();
    containerEl.createEl("p", {
      text:
        "Manage legacy keyword auto-nodes. Newer auto-nodes are configured directly in their markers (see the README).",
    });

    const records = this.plugin.getAutoNodeRecords();
    if (!records.length) {
      containerEl.createEl("p", {
        text: "No legacy keyword auto-nodes found. Use the command palette to create one.",
      });
      return;
    }

    for (const record of records) this.renderRecord(containerEl, record);
  }

  private renderRecord(container: HTMLElement, record: LegacyAutoNodeRecord) {
    let currentPath = record.path;
    const row = new Setting(container).setName(record.path).setDesc("Auto-node settings");

    let pathInput: TextComponent;
    row.addText((text) => {
      pathInput = text;
      text.setValue(record.path);
      text.inputEl.placeholder = "folder/My Auto Node.md";
    });

    row.addButton((button) => {
      button.setButtonText("Rename").setCta();
      button.onClick(async () => {
        const desiredPath = pathInput.getValue();
        if (!desiredPath || desiredPath === currentPath) return;
        button.setDisabled(true);
        try {
          const renamed = await this.plugin.renameAutoNodeFile(currentPath, desiredPath);
          currentPath = renamed;
          row.setName(renamed);
          pathInput.setValue(renamed);
          new Notice(`Renamed auto-node to '${renamed}'.`);
          this.refresh();
        } catch (error) {
          console.error("[auto-node] rename failed", error);
          const message = error instanceof Error ? error.message : String(error);
          new Notice(`Failed to rename auto-node: ${message}`);
          pathInput.setValue(currentPath);
        } finally {
          button.setDisabled(false);
        }
      });
    });

    row.addButton((button) => {
      button.setButtonText("Auto-node settings");
      button.onClick(() => {
        new AutoNodeSettingsModal(this.app, this.plugin, currentPath).open();
      });
    });
  }
}

class AutoNodeSettingsModal extends Modal {
  constructor(app: App, private readonly plugin: AutoNodePlugin, private readonly path: string) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("auto-node-settings-modal");

    const heading = contentEl.createEl("h2", { text: "Auto-node settings" });
    heading.addClass("auto-node-settings-heading");

    const record = this.plugin.getAutoNodeRecord(this.path);
    if (!record) {
      contentEl.createEl("p", { text: "Auto-node not found." });
      return;
    }

    let keywordInput: TextComponent;
    let caseToggle: ToggleComponent;
    let wholeToggle: ToggleComponent;

    new Setting(contentEl)
      .setName("Match keyword")
      .setDesc("Notes containing this keyword are collected into the auto-node.")
      .addText((t) => {
        keywordInput = t;
        t.setValue(record.keyword);
      });

    new Setting(contentEl)
      .setName("Case sensitive matching")
      .addToggle((t) => {
        caseToggle = t;
        t.setValue(record.caseSensitive);
      });

    new Setting(contentEl)
      .setName("Whole word matching")
      .addToggle((t) => {
        wholeToggle = t;
        t.setValue(record.matchWholeWord);
      });

    new Setting(contentEl)
      .setName("Actions")
      .addButton((b) => {
        b.setButtonText("Save + refresh").setCta();
        b.onClick(async () => {
          b.setDisabled(true);
          try {
            await this.plugin.saveAutoNodeConfig(this.path, {
              keyword: keywordInput.getValue(),
              caseSensitive: caseToggle.getValue(),
              matchWholeWord: wholeToggle.getValue(),
            });
            new Notice(`Saved '${this.path}'.`);
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            new Notice(`Failed: ${m}`);
          } finally {
            b.setDisabled(false);
          }
        });
      })
      .addButton((b) => {
        b.setButtonText("Delete").setWarning();
        b.onClick(async () => {
          const ok = await ConfirmModal.ask(this.app, {
            prompt: `Delete '${this.path}'?`,
            description: "This will move the note to trash.",
            cta: "Delete",
          });
          if (!ok) return;
          try {
            await this.plugin.deleteAutoNode(this.path);
            new Notice(`Deleted '${this.path}'.`);
            this.close();
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            new Notice(`Failed to delete auto-node: ${m}`);
          }
        });
      });

    const footer = contentEl.createDiv({ cls: "auto-node-settings-modal-footer" });
    const close = new ButtonComponent(footer);
    close.setButtonText("Close").onClick(() => this.close());
  }
}
