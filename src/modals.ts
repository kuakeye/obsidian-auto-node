import { App, Modal, SuggestModal } from "obsidian";

/**
 * Small, reusable UI primitives used by the create/insert commands.
 * Kept simple on purpose — none of them own any plugin state.
 */

interface PromptOptions {
  prompt: string;
  placeholder?: string;
  initialValue?: string;
  cta?: string;
}

/** A single-input text prompt; resolves to the trimmed value or null on cancel. */
export class PromptModal extends Modal {
  private resolve!: (value: string | null) => void;
  private value: string | null = null;

  constructor(app: App, private readonly options: PromptOptions) {
    super(app);
  }

  static async ask(app: App, options: PromptOptions): Promise<string | null> {
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
      value: this.options.initialValue ?? "",
    });
    input.addClass("auto-node-prompt-input");
    input.focus();
    input.select();

    const submit = form.createEl("button", { type: "submit", text: this.options.cta ?? "OK" });
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

interface ConfirmOptions {
  prompt: string;
  description?: string;
  cta?: string;
}

export class ConfirmModal extends Modal {
  private resolve!: (value: boolean) => void;
  private value = false;

  constructor(app: App, private readonly options: ConfirmOptions) {
    super(app);
  }

  static async ask(app: App, options: ConfirmOptions): Promise<boolean> {
    const modal = new ConfirmModal(app, options);
    modal.open();
    return new Promise<boolean>((resolve) => {
      modal.resolve = resolve;
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("auto-node-confirm-modal");

    const form = contentEl.createEl("form");
    const heading = form.createEl("h2", { text: this.options.prompt });
    heading.addClass("auto-node-confirm-heading");

    if (this.options.description) {
      form.createEl("p", { text: this.options.description });
    }

    const buttonContainer = form.createDiv({ cls: "auto-node-confirm-buttons" });
    const confirmButton = buttonContainer.createEl("button", {
      type: "submit",
      text: this.options.cta ?? "Confirm",
    });
    confirmButton.addClass("mod-cta");

    const cancelButton = buttonContainer.createEl("button", { type: "button", text: "Cancel" });
    cancelButton.onclick = () => {
      this.value = false;
      this.close();
    };

    form.onsubmit = (event) => {
      event.preventDefault();
      this.value = true;
      this.close();
    };

    confirmButton.focus();
  }

  onClose() {
    this.contentEl.empty();
    this.resolve(this.value);
  }
}

/** An option shown in the ChoiceModal suggester. */
export interface Choice<T = string> {
  label: string;
  description?: string;
  value: T;
}

/** Suggester-based picker used wherever we need a predefined enum of options. */
export class ChoiceModal<T> extends SuggestModal<Choice<T>> {
  private resolveFn!: (value: T | null) => void;
  private picked: T | null = null;

  constructor(app: App, private readonly choices: Choice<T>[], placeholder: string) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  static async pick<T>(app: App, choices: Choice<T>[], placeholder: string): Promise<T | null> {
    const modal = new ChoiceModal<T>(app, choices, placeholder);
    modal.open();
    return new Promise<T | null>((resolve) => {
      modal.resolveFn = resolve;
    });
  }

  getSuggestions(query: string): Choice<T>[] {
    const q = query.toLowerCase();
    if (!q) return this.choices;
    return this.choices.filter(
      (c) => c.label.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q),
    );
  }

  renderSuggestion(choice: Choice<T>, el: HTMLElement): void {
    el.createEl("div", { text: choice.label, cls: "auto-node-choice-label" });
    if (choice.description) {
      el.createEl("small", { text: choice.description, cls: "auto-node-choice-desc" });
    }
  }

  onChooseSuggestion(choice: Choice<T>): void {
    this.picked = choice.value;
  }

  onClose(): void {
    this.resolveFn(this.picked);
  }
}
