import { h_flex, InputState, v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type FocusHandle, type KeyEvent } from "gpui-kit";
import { fileLanguage, readFiles } from "../git/files.ts";
import { lineNumbersText, openCopySelection, SelectionBlame } from "./changes/review.ts";
import { CodeView } from "./code-view.ts";
import { showResult } from "./commands/result.ts";
import { ImagePreview } from "./explorer/image.ts";
import { openLineHistory } from "./explorer/line-history.ts";
import { type FilePreview, previewNotice, readPreview } from "./explorer/preview.ts";
import {
  type ResultRow,
  rankPaths,
  resultRows,
  type SearchResult,
  sameResult,
  searchLines,
} from "./explorer/search.ts";
import { type PathRow, PathTree, pathStatuses, workingStatus } from "./explorer/tree.ts";
import type { AppShortcut, BodySize, RefreshScope, Services, TabStatus, TabView } from "./shell.ts";
import { type Color, cols, GLYPH, type Look, statusColor } from "./theme.ts";
import {
  box,
  countedTitle,
  displayWidth,
  filterBar,
  isChord,
  ListViewport,
  scrollbar,
  sectionLabel,
  viewportOffset,
} from "./widgets.ts";
import type { WorkspacesBox } from "./workspaces.ts";

type Pane = "explorer" | "preview";

const SEARCH_DEBOUNCE_MS = 120;
const LIST_HORIZONTAL_STEP = 1;

interface Filter {
  results: SearchResult[];
  cursor: number;
  scroll: number;
  height: number;
  searching: boolean;
  error: string | null;
}

function emptyFilter(): Filter {
  return { results: [], cursor: 0, scroll: 0, height: 1, searching: false, error: null };
}

export class FilesTab implements TabView {
  readonly id = "files";
  private active = false;
  private pane: Pane = "explorer";
  private root: string | null = null;
  private files: string[] | null = null;
  private tree: PathTree | null = null;
  private rows: PathRow[] = [];
  private expanded = new Set<string>();
  private error: string | null = null;
  private listRequest = 0;
  private readonly list = new ListViewport("git-files-tree");
  private horizontal = 0;
  private treeColumns = 0;
  private previewFile: string | null = null;
  private loadingFile: string | null = null;
  private preview: FilePreview = previewNotice("");
  private previewRequest = 0;
  private readonly image = new ImagePreview();
  private reveal = false;
  private readonly code = new CodeView("git-files-preview");
  private readonly query: InputState;
  private filtering = false;
  private filter = emptyFilter();
  private searchRequest = 0;
  private readonly blame = new SelectionBlame();
  private readonly treeHandle: FocusHandle;
  private readonly previewHandle: FocusHandle;
  private size: BodySize = { width: 0, height: 0, cols: 120, rows: 40, wide: true };

  constructor(
    private readonly services: Services,
    private readonly workspaces: WorkspacesBox,
    cx: AsyncContext,
  ) {
    this.treeHandle = cx.focus_handle();
    this.previewHandle = cx.focus_handle();
    this.query = InputState.new({ placeholder: "" });
    this.query.on("focus", (_, cx) => {
      this.filtering = true;
      cx.notify();
    });
    this.query.on("blur", (_, cx) => {
      this.filtering = false;
      cx.notify();
    });
    this.query.on("change", (_, cx) => this.editFilter(cx));
    this.query.on("submit", (_, cx) => {
      this.closeFilter();
      cx.notify();
    });
  }

  activate(cx: AsyncContext): void {
    this.active = true;
    this.requestFiles(cx);
  }

  deactivate(_cx: AsyncContext): void {
    this.active = false;
    this.listRequest++;
    this.previewRequest++;
    this.loadingFile = null;
    if (this.preview.image) this.clearPreview();
    if (this.filtering) this.closeFilter();
  }

  focus(): void {
    this.setPane(this.pane);
  }

  release(): void {
    this.image.clear();
    this.active = false;
    this.listRequest++;
    this.previewRequest++;
    this.searchRequest++;
    this.query.release();
    this.treeHandle.release();
    this.previewHandle.release();
    this.code.release();
    this.blame.reset();
  }

  shortcut(shortcut: AppShortcut): boolean {
    if (shortcut !== "files-search") return false;
    this.openFilter();
    return true;
  }

