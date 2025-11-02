import {
  App,
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
  ButtonComponent,
  normalizePath,
  parseYaml,
  stringifyYaml,
} from "obsidian";

interface AutoNodeConfig {
  keyword: string;
  caseSensitive: boolean;
  matchWholeWord: boolean;
}

interface AutoNodeRecord extends AutoNodeConfig {
  path: string;
}

interface AutoNodeSettings {
  nodes: Record<string, AutoNodeRecord>;
  graphFilterEnabled: boolean;
}

const AUTO_NODE_MARKER_START = "<!-- auto-node:start -->";
const AUTO_NODE_MARKER_END = "<!-- auto-node:end -->";
const AUTO_NODE_INTRO = [
  "# Auto Node",
  "An auto node is a special Obsidian .md note that will aggregate all your notes that contain a keyword of your choosing across your vault.",
  "Go to the Auto-node readme.md for more information.",
  "___",
  "",
].join("\n");
const AUTO_NODE_FILTER_CLAUSE = `-"${AUTO_NODE_MARKER_START}"`;

export default class AutoNodePlugin extends Plugin {
  private refreshTimeout: number | null = null;
  private isUpdating: Set<string> = new Set();
  private settings: AutoNodeSettings = { nodes: {}, graphFilterEnabled: false };
  private nodeRecords: Map<string, AutoNodeRecord> = new Map();
  private graphFilters: Map<WorkspaceLeaf, GraphFilterControl> = new Map();
  private graphQueries: Map<WorkspaceLeaf, string> = new Map();
  private activeGraphToggleAnimation?: number;
  private settingsTab?: AutoNodeSettingTab;
  private cssElement?: HTMLLinkElement;

