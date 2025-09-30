import {
  App,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  TFile,
  normalizePath,
} from "obsidian";

interface AutoNodeConfig {
  keyword: string;
  caseSensitive: boolean;
  matchWholeWord: boolean;
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

export default class AutoNodePlugin extends Plugin {
  private refreshTimeout: number | null = null;
  private isUpdating: Set<string> = new Set();

  async onload() {
    this.addCommand({
      id: "create-auto-node",
      name: "Create auto-node page",
      callback: () => this.handleCreateAutoNode(),
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          console.debug(`[auto-node] Detected modify: ${file.path}`);
          this.scheduleRefresh();
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          console.debug(`[auto-node] Detected create: ${file.path}`);
          this.scheduleRefresh();
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          console.debug(`[auto-node] Detected delete: ${file.path}`);
          this.scheduleRefresh();
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          console.debug(`[auto-node] Detected rename: ${file.path}`);
          this.scheduleRefresh();
        }
      }),
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          console.debug(`[auto-node] Metadata changed: ${file.path}`);
          this.scheduleRefresh();
        }
      }),
    );

    this.app.workspace.onLayoutReady(() => {
      this.scheduleRefresh(100);
    });
  }

  onunload() {
    if (this.refreshTimeout !== null) {
      window.clearTimeout(this.refreshTimeout);
      this.refreshTimeout = null;
    }
  }

  private scheduleRefresh(delay = 500) {
    if (this.refreshTimeout !== null) {
      window.clearTimeout(this.refreshTimeout);
    }
    this.refreshTimeout = window.setTimeout(() => {
      this.refreshTimeout = null;
      console.debug("[auto-node] Refresh timer fired");
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

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      new Notice(`File '${fileName}' already exists.`);
      return;
    }

    const content = this.buildInitialContent({
      keyword: keyword.trim(),
      caseSensitive: this.isYes(caseSensitiveChoice),
      matchWholeWord: this.isYes(matchWholeWordChoice),
    });

    try {
      new Notice(`Creating auto-node at ${normalized}`, 4000);
      const file = await this.app.vault.create(normalized, content);
      await this.refreshAutoNode(file);
      await this.openFile(file);
      new Notice(`Created auto-node '${file.basename}' at ${normalized}.`, 5000);
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
    const autoNodes = files.filter((file) => this.readAutoNodeConfig(file));

    for (const autoNode of autoNodes) {
      await this.refreshAutoNode(autoNode);
    }
  }

  private async refreshAutoNode(file: TFile) {
    if (this.isUpdating.has(file.path)) {
      return;
    }

    const config = this.readAutoNodeConfig(file);
    if (!config) {
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
        if (this.containsKeyword(otherFile, content, config)) {
          console.debug(`[auto-node] Match found in ${otherFile.path} for keyword '${config.keyword}' in ${file.path}`);
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

      console.debug(
        `[auto-node] Refresh results for ${file.path}: ${matches.length} matches`,
      );

    const current = await this.app.vault.read(file);
    const next = this.mergeGeneratedSection(current, generatedSection, config.keyword);

      if (current !== next) {
        await this.app.vault.modify(file, next);
        console.debug(`[auto-node] Updated generated section in ${file.path} with ${matches.length} links.`);
      } else {
        console.debug(`[auto-node] No changes needed for ${file.path}.`);
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
      .replace(/<!--\s*auto-node:start\s*-->/gi, AUTO_NODE_MARKER_START)
      .replace(/<!--\s*auto-node:end\s*-->/gi, AUTO_NODE_MARKER_END);
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

  private readAutoNodeConfig(file: TFile): AutoNodeConfig | null {
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

    const form = contentEl.createEl("form");

    const heading = form.createEl("h2", { text: this.options.prompt });
    heading.style.marginBottom = "0.5rem";

    const input = form.createEl("input", {
      type: "text",
      placeholder: this.options.placeholder ?? "",
    });
    input.style.width = "100%";
    input.focus();

    const submit = form.createEl("button", {
      type: "submit",
      text: this.options.cta ?? "OK",
    });
    submit.style.marginTop = "0.75rem";

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