  escape(cx: Context): boolean {
    if (this.workspaces.isFocused() || this.pane === "preview") {
      this.setPane("explorer");
      return true;
    }
    if (!this.applied()) return false;
    this.clearFilter(cx);
    return true;
  }

  status(): TabStatus {
    return { blame: this.blame.status() };
  }

  refresh(scope: RefreshScope, cx: AsyncContext): void {
    if (scope === "repository" && this.root !== this.repositoryRoot()) this.reset(cx);
    if (this.active && (scope === "changes" || scope === "repository")) this.requestFiles(cx);
  }

  private repositoryRoot(): string | null {
    const repository = this.services.repository();
    return repository?.state === "ready" ? repository.root : null;
  }

  private paneFocused(pane: Pane): boolean {
    return this.pane === pane && !this.filtering && !this.workspaces.isFocused();
  }

  private reset(cx: AsyncContext): void {
    this.image.clear();
    this.listRequest++;
    this.previewRequest++;
    this.searchRequest++;
    this.root = this.repositoryRoot();
    this.files = null;
    this.tree = null;
    this.rows = [];
    this.expanded.clear();
    this.error = null;
    this.list.reset();
    this.horizontal = 0;
    this.previewFile = null;
    this.loadingFile = null;
    this.preview = previewNotice("");
    this.code.set([], "text");
    this.code.clearSelection();
    this.filter = emptyFilter();
    this.query.set_value("");
    this.blame.sync(this.services, null, cx);
  }

  private setPane(pane: Pane): void {
    this.pane = pane;
    (pane === "explorer" ? this.treeHandle : this.previewHandle).focus();
  }

  private applied(): boolean {
    return this.query.value().trim() !== "";
  }

  private selectedRow(): PathRow | null {
    return this.rows[this.list.selected] ?? null;
  }

  private selectedFile(): string | null {
    const row = this.selectedRow();
    return row && !row.directory ? row.path : null;
  }

  private activeResult(): SearchResult | null {
    return this.applied() ? (this.filter.results[this.filter.cursor] ?? null) : null;
  }

  private activeFile(): string | null {
    return this.applied() ? (this.activeResult()?.path ?? null) : this.selectedFile();
  }

  private previewPath(): string | null {
    const file = this.previewFile;
    return file !== null && file === this.activeFile() ? file : null;
  }

  private requestFiles(cx: AsyncContext): void {
    if (this.root !== this.repositoryRoot()) this.reset(cx);
    const git = this.services.git();
    const root = this.root;
    if (!git || !root) return;
    const request = ++this.listRequest;
    cx.spawn(async (cx) => {
      try {
        const files = await readFiles(git);
        if (request !== this.listRequest || root !== this.root) return;
        this.files = files;
        this.tree = new PathTree(files);
        this.error = null;
        this.rebuildRows();
        this.reloadSelectedPreview(cx);
      } catch (error) {
        if (request === this.listRequest) this.error = error instanceof Error ? error.message : String(error);
      } finally {
        cx.notify();
      }
    });
  }

  private rebuildRows(): void {
    const selected = this.selectedRow()?.path;
    this.rows = this.tree?.rows(this.expanded) ?? [];
    const position = this.rows.findIndex((row) => row.path === selected);
    this.list.selected = position >= 0 ? position : Math.min(this.list.selected, Math.max(0, this.rows.length - 1));
  }

  private reloadSelectedPreview(cx: AsyncContext): void {
    const file = this.applied() ? this.activeFile() : this.selectedFile();
    if (file) this.requestPreview(file, cx);
    else this.clearPreview();
  }

  private clearPreview(): void {
    this.image.clear();
    this.previewRequest++;
    this.loadingFile = null;
    this.previewFile = null;
    this.preview = previewNotice("");
    this.code.clearSelection();
  }

  private newFile(file: string): boolean {
    const repository = this.services.repository();
    if (repository?.state !== "ready") return false;
    const change = repository.files.find((entry) => entry.path === file);
    if (!change) return false;
    const status = workingStatus(change);
    return status === "?" || status === "A";
  }

