import { ToggleComponent, WorkspaceLeaf } from "obsidian";
import type AutoNodePlugin from "./main";

/**
 * Adds a "Hide auto-nodes" toggle to each graph view's controls.
 * When on, injects a `-"<!-- auto-node:start -->"` clause into the graph's
 * search query so auto-nodes themselves disappear from the graph — useful
 * when MOCs otherwise dominate the visualization.
 */
export const AUTO_NODE_FILTER_CLAUSE = `-"<!-- auto-node:start -->"`;

export interface GraphView {
  containerEl?: HTMLElement;
  controls?: {
    searchComponent?: { inputEl?: HTMLInputElement };
    setQuery?: (value: string) => void;
  };
  searchComponent?: { inputEl?: HTMLInputElement };
  controlsFilter?: { textComponent?: { inputEl?: HTMLInputElement } };
  filterComponent?: { inputEl?: HTMLInputElement };
  setQuery?: (value: string) => void;
  render?: () => void;
}

export class GraphFilterControl {
  private settingEl?: HTMLElement;

  constructor(
    private readonly plugin: AutoNodePlugin,
    private readonly container: HTMLElement,
    private readonly leaf: WorkspaceLeaf,
  ) {}

  render() {
    let wrapper = this.container.querySelector<HTMLDivElement>(".auto-node-filter-wrapper");
    if (!wrapper) {
      wrapper = this.container.createDiv({
        cls: "auto-node-filter-wrapper setting-item setting-item--no-borders",
      });
    } else {
      wrapper.className = "auto-node-filter-wrapper setting-item setting-item--no-borders";
      wrapper.empty();
    }

    const info = wrapper.createDiv({ cls: "setting-item-info" });
    info.createEl("div", { cls: "setting-item-name", text: "Hide auto-nodes" });
    info.createEl("div", {
      cls: "setting-item-description",
      text: "Hide notes populated automatically by auto node from this graph.",
    });

    const control = wrapper.createDiv({ cls: "setting-item-control" });
    const toggle = new ToggleComponent(control);
    toggle.setValue(
      this.plugin.graphQueries.get(this.leaf)?.includes(AUTO_NODE_FILTER_CLAUSE) ??
        this.plugin.settings.graphFilterEnabled,
    );
    toggle.onChange((value) => {
      toggle.toggleEl.addClass("mod-warning");
      window.clearTimeout(this.plugin.activeGraphToggleAnimation);
      this.plugin.activeGraphToggleAnimation = window.setTimeout(() => {
        toggle.toggleEl.removeClass("mod-warning");
      }, 150);
      this.plugin.settings.graphFilterEnabled = value;
      void this.plugin.saveSettings();
      applyGraphFilter(this.plugin, this.leaf, value);
    });

    this.settingEl = wrapper;
    applyGraphFilter(this.plugin, this.leaf);
  }

  get isConnected(): boolean {
    return !!this.settingEl?.isConnected;
  }

  detach() {
    if (this.settingEl?.isConnected) this.settingEl.remove();
  }
}

export function applyGraphFilter(plugin: AutoNodePlugin, leaf: WorkspaceLeaf, explicit?: boolean) {
  const view = leaf.view as unknown as GraphView;
  const input: HTMLInputElement | null =
    view?.controls?.searchComponent?.inputEl ??
    view?.searchComponent?.inputEl ??
    view?.controlsFilter?.textComponent?.inputEl ??
    view?.filterComponent?.inputEl ??
    (leaf as unknown as { containerEl?: HTMLElement }).containerEl?.querySelector?.<HTMLInputElement>("input[type=search], input[type=text]") ??
    null;
  if (!input) return;

  const current = input.value ?? plugin.graphQueries.get(leaf) ?? "";
  const shouldEnable = explicit ?? plugin.settings.graphFilterEnabled;

  if (shouldEnable) {
    if (!current.includes(AUTO_NODE_FILTER_CLAUSE)) {
      const next = current.trim() ? `${current} ${AUTO_NODE_FILTER_CLAUSE}` : AUTO_NODE_FILTER_CLAUSE;
      setGraphQuery(plugin, leaf, view, input, next, shouldEnable);
    }
  } else if (current.includes(AUTO_NODE_FILTER_CLAUSE)) {
    const next = current.replace(AUTO_NODE_FILTER_CLAUSE, "").replace(/\s{2,}/g, " ").trim();
    setGraphQuery(plugin, leaf, view, input, next, shouldEnable);
  }
}

function setGraphQuery(
  plugin: AutoNodePlugin,
  leaf: WorkspaceLeaf,
  view: GraphView,
  input: HTMLInputElement,
  value: string,
  enabled: boolean,
) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));

  if (view?.controls?.setQuery) view.controls.setQuery(value);
  else if (view?.setQuery) view.setQuery(value);

  if (enabled) plugin.graphQueries.set(leaf, value);
  else plugin.graphQueries.delete(leaf);

  requestAnimationFrame(() => view?.render?.());
}