  async onload() {
    await this.loadSettings();

      // Load CSS using link element (proper CSS file loading)
      try {
        // Create a link element to load the CSS file
        const linkElement = document.createElement('link');
        linkElement.setAttribute('data-auto-node', 'true');
        linkElement.rel = 'stylesheet';
        linkElement.type = 'text/css';
        linkElement.href = 'styles.css';
        
        document.head.appendChild(linkElement);
        
        // Store reference for cleanup
        this.cssElement = linkElement;
      } catch (cssError) {
        console.error("[auto-node] Failed to load CSS:", cssError);
      }

      this.settingsTab = new AutoNodeSettingTab(this.app, this);
      this.addSettingTab(this.settingsTab);

    this.addCommand({
      id: "create-auto-node",
      name: "Create auto-node page",
      callback: () => this.handleCreateAutoNode(),
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.scheduleRefresh();
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.scheduleRefresh();
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.removeAutoNodeRecord(file.path);
          this.scheduleRefresh();
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && file.extension === "md") {
          this.renameAutoNodeRecord(oldPath, file.path);
          this.scheduleRefresh();
        }
      }),
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.scheduleRefresh();
        }
      }),
    );

    this.app.workspace.onLayoutReady(() => {
      this.scheduleRefresh(100);
      this.enhanceGraphLeaves();
    });

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.enhanceGraphLeaves();
      }),
    );

    // Listen for when leaves are opened/activated to re-inject graph filters
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf && leaf.view.getViewType() === "graph") {
          this.ensureGraphFilterWithRetry(leaf);
        }
      }),
    );

    // Also listen for when graph views are created
    this.registerEvent(
      this.app.workspace.on("leaf-change", (leaf) => {
        if (leaf && leaf.view.getViewType() === "graph") {
          this.ensureGraphFilterWithRetry(leaf);
        }
      }),
    );
  }

  onunload() {
    if (this.refreshTimeout !== null) {
      window.clearTimeout(this.refreshTimeout);
      this.refreshTimeout = null;
    }

    this.cleanupGraphFilters();
    this.settingsTab = undefined;
    
    // Clean up CSS element
    if (this.cssElement && this.cssElement.parentNode) {
      this.cssElement.parentNode.removeChild(this.cssElement);
      this.cssElement = undefined;
    }
  }

  private scheduleRefresh(delay = 500) {
    if (this.refreshTimeout !== null) {
      window.clearTimeout(this.refreshTimeout);
    }
    this.refreshTimeout = window.setTimeout(() => {
      this.refreshTimeout = null;
      this.refreshAllAutoNodes().catch((err) => {
        console.error("AutoNode refresh failed", err);
        new Notice("Auto-node refresh failed. Check console for details.");
      });
    }, delay);
  }

  private async handleCreateAutoNode() {
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

    const caseSensitiveChoice = await PromptModal.ask(this.app, {
      prompt: "Match keyword case-sensitively? (yes/no)",
      placeholder: "no",
      cta: "Confirm",
    });

    const matchWholeWordChoice = await PromptModal.ask(this.app, {
      prompt: "Match whole words only? (yes/no)",
      placeholder: "no",
      cta: "Confirm",
    });

    const fileName = this.ensureMarkdownExtension(name.trim());
    const normalized = this.getTargetFilePath(fileName);

    const config: AutoNodeConfig = {
      keyword: keyword.trim(),
      caseSensitive: this.isYes(caseSensitiveChoice),
      matchWholeWord: this.isYes(matchWholeWordChoice),
    };

    try {
      const existing = this.app.vault.getAbstractFileByPath(normalized);
      let file: TFile;

      if (existing instanceof TFile) {
        file = existing;
        await this.ensureAutoNodeFrontmatter(file, config);
        await this.ensureMarkers(file, config.keyword);
        new Notice(`Converted existing note '${file.basename}' into an auto-node.`, 5000);
      } else {
        const content = this.buildInitialContent(config);
        new Notice(`Creating auto-node at ${normalized}`, 4000);
        file = await this.app.vault.create(normalized, content);
      }

      this.upsertAutoNodeRecord(normalized, config);
      await this.refreshAutoNode(file);
      await this.openFile(file);
      if (!(existing instanceof TFile)) {
        new Notice(`Created auto-node '${file.basename}' at ${normalized}.`, 5000);
      }
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to create auto-node note: ${message}`);
    }
  }

  private buildInitialContent(config: AutoNodeConfig) {
    return [
      "---",
      "autoNode: true",
      `autoNodeKeyword: ${config.keyword}`,
      `autoNodeCaseSensitive: ${config.caseSensitive}`,
      `autoNodeMatchWholeWord: ${config.matchWholeWord}`,
      "---",
      "",
      AUTO_NODE_INTRO,
      `<!-- Auto-node keyword: ${config.keyword} -->`,
      AUTO_NODE_MARKER_START,
      "_Collecting links..._",
      AUTO_NODE_MARKER_END,
      "",
    ].join("\n");
  }

  private isYes(value: string | null) {
    return value ? value.trim().toLowerCase().startsWith("y") : false;
  }

  private getTargetFilePath(fileName: string) {
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

  private ensureMarkdownExtension(name: string) {
    return name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
  }

  private async refreshAllAutoNodes() {
    const files = this.app.vault.getMarkdownFiles();
    const autoNodes = files.filter((file) => this.resolveAutoNodeRecord(file));

    for (const autoNode of autoNodes) {
      await this.refreshAutoNode(autoNode);
    }
  }

  private async refreshAutoNode(file: TFile) {
    if (this.isUpdating.has(file.path)) {
      return;
    }

    const record = this.resolveAutoNodeRecord(file);
    if (!record) {
      return;
    }

    try {
      this.isUpdating.add(file.path);
      const vaultFiles = this.app.vault.getMarkdownFiles();
      const matches: string[] = [];

      for (const otherFile of vaultFiles) {
        if (otherFile.path === file.path) {
          continue;
        }

        const content = await this.app.vault.cachedRead(otherFile);
        if (this.containsKeyword(otherFile, content, record)) {
          matches.push(
            this.app.fileManager.generateMarkdownLink(
              otherFile,
              file.path,
            ),
          );
        }
      }

      matches.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      const generatedSection = matches.length
        ? matches.map((link) => `- ${link}`).join("\n")
        : "_No matching notes yet._";

      const current = await this.app.vault.read(file);
      const next = this.mergeGeneratedSection(current, generatedSection, record.keyword);

      if (current !== next) {
        await this.app.vault.modify(file, next);
      }
    } finally {
      this.isUpdating.delete(file.path);
    }
  }

  private containsKeyword(file: TFile, content: string, config: AutoNodeConfig) {
    const keyword = config.caseSensitive ? config.keyword : config.keyword.toLowerCase();
    const haystack = config.caseSensitive ? content : content.toLowerCase();
    const titleHaystack = config.caseSensitive
      ? file.basename
      : file.basename.toLowerCase();
    const pathHaystack = config.caseSensitive ? file.path : file.path.toLowerCase();

    if (!config.matchWholeWord) {
      return haystack.includes(keyword) || titleHaystack.includes(keyword) || pathHaystack.includes(keyword);
    }

    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = config.caseSensitive ? "g" : "gi";
    const regex = new RegExp(`\\b${escaped}\\b`, flags);
    return regex.test(content) || regex.test(file.basename) || regex.test(file.path);
  }

  private mergeGeneratedSection(current: string, generated: string, keyword: string) {
    let next = this.normalizeMarkers(current);

    next = this.ensureIntroSection(next);

    if (!next.includes(AUTO_NODE_MARKER_START) || !next.includes(AUTO_NODE_MARKER_END)) {
      next = [
        next.trimEnd(),
        "",
        AUTO_NODE_MARKER_START,
        AUTO_NODE_MARKER_END,
        "",
      ].join("\n");
    }

    const startIndex = next.indexOf(AUTO_NODE_MARKER_START);
    const endIndex = next.indexOf(AUTO_NODE_MARKER_END);

    if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
      return next;
    }

    const before = next.slice(0, startIndex + AUTO_NODE_MARKER_START.length);
    const after = next.slice(endIndex);

    return `${before}\n\n${generated}\n\n${after.trimStart()}`.trimEnd() + "\n";
  }

  private normalizeMarkers(content: string) {
    return content
      .replace(/<!--\s*auto-node keyword:[^>]*-->/gi, (match) => {
        const keyword = match.split(":")[1]?.replace("-->", "").trim() ?? "";
        return `<!-- Auto-node keyword: ${keyword} -->`;
      })
      .replace(/<!--\s*auto-node:start\s*-->/gi, AUTO_NODE_MARKER_START)
      .replace(/<!--\s*auto-node:end\s*-->/gi, AUTO_NODE_MARKER_END);
  }

  private async loadSettings() {
    const data = (await this.loadData()) as AutoNodeSettings | null;
    this.settings = data ?? { nodes: {}, graphFilterEnabled: false };
    this.nodeRecords = new Map(
      Object.values(this.settings.nodes ?? {}).map((record) => [record.path, record]),
    );
  }

  private async saveSettings() {
    this.settings.nodes = Object.fromEntries(this.nodeRecords.entries());
    await this.saveData(this.settings);
  }

  private upsertAutoNodeRecord(path: string, config: AutoNodeConfig) {
    const record: AutoNodeRecord = { path, ...config };
    this.nodeRecords.set(path, record);
    void this.saveSettings().catch((error) => console.error("[auto-node] Failed to save settings", error));
    this.settingsTab?.refresh();
  }

  private removeAutoNodeRecord(path: string) {
    if (this.nodeRecords.delete(path)) {
      void this.saveSettings().catch((error) => console.error("[auto-node] Failed to save settings", error));
      this.settingsTab?.refresh();
    }
  }

  private renameAutoNodeRecord(oldPath: string, newPath: string) {
    const record = this.nodeRecords.get(oldPath);
    if (record) {
      this.nodeRecords.delete(oldPath);
      record.path = newPath;
      this.nodeRecords.set(newPath, record);
      void this.saveSettings().catch((error) => console.error("[auto-node] Failed to save settings", error));
      this.settingsTab?.refresh();
    }
  }

  private resolveAutoNodeRecord(file: TFile): AutoNodeRecord | null {
    const known = this.nodeRecords.get(file.path);
    if (known) {
      return known;
    }

    const detected = this.detectAutoNodeConfig(file);
    if (!detected) {
      return null;
    }

    const record: AutoNodeRecord = { path: file.path, ...detected };
    this.nodeRecords.set(file.path, record);
    void this.saveSettings().catch((error) => console.error("[auto-node] Failed to save settings", error));
    this.settingsTab?.refresh();
    return record;
  }

  getAutoNodeRecords() {
    return Array.from(this.nodeRecords.values()).sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
  }

  getAutoNodeRecord(path: string) {
    return this.nodeRecords.get(path) ?? null;
  }

  async saveAutoNodeConfig(path: string, config: AutoNodeConfig) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new Error(`Auto-node file not found at '${path}'.`);
    }

    const keyword = config.keyword.trim();
    if (!keyword) {
      throw new Error("Keyword cannot be empty.");
    }

    const record: AutoNodeRecord = {
      path,
      keyword,
      caseSensitive: config.caseSensitive,
      matchWholeWord: config.matchWholeWord,
    };

    this.nodeRecords.set(path, record);
    await this.ensureAutoNodeFrontmatter(file, record);
    await this.ensureMarkers(file, record.keyword);
    await this.saveSettings();
    this.settingsTab?.refresh();
    await this.refreshAutoNode(file);
    return record;
  }

  async renameAutoNodeFile(currentPath: string, desiredPath: string) {
    const record = this.nodeRecords.get(currentPath);
    if (!record) {
      throw new Error(`Unknown auto-node record for '${currentPath}'.`);
    }

    const file = this.app.vault.getAbstractFileByPath(currentPath);
    if (!(file instanceof TFile)) {
      throw new Error(`Auto-node file not found at '${currentPath}'.`);
    }

    const trimmed = desiredPath.trim();
    if (!trimmed) {
      throw new Error("File path cannot be empty.");
    }

    const withExtension = this.ensureMarkdownExtension(trimmed);
    let normalized: string;
    try {
      normalized = normalizePath(withExtension);
    } catch (error) {
      console.error("[auto-node] Failed to normalize desired path", withExtension, error);
      throw new Error("Invalid file path.");
    }

    if (normalized === currentPath) {
      return normalized;
    }

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing) {
      throw new Error(`A file already exists at '${normalized}'.`);
    }

    const folders = normalized.split("/");
    folders.pop();
    if (folders.length) {
      const folderPath = folders.join("/");
      await this.ensureFolder(folderPath);
    }

    await this.app.fileManager.renameFile(file, normalized);

    this.nodeRecords.delete(currentPath);
    const updated: AutoNodeRecord = {
      path: normalized,
      keyword: record.keyword,
      caseSensitive: record.caseSensitive,
      matchWholeWord: record.matchWholeWord,
    };
    this.nodeRecords.set(normalized, updated);
    await this.saveSettings();
    this.settingsTab?.refresh();

    return normalized;
  }

  async deleteAutoNode(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.vault.trash(file, true);
    }
    this.removeAutoNodeRecord(path);
    this.isUpdating.delete(path);
  }

  async refreshAutoNodeByPath(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new Error(`Auto-node file not found at '${path}'.`);
    }
    await this.refreshAutoNode(file);
  }

  private async ensureFolder(folderPath: string) {
    if (!folderPath) {
      return;
    }

    const parts = folderPath.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        try {
          await this.app.vault.createFolder(current);
        } catch (error) {
          if (!String(error ?? "").includes("folder already exists")) {
            throw error;
          }
        }
      }
    }
  }

  private detectAutoNodeConfig(file: TFile): AutoNodeConfig | null {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    if (!frontmatter) {
      return null;
    }

    const keyword = (frontmatter.autoNodeKeyword ?? frontmatter.autonodekeyword ?? frontmatter["auto-node-keyword"]) as string | undefined;
    if (!keyword) {
      return null;
    }

    const caseSensitive = this.parseBoolean(frontmatter.autoNodeCaseSensitive);
    const matchWholeWord = this.parseBoolean(frontmatter.autoNodeMatchWholeWord);

    return {
      keyword: keyword.toString(),
      caseSensitive,
      matchWholeWord,
    };
  }

  private async ensureAutoNodeFrontmatter(file: TFile, config: AutoNodeConfig) {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatterBlock = cache?.frontmatterPosition;
    const original = await this.app.vault.read(file);

    if (!frontmatterBlock) {
      const fm = stringifyYaml({
        autoNode: true,
        autoNodeKeyword: config.keyword,
        autoNodeCaseSensitive: config.caseSensitive,
        autoNodeMatchWholeWord: config.matchWholeWord,
      });
      const next = `---\n${fm}---\n\n${original.trimStart()}`;
      await this.app.vault.modify(file, next);
      return;
    }

    const frontmatterLines = original
      .slice(frontmatterBlock.start.offset, frontmatterBlock.end.offset)
      .split("\n")
      .map((line) => line.replace(/^---/, "").trim())
      .filter(Boolean);

    const frontmatterObj = parseYaml(frontmatterLines.join("\n")) ?? {};
    frontmatterObj.autoNode = true;
    frontmatterObj.autoNodeKeyword = config.keyword;
    frontmatterObj.autoNodeCaseSensitive = config.caseSensitive;
    frontmatterObj.autoNodeMatchWholeWord = config.matchWholeWord;

    const fm = stringifyYaml(frontmatterObj).trimEnd();
    const before = original.slice(0, frontmatterBlock.start.offset);
    const after = original.slice(frontmatterBlock.end.offset).trimStart();
    const next = `${before}---\n${fm}\n---\n\n${after}`;
    await this.app.vault.modify(file, next);
  }

  private async ensureMarkers(file: TFile, keyword: string) {
    const content = await this.app.vault.read(file);
    if (content.includes(AUTO_NODE_MARKER_START) && content.includes(AUTO_NODE_MARKER_END)) {
      return;
    }

    const body = content.trimEnd();
    const addition = [
      "",
      `<!-- Auto-node keyword: ${keyword} -->`,
      AUTO_NODE_MARKER_START,
      "_Collecting links..._",
      AUTO_NODE_MARKER_END,
      "",
    ].join("\n");

    await this.app.vault.modify(file, `${body}${addition}`);
  }

  private enhanceGraphLeaves() {
    const leaves = this.app.workspace.getLeavesOfType("graph");
    for (const leaf of leaves) {
      this.injectGraphFilter(leaf);
    }
  }

  private injectGraphFilter(leaf: WorkspaceLeaf) {
    const view: any = leaf.view;
    const container = view?.containerEl?.querySelector?.(".graph-controls");
    if (!container) {
      return;
    }

    const filtersSection = container.querySelector(".graph-controls-section.filters") ?? container;
    const list = filtersSection.querySelector(".setting-list") ?? filtersSection;

    // Check if filter already exists and is properly attached
    let filter = this.graphFilters.get(leaf);
    if (filter && filter.settingEl?.isConnected) {
      return;
    }

    // Create or recreate the filter
    if (filter) {
      filter.detach();
    }
    
    filter = new GraphFilterControl(this, list as HTMLElement, leaf);
    this.graphFilters.set(leaf, filter);
    filter.render();
  }

  private cleanupGraphFilters() {
    for (const filter of this.graphFilters.values()) {
      filter.detach();
    }
    this.graphFilters.clear();
  }

  private ensureGraphFilterWithRetry(leaf: WorkspaceLeaf, retries = 3) {
    const attemptInjection = () => {
      const view: any = leaf.view;
      const container = view?.containerEl?.querySelector?.(".graph-controls");
      
      if (container) {
        this.injectGraphFilter(leaf);
      } else if (retries > 0) {
        setTimeout(() => {
          this.ensureGraphFilterWithRetry(leaf, retries - 1);
        }, 200);
      }
    };

    // Initial attempt with a small delay
    setTimeout(attemptInjection, 100);
  }

  applyGraphFilter(leaf: WorkspaceLeaf, explicit?: boolean) {
    const view: any = leaf.view;
    const input: HTMLInputElement | null =
      view?.controls?.searchComponent?.inputEl ??
      view?.searchComponent?.inputEl ??
      view?.controlsFilter?.textComponent?.inputEl ??
      view?.filterComponent?.inputEl ??
      leaf.containerEl.querySelector<HTMLInputElement>("input[type=search], input[type=text]");

    if (!input) {
      return;
    }

    const current = input.value ?? this.graphQueries.get(leaf) ?? "";

    const shouldEnable = explicit ?? this.settings.graphFilterEnabled;

    if (shouldEnable) {
      if (!current.includes(AUTO_NODE_FILTER_CLAUSE)) {
        const next = current.trim() ? `${current} ${AUTO_NODE_FILTER_CLAUSE}` : AUTO_NODE_FILTER_CLAUSE;
        this.setGraphQuery(leaf, view, input, next, shouldEnable);
      }
    } else if (current.includes(AUTO_NODE_FILTER_CLAUSE)) {
      const next = current.replace(AUTO_NODE_FILTER_CLAUSE, "").replace(/\s{2,}/g, " ").trim();
      this.setGraphQuery(leaf, view, input, next, shouldEnable);
    }
  }

  private setGraphQuery(leaf: WorkspaceLeaf, view: any, input: HTMLInputElement, value: string, enabled: boolean) {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));

    if (view?.controls?.setQuery) {
      view.controls.setQuery(value);
    } else if (view?.setQuery) {
      view.setQuery(value);
    }

    if (enabled) {
      this.graphQueries.set(leaf, value);
    } else {
      this.graphQueries.delete(leaf);
    }

    requestAnimationFrame(() => view?.render?.());
  }

  private ensureIntroSection(content: string) {
    if (content.includes("# Auto Node")) {
      return content;
    }

    const frontmatterMatch = content.match(/^---[\s\S]*?\n---\n?/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[0];
      const rest = content.slice(frontmatter.length).trimStart();
      const body = rest ? `\n${rest}` : "";
      return `${frontmatter}${AUTO_NODE_INTRO}${body}`.trimEnd() + "\n";
    }

    const trimmed = content.trimStart();
    if (!trimmed) {
      return `${AUTO_NODE_INTRO}`;
    }

    return `${AUTO_NODE_INTRO}\n${trimmed}`;
  }

  private parseBoolean(value: unknown) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      return ["true", "yes", "1"].includes(value.trim().toLowerCase());
    }
    return false;
  }

  private async openFile(file: TFile) {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }
}

interface PromptOptions {
  prompt: string;
  placeholder?: string;
  cta?: string;
}

class PromptModal extends Modal {
  private resolve!: (value: string | null) => void;
  private value: string | null = null;

  constructor(app: App, private readonly options: PromptOptions) {
    super(app);
  }

  static async ask(app: App, options: PromptOptions) {
    const modal = new PromptModal(app, options);
    modal.open();
    return new Promise<string | null>((resolve) => {
      modal.resolve = resolve;
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("auto-node-prompt-modal");

    const form = contentEl.createEl("form");

    const heading = form.createEl("h2", { text: this.options.prompt });
    heading.addClass("auto-node-prompt-heading");

    const input = form.createEl("input", {
      type: "text",
      placeholder: this.options.placeholder ?? "",
    });
    input.addClass("auto-node-prompt-input");
    input.focus();

    const submit = form.createEl("button", {
      type: "submit",
      text: this.options.cta ?? "OK",
    });
    submit.addClass("auto-node-prompt-submit");

    form.onsubmit = (event) => {
      event.preventDefault();
      this.value = input.value.trim() || null;
      this.close();
    };

    input.onkeydown = (event) => {
      if (event.key === "Escape") {
        this.value = null;
        this.close();
      }
    };
  }

  onClose() {
    this.contentEl.empty();
    this.resolve(this.value);
  }
}

class GraphFilterControl {
  private toggle?: ToggleComponent;
  private settingEl?: HTMLElement;

  constructor(
    private readonly plugin: AutoNodePlugin,
    private readonly container: HTMLElement,
    private readonly leaf: WorkspaceLeaf,
  ) {}

  render() {
    let wrapper = this.container.querySelector<HTMLDivElement>(".auto-node-filter-wrapper");
    if (!wrapper) {
      wrapper = this.container.createDiv({ cls: "auto-node-filter-wrapper setting-item setting-item--no-borders" });
    } else {
      wrapper.className = "auto-node-filter-wrapper setting-item setting-item--no-borders";
      wrapper.empty();
    }

    const info = wrapper.createDiv({ cls: "setting-item-info" });
    info.createEl("div", { cls: "setting-item-name", text: "Hide auto-nodes" });
    info.createEl("div", {
      cls: "setting-item-description",
      text: "Hide notes populated automatically by Auto Node from this graph.",
    });

    const control = wrapper.createDiv({ cls: "setting-item-control" });
    const toggle = new ToggleComponent(control);
    toggle.setValue(this.plugin.graphQueries.get(this.leaf)?.includes(AUTO_NODE_FILTER_CLAUSE) ?? this.plugin.settings.graphFilterEnabled);
    toggle.onChange((value) => {
      toggle.toggleEl.addClass("mod-warning");
      window.clearTimeout(this.plugin.activeGraphToggleAnimation);
      this.plugin.activeGraphToggleAnimation = window.setTimeout(() => {
        toggle.toggleEl.removeClass("mod-warning");
      }, 150);
      this.plugin.settings.graphFilterEnabled = value;
      void this.plugin.saveSettings();
      this.plugin.applyGraphFilter(this.leaf, value);
    });

    this.toggle = toggle;
    this.settingEl = wrapper;
    this.plugin.applyGraphFilter(this.leaf);
  }

  detach() {
    if (this.settingEl?.isConnected) {
      this.settingEl.remove();
    }
  }
}

class AutoNodeSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: AutoNodePlugin) {
    super(app, plugin);
  }

  refresh() {
    if (this.containerEl?.isConnected) {
      this.display();
    }
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Auto Node" });
    containerEl.createEl("p", {
      text: "Manage the auto-nodes that have been created in your vault.",
    });

    const records = this.plugin.getAutoNodeRecords();
    if (!records.length) {
      containerEl.createEl("p", {
        text: "No auto-nodes found yet. Use the command palette to create one, then return here to manage it.",
      });
      return;
    }

    for (const record of records) {
      this.renderRecord(containerEl, record);
    }
  }

  private renderRecord(container: HTMLElement, record: AutoNodeRecord) {
    let currentPath = record.path;

    const row = new Setting(container)
      .setName(record.path)
      .setDesc("Auto-node settings");

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
        if (!desiredPath || desiredPath === currentPath) {
          return;
        }

        button.setDisabled(true);
        try {
          const renamedTo = await this.plugin.renameAutoNodeFile(currentPath, desiredPath);
          currentPath = renamedTo;
          row.setName(renamedTo);
          pathInput.setValue(renamedTo);
          new Notice(`Renamed auto-node to '${renamedTo}'.`);
          this.refresh();
        } catch (error) {
          console.error("[auto-node] Failed to rename auto-node", error);
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
        const modal = new AutoNodeSettingsModal(this.app, this.plugin, currentPath);
        modal.open();
      });
    });
  }
}

class AutoNodeSettingsModal extends Modal {
  private currentPath: string;
  private keywordInput?: TextComponent;
  private caseToggle?: ToggleComponent;
  private wholeWordToggle?: ToggleComponent;
  private refreshButton?: ButtonComponent;
  private deleteButton?: ButtonComponent;
  private currentConfig?: AutoNodeConfig;

  constructor(app: App, private readonly plugin: AutoNodePlugin, path: string) {
    super(app);
    this.currentPath = path;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("auto-node-settings-modal");

    const heading = contentEl.createEl("h2", { text: "Auto-node settings" });
    heading.addClass("auto-node-settings-heading");

    const record = this.plugin.getAutoNodeRecord(this.currentPath);
    if (!record) {
      contentEl.createEl("p", { text: "Auto-node not found." });
      return;
    }

    this.currentConfig = {
      keyword: record.keyword,
      caseSensitive: record.caseSensitive,
      matchWholeWord: record.matchWholeWord,
    };

    contentEl.createEl("p", {
      text: "Adjust matching behavior for this auto-node. Changes apply immediately.",
    });

    const keywordSetting = new Setting(contentEl)
      .setName("Match keyword")
      .setDesc("Notes containing this keyword are collected into the auto-node.");
    keywordSetting.addText((text) => {
      this.keywordInput = text;
      text.setValue(this.currentConfig?.keyword ?? "");
      text.inputEl.placeholder = "keyword";
      text.inputEl.onblur = async () => {
        if (!this.keywordInput || !this.currentConfig) {
          return;
        }
        const value = this.keywordInput.getValue().trim();
        if (!value) {
          this.keywordInput.setValue(this.currentConfig.keyword);
          return;
        }
        if (value === this.currentConfig.keyword) {
          this.keywordInput.setValue(this.currentConfig.keyword);
          return;
        }
        await this.updateConfig({ keyword: value });
      };
    });

    const caseSetting = new Setting(contentEl)
      .setName("Case sensitive matching")
      .setDesc("Only match the keyword when the case exactly matches.");
    caseSetting.addToggle((toggle) => {
      this.caseToggle = toggle;
      toggle.setValue(this.currentConfig?.caseSensitive ?? false);
      toggle.onChange(async (value) => {
        await this.updateConfig({ caseSensitive: value });
      });
    });

    const wholeWordSetting = new Setting(contentEl)
      .setName("Whole word matching")
      .setDesc("Require the keyword to appear as a whole word.");
    wholeWordSetting.addToggle((toggle) => {
      this.wholeWordToggle = toggle;
      toggle.setValue(this.currentConfig?.matchWholeWord ?? false);
      toggle.onChange(async (value) => {
        await this.updateConfig({ matchWholeWord: value });
      });
    });

    const actionsSetting = new Setting(contentEl)
      .setName("Actions");

    actionsSetting.addButton((button) => {
      button.setButtonText("Refresh");
      button.onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.refreshAutoNodeByPath(this.currentPath);
          new Notice(`Refreshed '${this.currentPath}'.`);
        } catch (error) {
          console.error("[auto-node] Failed to refresh auto-node", error);
          const message = error instanceof Error ? error.message : String(error);
          new Notice(`Failed to refresh auto-node: ${message}`);
        } finally {
          button.setDisabled(false);
        }
      });
      this.refreshButton = button;
    });

    actionsSetting.addButton((button) => {
      button.setButtonText("Delete").setWarning();
      button.onClick(async () => {
        if (!confirm(`Delete '${this.currentPath}'? This will move the note to trash.`)) {
          return;
        }
        button.setDisabled(true);
        try {
          await this.plugin.deleteAutoNode(this.currentPath);
          new Notice(`Deleted '${this.currentPath}'.`);
          this.close();
        } catch (error) {
          console.error("[auto-node] Failed to delete auto-node", error);
          const message = error instanceof Error ? error.message : String(error);
          new Notice(`Failed to delete auto-node: ${message}`);
        } finally {
          button.setDisabled(false);
        }
      });
      this.deleteButton = button;
    });

    const footer = contentEl.createDiv({ cls: "auto-node-settings-modal-footer" });
    const closeButton = new ButtonComponent(footer);
    closeButton.setButtonText("Close");
    closeButton.onClick(() => this.close());
    closeButton.setCta();
  }

  private async updateConfig(update: Partial<AutoNodeConfig>) {
    try {
      const record = this.plugin.getAutoNodeRecord(this.currentPath);
      if (!record) {
        throw new Error("Auto-node no longer exists.");
      }

      const next: AutoNodeConfig = {
        keyword: update.keyword ?? record.keyword,
        caseSensitive: update.caseSensitive ?? record.caseSensitive,
        matchWholeWord: update.matchWholeWord ?? record.matchWholeWord,
      };

      await this.plugin.saveAutoNodeConfig(this.currentPath, next);

      this.currentConfig = { ...next };
      if (this.keywordInput) {
        this.keywordInput.setValue(next.keyword);
      }
      if (this.caseToggle) {
        this.caseToggle.setValue(next.caseSensitive);
      }
      if (this.wholeWordToggle) {
        this.wholeWordToggle.setValue(next.matchWholeWord);
      }
      if (this.refreshButton) {
        this.refreshButton.setDisabled(false);
      }
      if (this.deleteButton) {
        this.deleteButton.setDisabled(false);
      }
    } catch (error) {
      console.error("[auto-node] Failed to update auto-node config", error);
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to update auto-node: ${message}`);
      throw error;
    }
  }
}