  private requestPreview(file: string, cx: AsyncContext): void {
    const git = this.services.git();
    const root = this.root;
    if (!this.active || !git || !root) return;
    if (this.previewFile !== file) {
      this.image.clear();
      this.previewFile = null;
      this.preview = previewNotice("");
      this.code.clearSelection();
    }
    const request = ++this.previewRequest;
    this.loadingFile = file;
    const context = this.services.context();
    const on = this.services.location()?.on ?? null;
    const newFile = this.newFile(file);
    cx.spawn(async (cx) => {
      const current = () =>
        this.active &&
        request === this.previewRequest &&
        context === this.services.context() &&
        this.activeFile() === file;
      let preview = await readPreview(git, root, on, file, newFile);
      if (!current()) return;
      if (preview.image) {
        try {
          await this.image.load(preview.image, current, cx);
        } catch (error) {
          preview = previewNotice(error instanceof Error ? error.message : String(error));
        }
      }
      if (!current()) return;
      if (!preview.image) this.image.clear();
      this.loadingFile = null;
      this.previewFile = file;
      this.preview = preview;
      this.code.set(preview.lines, fileLanguage(file));
      cx.notify();
    });
  }

  private showPreview(file: string, cx: AsyncContext): void {
    if (this.previewFile === file || this.loadingFile === file) return;
    this.requestPreview(file, cx);
  }

  private selectRow(index: number, cx: AsyncContext): void {
    if (!this.rows.length) return;
    this.list.selected = Math.max(0, Math.min(index, this.rows.length - 1));
    const file = this.selectedFile();
    if (file) this.showPreview(file, cx);
    else this.clearPreview();
  }

  private setDirectory(path: string, expanded: boolean): void {
    if (expanded) this.expanded.add(path);
    else this.expanded.delete(path);
    this.rebuildRows();
  }

  private expandOrEnter(cx: AsyncContext): void {
    const row = this.selectedRow();
    if (!row) return;
    if (!row.directory) this.setPane("preview");
    else if (!row.expanded) this.setDirectory(row.path, true);
    else this.selectRow(this.list.selected + 1, cx);
  }

  private collapseOrLeave(cx: AsyncContext): void {
    const row = this.selectedRow();
    if (!row) return;
    if (row.directory && row.expanded) {
      this.setDirectory(row.path, false);
      return;
    }
    for (let index = this.list.selected - 1; index >= 0; index--)
      if (this.rows[index]?.depth === row.depth - 1) {
        this.selectRow(index, cx);
        return;
      }
  }

  private activateRow(): void {
    const row = this.selectedRow();
    if (row?.directory) this.setDirectory(row.path, !row.expanded);
    else if (row) this.setPane("preview");
  }

  private openFilter(): void {
    if (!this.repositoryRoot()) return;
    this.query.focus();
  }

  private closeFilter(): void {
    this.filtering = false;
    this.setPane("explorer");
  }

  private clearFilter(cx: AsyncContext): void {
    this.searchRequest++;
    this.filter = emptyFilter();
    this.reveal = false;
    if (this.query.value()) this.query.set_value("");
    this.closeFilter();
    const file = this.selectedFile();
    if (file) this.showPreview(file, cx);
    else this.clearPreview();
  }

  private editFilter(cx: AsyncContext): void {
    if (!this.applied()) {
      this.searchRequest++;
      this.filter = emptyFilter();
      this.reveal = false;
      const file = this.selectedFile();
      if (file) this.showPreview(file, cx);
      else this.clearPreview();
      cx.notify();
      return;
    }
    const request = ++this.searchRequest;
    this.filter.cursor = 0;
    this.filter.searching = true;
    this.showSelectedResult(cx);
    cx.timer.after(SEARCH_DEBOUNCE_MS, (cx) => {
      if (request === this.searchRequest) this.search(request, cx);
    });
    cx.notify();
  }

  private applyResults(results: SearchResult[], done: boolean, cx: AsyncContext): void {
    const selected = this.filter.results[this.filter.cursor];
    const position = selected ? results.findIndex((result) => sameResult(result, selected)) : -1;
    this.filter.results = results;
    this.filter.searching = !done;
    this.filter.cursor = position >= 0 ? position : Math.min(this.filter.cursor, Math.max(0, results.length - 1));
    this.showSelectedResult(cx);
  }

  private search(request: number, cx: AsyncContext): void {
    const git = this.services.git();
    const query = this.query.value();
    if (!git || !this.root) {
      this.filter.searching = false;
      return;
    }
    const root = this.root;
    const current = () => request === this.searchRequest && root === this.root;
    cx.spawn(async (cx) => {
      try {
        const paths = rankPaths(this.files ?? (await readFiles(git)), query);
        if (!current()) return;
        this.applyResults(paths, false, cx);
        cx.notify();
        const lines = await searchLines(git, query);
        if (!current()) return;
        this.filter.error = null;
        this.applyResults([...paths, ...lines], true, cx);
      } catch (error) {
        if (!current()) return;
        this.filter.error = error instanceof Error ? error.message : String(error);
        this.filter.searching = false;
      } finally {
        cx.notify();
      }
    });
  }

  private showSelectedResult(cx: AsyncContext): void {
    const result = this.filter.results[this.filter.cursor];
    if (!result) {
      this.clearPreview();
      return;
    }
    this.reveal = result.line !== null;
    this.showPreview(result.path, cx);
  }

  private moveResult(delta: number, cx: AsyncContext): void {
    const last = Math.max(0, this.filter.results.length - 1);
    this.filter.cursor = Math.max(0, Math.min(last, this.filter.cursor + delta));
    this.showSelectedResult(cx);
  }

  private resultStep(keystroke: string): number | null {
    const page = Math.max(1, this.filter.height);
    const steps: Record<string, number> = {
      down: 1,
      j: 1,
      up: -1,
      k: -1,
      pagedown: page,
      pageup: -page,
      home: -Number.MAX_SAFE_INTEGER,
      end: Number.MAX_SAFE_INTEGER,
    };
    return steps[keystroke] ?? null;
  }

  private filterInputKey(event: KeyEvent, cx: Context): void {
    if (isChord(event)) return;
    const step = ["down", "up", "pagedown", "pageup"].includes(event.keystroke)
      ? this.resultStep(event.keystroke)
      : null;
    if (event.keystroke === "escape") this.clearFilter(cx);
    else if (event.keystroke === "enter") this.closeFilter();
    else if (step !== null) this.moveResult(step, cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  private resultsKey(event: KeyEvent, cx: Context): boolean {
    const step = this.resultStep(event.keystroke);
    if (step !== null) this.moveResult(step, cx);
    else if (event.keystroke === "enter" && this.activeFile()) this.setPane("preview");
    else if (event.keystroke === "escape") this.clearFilter(cx);
    else return false;
    return true;
  }

  private treeAction(event: KeyEvent, cx: Context): boolean {
    const row = this.selectedRow();
    switch (event.keystroke) {
      case "right":
        this.expandOrEnter(cx);
        return true;
      case "left":
        this.collapseOrLeave(cx);
        return true;
      case "space":
        if (row?.directory) this.setDirectory(row.path, !row.expanded);
        return true;
      default:
        return false;
    }
  }

  private explorerKey(event: KeyEvent, cx: Context): void {
    if (isChord(event)) return;
    let handled: boolean;
    if (event.keystroke === "/") {
      this.openFilter();
      handled = true;
    } else if (this.applied()) handled = this.resultsKey(event, cx);
    else if (this.treeAction(event, cx)) handled = true;
    else {
      const outcome = event.keystroke === "escape" ? null : this.list.key(event, this.rows.length);
      if (outcome === "moved") this.selectRow(this.list.selected, cx);
      else if (outcome === "activate") this.activateRow();
      handled = outcome !== null;
    }
    if (!handled) return;
    cx.stop_propagation();
    cx.notify();
  }

  private selectionLines(): { rows: number[]; lines: number[] } | null {
    const range = this.code.selection();
    if (!range || !this.previewPath()) return null;
    const lines = this.code.lines();
    const rows: number[] = [];
    for (let row = range.start; row <= range.end; row++) if (lines[row]?.number != null) rows.push(row);
    const numbers = rows.map((row) => lines[row]?.number ?? 0);
    return numbers.length ? { rows, lines: numbers } : null;
  }

  private copySelection(): boolean {
    const path = this.previewPath();
    const selection = this.selectionLines();
    if (!path || !selection) return false;
    const lines = this.code.lines();
    openCopySelection(
      this.services,
      {
        path,
        side: null,
        lines: selection.lines,
        code: selection.rows.map((row) => lines[row]?.text ?? ""),
      },
      () => this.code.clearSelection(),
    );
    return true;
  }

  private lineHistory(cx: AsyncContext): void {
    const path = this.previewPath();
    const selection = this.selectionLines();
    const range = this.code.selection();
    if (!path || !selection || !range) return;
    const ranges: [number, number][] = [];
    for (let row = range.start; row <= range.end; row++) {
      const line = this.preview.before[row];
      if (line == null) continue;
      const last = ranges.at(-1);
      if (last && last[1] + 1 === line) last[1] = line;
      else ranges.push([line, line]);
    }
    if (!ranges.length) {
      showResult(this.services.overlay, "Action", false, "Select committed lines to see their history.", undefined, cx);
      return;
    }
    const name = path.split("/").pop() ?? path;
    openLineHistory(
      this.services,
      `${name}:${lineNumbersText(selection.lines)}`,
      { file: path, ranges, revision: null },
      { cols: this.size.cols, rows: this.size.rows + 10 },
      cx,
    );
  }

  private previewKey(event: KeyEvent, cx: Context): void {
    if (isChord(event)) return;
    let handled = true;
    if (event.keystroke === "/") this.openFilter();
    else if (event.keystroke === "y") handled = this.copySelection();
    else if (event.keystroke === "h" && this.code.selection()) this.lineHistory(cx);
    else handled = this.code.key(event, cx);
    if (!handled) return;
    cx.stop_propagation();
    cx.notify();
  }

  private syncBlame(cx: AsyncContext): void {
    const path = this.previewPath();
    const selection = this.selectionLines();
    this.blame.sync(
      this.services,
      path && selection ? { file: path, lines: selection.lines, revision: null } : null,
      cx,
    );
  }

  private message(text: string, color: Color): Element {
    return div().flex_1().min_h(0).text_color(color).whitespace_normal().child(text);
  }

  private treeMessage(look: Look): Element | null {
    const { t } = look;
    if (!this.repositoryRoot()) return this.message("Not a Git repository", t.warning);
    if (this.error) return this.message(this.error, t.error);
    if (!this.files) return this.message("Loading files…", t.hint);
    if (!this.rows.length) return this.message("No files", t.hint);
    return null;
  }

  private treeLine(look: Look, row: PathRow, status: string | undefined): Element {
    const { t } = look;
    const indent = "  ".repeat(row.depth);
    const marker = row.directory
      ? div()
          .text_color(t.hint)
          .child(`${indent}${row.expanded ? GLYPH.expanded : GLYPH.collapsed} `)
      : status
        ? div().text_color(statusColor(t, status)).font_weight(700).child(`${indent}${status[0]} `)
        : div().child(`${indent}  `);
    return h_flex()
      .flex_none()
      .ml(-cols(look, this.horizontal))
      .child(marker)
      .child(
        div()
          .text_color(status ? statusColor(t, status) : t.text)
          .child(row.label),
      );
  }

  private maxHorizontal(): number {
    const width = this.applied()
      ? Math.max(0, ...this.filter.results.map((result) => displayWidth(resultText(result))))
      : Math.max(0, ...this.rows.map((row) => row.depth * 2 + 2 + displayWidth(row.label)));
    return Math.max(0, width - Math.max(0, this.treeColumns - 2));
  }

  private scrollHorizontal(delta: number): void {
    this.horizontal = Math.max(0, Math.min(this.maxHorizontal(), this.horizontal + delta));
  }

  private treeFrame(look: Look, id: string, title: string | Element, body: Element): Element {
    return box(
      look,
      { id, title, focused: this.paneFocused("explorer") },
      v_flex()
        .id(`${id}-body`)
        .flex_1()
        .min_h(0)
        .min_w(0)
        .track_focus(this.treeHandle)
        .on_key_down((event, cx) => this.explorerKey(event, cx))
        .on_mouse_down("left", (_, cx) => {
          this.setPane("explorer");
          cx.notify();
        })
        .on_size_change((size, cx) => {
          const columns = Math.floor(size.width / look.screenCell);
          if (columns === this.treeColumns) return;
          this.treeColumns = columns;
          cx.notify();
        })
        .on_scroll_wheel((event, cx) => {
          const delta = event.delta_lines ? event.delta_lines.x : event.delta.x / look.cell;
          const steps = Math.trunc(delta);
          if (!steps) return;
          cx.stop_propagation();
          this.scrollHorizontal(-steps * LIST_HORIZONTAL_STEP);
          cx.notify();
        })
        .child(body),
    ).flex_1();
  }

  private treeBox(look: Look): Element {
    this.horizontal = Math.min(this.horizontal, this.maxHorizontal());
    const title = countedTitle("Files", this.files?.length ?? 0);
    const message = this.treeMessage(look);
    if (message) return this.treeFrame(look, "git-files-tree-box", title, message);
    const repository = this.services.repository();
    const statuses = pathStatuses(repository?.state === "ready" ? repository.files : []);
    const list = this.list.render(look, {
      length: this.rows.length,
      focused: true,
      row: ({ index }) => {
        const row = this.rows[index];
        return row ? this.treeLine(look, row, statuses.get(row.path)) : div();
      },
      onSelect: (index, cx) => {
        this.setPane("explorer");
        this.selectRow(index, cx);
      },
      onActivate: () => {
        const row = this.selectedRow();
        if (row?.directory) this.setDirectory(row.path, !row.expanded);
      },
    });
    return this.treeFrame(look, "git-files-tree-box", title, list);
  }

  private resultsMessage(look: Look): Element | null {
    const { t } = look;
    if (this.filter.error) return this.message(this.filter.error, t.error);
    if (!this.filter.results.length && this.filter.searching) return this.message("Searching…", t.hint);
    if (!this.filter.results.length) return this.message("No matches", t.hint);
    return null;
  }

  private resultRow(look: Look, row: ResultRow, offset: number): Element {
    const { t } = look;
    const element = h_flex()
      .id(`git-files-match-${offset}`)
      .flex_none()
      .h(look.row)
      .min_w(0)
      .whitespace_nowrap()
      .overflow_hidden();
    if (row.kind === "group")
      return element.px(4).child(sectionLabel(look, countedTitle(row.label, row.count), { rule: true }));
    const result = this.filter.results[row.index];
    const selected = row.index === this.filter.cursor;
    return element
      .border_l(2)
      .border_color(selected ? t.accent : "#00000000")
      .when(selected, (el) => el.bg(t.accentSoft).font_weight(600))
      .hover((style) => style.bg(selected ? t.accentSoft : t.hover))
      .child(
        div()
          .flex_none()
          .w(cols(look, 2))
          .text_color(selected ? t.accentText : t.hint)
          .child(selected ? GLYPH.marker : ""),
      )
      .child(
        h_flex()
          .ml(-cols(look, this.horizontal))
          .child(
            div()
              .text_color(t.text)
              .child(`  ${result?.path ?? ""}`),
          )
          .when(result?.line != null, (el) => el.child(div().text_color(t.hint).child(`:${result?.line}`))),
      )
      .on_click((_, cx) => {
        cx.stop_propagation();
        this.setPane("explorer");
        this.filter.cursor = row.index;
        this.showSelectedResult(cx);
        cx.notify();
      });
  }

  private resultsBody(look: Look): Element {
    const filter = this.filter;
    const all = resultRows(filter.results);
    const selectedRow = Math.max(
      0,
      all.findIndex((row) => row.kind === "result" && row.index === filter.cursor),
    );
    let offset = viewportOffset(filter.scroll, selectedRow, all.length, filter.height);
    if (offset === selectedRow && offset > 0 && all[offset - 1]?.kind === "group") offset--;
    filter.scroll = offset;
    const visible = v_flex().flex_1().min_w(0).min_h(0).overflow_hidden();
    all.slice(offset, offset + filter.height).forEach((row, index) => {
      visible.child(this.resultRow(look, row, offset + index));
    });
    const bar = scrollbar(look, { axis: "vertical", total: all.length, visible: filter.height, offset });
    return h_flex()
      .id("git-files-matches")
      .flex_1()
      .min_h(0)
      .min_w(0)
      .items_stretch()
      .on_size_change((size, cx) => {
        const height = Math.max(1, Math.floor(size.height / look.screenRow));
        if (height === filter.height) return;
        filter.height = height;
        cx.notify();
      })
      .on_scroll_wheel((event, cx) => {
        const steps = Math.trunc(event.delta_lines ? event.delta_lines.y : event.delta.y / look.row);
        if (!steps) return;
        cx.stop_propagation();
        this.setPane("explorer");
        this.moveResult(-steps, cx);
        cx.notify();
      })
      .child(visible)
      .when(!!bar, (el) => el.child(bar ?? div()));
  }

  private resultsBox(look: Look): Element {
    this.horizontal = Math.min(this.horizontal, this.maxHorizontal());
    let title = countedTitle("Matches", this.filter.results.length);
    if (this.filter.searching) title += `${GLYPH.separator}Searching…`;
    return this.treeFrame(look, "git-files-matches-box", title, this.resultsMessage(look) ?? this.resultsBody(look));
  }

  private previewTitle(look: Look): string | Element {
    const selection = this.selectionLines();
    const path = this.previewPath();
    if (selection && path) {
      const name = path.split("/").pop() ?? path;
      return div()
        .text_color(look.t.accent)
        .font_weight(700)
        .child(`${name}:${lineNumbersText(selection.lines)}`);
    }
    return this.activeFile() ?? "Preview";
  }

  private matchTarget(): { row: number; start: number; end: number } | null {
    const result = this.activeResult();
    if (result?.type !== "content" || result.line === null || !result.range) return null;
    const row = this.code.lines().findIndex((line) => line.number === result.line);
    return row < 0 ? null : { row, start: result.range[0], end: result.range[1] };
  }

  private previewBody(look: Look): Element {
    const { t } = look;
    if (!this.previewPath())
      return this.message(this.activeFile() ? "Loading…" : "Select a file to preview it", t.hint);
    if (this.preview.image) return this.image.render();
    if (this.preview.notice) return this.message(this.preview.notice, t.hint);
    const match = this.matchTarget();
    if (this.reveal && match) {
      this.reveal = false;
      this.code.reveal(match.row);
    }
    return this.code.render(look, {
      focused: this.paneFocused("preview"),
      match: match ?? undefined,
      hint: !this.services.overlay.isOpen(),
    });
  }

  private previewBox(look: Look): Element {
    return box(
      look,
      { id: "git-files-preview-box", title: this.previewTitle(look), focused: this.paneFocused("preview") },
      v_flex()
        .id("git-files-preview-body")
        .flex_1()
        .min_h(0)
        .min_w(0)
        .track_focus(this.previewHandle)
        .on_key_down((event, cx) => this.previewKey(event, cx))
        .on_mouse_down("left", (_, cx) => {
          this.setPane("preview");
          cx.notify();
        })
        .child(this.previewBody(look)),
    ).flex_1();
  }

  render(look: Look, size: BodySize, cx: Context): Element {
    this.size = size;
    if (this.active && this.root !== this.repositoryRoot()) this.requestFiles(cx);
    this.syncBlame(cx);
    const left = v_flex()
      .flex_1()
      .min_h(0)
      .min_w(0)
      .gap(6)
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .child(this.applied() ? this.resultsBox(look) : this.treeBox(look)),
      )
      .child(v_flex().flex_1().min_h(0).child(this.workspaces.render(look).flex_1()));
    const preview = v_flex().min_h(0).min_w(0).child(this.previewBox(look));
    const panes = size.wide
      ? h_flex()
          .flex_1()
          .min_h(0)
          .gap(6)
          .items_stretch()
          .child(left.flex_none().w(`${35}%`))
          .child(preview.flex_1().h_full())
      : v_flex()
          .flex_1()
          .min_h(0)
          .gap(6)
          .child(left.h(`${50}%`).flex_none())
          .child(preview.flex_1());
    return v_flex()
      .size_full()
      .min_h(0)
      .min_w(0)
      .gap(6)
      .child(
        div()
          .flex_none()
          .on_key_down((event, cx) => this.filterInputKey(event, cx))
          .on_mouse_down("left", (_, cx) => {
            this.openFilter();
            cx.notify();
          })
          .child(filterBar(look, { id: "git-files-filter", input: this.query, active: this.filtering })),
      )
      .child(panes);
  }
}

function resultText(result: SearchResult): string {
  return `  ${result.path}${result.line === null ? "" : `:${result.line}`}`;
}
