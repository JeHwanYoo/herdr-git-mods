import { h_flex, v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type FocusHandle, type KeyEvent } from "gpui-kit";
import {
  type ChangeSection,
  type ComparisonMode,
  type DiffSummary,
  type DiffTarget,
  readChanges,
  sectionTarget,
  type WorkingChange,
} from "../git/comparison.ts";
import { blameRevision, readBlameRange, readTargetDiff } from "../git/diff.ts";
import { runStaging, type StagingOperation, stagingLabel, stagingMessage, stagingPreview } from "../git/staging.ts";
import { openCompareDialog } from "./changes/compare.ts";
import { FilesPane } from "./changes/files-pane.ts";
import { lineNumbersText, openCopySelection, SelectionBlame } from "./changes/review.ts";
import { type TreeRow, treeRows } from "./changes/tree.ts";
import { type ReviewSide, SplitDiff } from "./code-view.ts";
import { showResult } from "./commands/result.ts";
import { openLineHistory } from "./explorer/line-history.ts";
import type { PickerRow } from "./overlay.ts";
import type { AppShortcut, BodySize, RefreshScope, Services, TabStatus, TabView } from "./shell.ts";
import { cols, DIALOG, GLYPH, type Look, rows } from "./theme.ts";
import { type ActionCell, box, isChord } from "./widgets.ts";
import type { WorkspacesBox } from "./workspaces.ts";

type Focus = "files" | "diff";

interface FocusedBlame {
  line: number;
  text: string | null;
  error: string | null;
}

const SPLIT_SCALE = 1000;
const MIN_FILES = 20;
const MIN_DIFF = 24;
const HOVER_BLAME_MS = 100;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function changesPaneWidths(total: number, splits: [number, number]): [number, number, number] {
  if (total < MIN_FILES + MIN_DIFF * 2) {
    const files = Math.floor(total / 5);
    const before = Math.floor((total * 2) / 5);
    return [files, before, total - files - before];
  }
  const scaled = (split: number) => Math.floor((total * split) / SPLIT_SCALE);
  const first = Math.max(MIN_FILES, Math.min(scaled(splits[0]), total - MIN_DIFF * 2));
  const second = Math.max(first + MIN_DIFF, Math.min(scaled(splits[1]), total - MIN_DIFF));
  return [first, second - first, total - second];
}

function filterTree(all: TreeRow[], changes: readonly WorkingChange[], query: string): TreeRow[] {
  if (!query) return all;
  const keep = new Set<number>();
  for (const [index, row] of all.entries()) {
    if (row.kind !== "file" || !changes[row.change]?.path.toLowerCase().includes(query)) continue;
    keep.add(index);
    let depth = row.depth;
    for (let ancestor = index - 1; ancestor >= 0 && depth > 0; ancestor--) {
      const parent = all[ancestor];
      if (!parent || parent.depth >= depth) continue;
      depth = parent.depth;
      keep.add(ancestor);
    }
  }
  return all.filter((_, index) => keep.has(index));
}

function blameText(line: number, sha: string, author: string, summary: string): string {
  if (/^0+$/.test(sha)) return `Line ${line} · Uncommitted · ${author} · Working tree change`;
  return `Line ${line} · ${sha.slice(0, 8)} · ${author} · ${summary}`;
}

export class ChangesTab implements TabView {
  readonly id = "changes";
  private active = false;
  private seen: string | null = null;
  private mode: ComparisonMode = { kind: "last" };
  private compareBase = "HEAD";
  private compareTarget = "";
  private changes: WorkingChange[] = [];
  private summaries: Partial<Record<ChangeSection, DiffSummary>> = {};
  private titles: Record<string, string> = {};
  private comparison: DiffTarget | null = null;
  private target: DiffTarget = { kind: "working-index" };
  private selectedChange = 0;
  private progress: string | null = null;
  private pendingResult: { name: string; success: boolean; message: string; preview?: string } | null = null;
  private changesRequest = 0;
  private diffRequest = 0;
  private focusAfterLoad = false;
  private error: string | null = null;
  private focused: Focus = "files";
  private readonly diff = new SplitDiff("git-changes-diff");
  private readonly files: FilesPane;
  private readonly diffHandle: FocusHandle;
  private readonly selectionBlame = new SelectionBlame();
  private blame: FocusedBlame | null = null;
  private blameLoading = false;
  private blameRequest = 0;
  private hoverRequest = 0;
  private splits: [number, number] = [200, 600];
  private divider: 0 | 1 | null = null;
  private hoveredDivider: 0 | 1 | null = null;
  private size: BodySize = { width: 0, height: 0, cols: 0, rows: 0, wide: true };
  private hints = false;
  private stagingOwner: string | null = null;

  constructor(
    private readonly services: Services,
    private readonly workspaces: WorkspacesBox,
    cx: AsyncContext,
  ) {
    this.diffHandle = cx.focus_handle();
    this.files = new FilesPane(
      {
        changes: () => this.changes,
        summaries: () => this.summaries,
        select: (change, cx) => this.selectChange(change, cx),
        activate: (change, cx) => this.activateChange(change, cx),
        focus: () => this.setFocus("files"),
        stage: (operation, owner, cx) => this.stage(operation, owner, cx),
        discard: (paths, cx) => this.confirmDiscard(paths, cx),
        error: (message) => this.services.reportError(message),
        clearDiffSelection: () => this.diff.clearSelection(),
      },
      cx.focus_handle(),
    );
  }

  activate(cx: AsyncContext): void {
    this.active = true;
    this.focused = "files";
    this.loadChanges(cx);
  }

  deactivate(): void {
    this.active = false;
  }

  focus(): void {
    this.setFocus(this.focused);
  }

  focusCommit(): void {
    this.setFocus("files");
  }

  release(): void {
    this.active = false;
    this.changesRequest++;
    this.diffRequest++;
    this.blameRequest++;
    this.selectionBlame.reset();
    this.diff.release();
    this.diffHandle.release();
    this.files.handle.release();
  }

  private setFocus(focus: Focus): void {
    this.focused = focus;
    if (focus === "files") this.files.handle.focus();
    else this.diffHandle.focus();
  }

  showCommit(sha: string, cx: AsyncContext): void {
    this.mode = { kind: "commit", sha };
    this.resetView();
    this.progress = "Loading commit diff";
    this.loadChanges(cx);
  }

  private resetView(): void {
    this.files.replaced();
    this.diff.detach();
    this.diff.clearSelection();
    this.selectedChange = 0;
    this.blame = null;
  }

  escape(): boolean {
    if (this.workspaces.isFocused() || this.focused === "diff") {
      this.setFocus("files");
      return true;
    }
    return this.files.escape();
  }

  shortcut(shortcut: AppShortcut, cx: Context): boolean {
    if (shortcut !== "files-search") return false;
    this.openFilesSearch(cx);
    return true;
  }

  toolbar(_look: Look, hints: boolean): ActionCell[] {
    this.hints = hints;
    const between = this.mode.kind === "between";
    const compact = this.size.cols > 0 && Math.floor(this.size.cols / 6) < "Diff Last".length + 4;
    return [
      {
        id: "git-diff-last",
        label: compact ? "Last" : "Diff Last",
        shortcut: "d",
        icon: between ? GLYPH.radioOff : GLYPH.radioOn,
        enabled: true,
        selected: !between,
        onClick: (cx) => this.selectComparison(0, cx),
      },
      {
        id: "git-compare",
        label: "Compare",
        shortcut: "m",
        icon: between ? GLYPH.radioOn : GLYPH.radioOff,
        enabled: true,
        selected: between,
        onClick: (cx) => this.selectComparison(1, cx),
      },
    ];
  }

  private selectComparison(index: number, cx: Context): void {
    if (this.services.repository()?.state !== "ready") return;
    if (index === 1) {
      openCompareDialog(
        this.services,
        this.compareBase,
        this.compareTarget,
        (base, compare, cx) => {
          this.compareBase = base;
          this.compareTarget = compare;
          this.mode = { kind: "between", base, compare };
          this.refreshComparison(cx);
        },
        cx,
      );
      return;
    }
    this.mode = { kind: "last" };
    this.refreshComparison(cx);
  }

  private refreshComparison(cx: AsyncContext): void {
    this.diff.clearSelection();
    this.diff.detach();
    this.diffRequest++;
    this.progress = "Loading changes";
    this.loadChanges(cx);
  }

  private hasChanges(): boolean {
    const repository = this.services.repository();
    return repository?.state === "ready" && repository.files.length > 0;
  }

  private endpoint(sha: string): [string, string] {
    return [sha.slice(0, 7), this.titles[sha] ?? ""];
  }

  private endpoints(): [string, [string, string]] {
    const target = this.target;
    if (target.kind === "commit")
      return [target.parent ? target.parent.slice(0, 7) : "Empty", this.endpoint(target.commit)];
    if (target.kind === "working-index") return ["Index", ["Working Tree", ""]];
    const head = this.services.facts().head;
    return [head ? head.slice(0, 7) : "Empty", ["Index", ""]];
  }

  info(look: Look): Element | null {
    const { t } = look;
    if (this.target.kind === "working-index" && !this.hasChanges()) return div().text_color(t.hint).child("—");
    const [before, [after, title]] = this.endpoints();
    const suffix = this.target.kind !== "commit" ? " (Uncommitted)" : this.hasChanges() ? " · Uncommitted" : "";
    return h_flex()
      .whitespace_nowrap()
      .overflow_hidden()
      .child(div().text_color(t.secondary).child(`${before} → ${after}`))
      .when(!!title, (el) => el.child(div().text_color(t.text).child(` ${title}`)))
      .child(div().text_color(t.warning).child(suffix));
  }

  private focusedBlameText(): string | null {
    if (this.focused !== "diff") return null;
    if (this.blameLoading) return "Blame…";
    if (this.blame?.text) return `Blame: ${this.blame.text}`;
    if (this.blame?.error) return `Blame unavailable · ${this.blame.error}`;
    return null;
  }

  status(): TabStatus {
    return {
      blame: this.selectionBlame.status() ?? this.focusedBlameText(),
      progress: this.progress,
      error: this.error,
    };
  }

  refresh(scope: RefreshScope, cx: AsyncContext): void {
    if (scope === "history" || scope === "workspaces") return;
    const context = this.services.context();
    if (context !== this.seen) {
      this.seen = context;
      this.mode = { kind: "last" };
      this.changes = [];
      this.comparison = null;
      this.target = { kind: "working-index" };
      this.error = null;
      this.resetView();
      this.files.reset();
      this.selectionBlame.reset();
    }
    if (!this.services.busy()) this.stagingOwner = null;
    const result = this.pendingResult;
    if (result && !this.services.busy()) {
      this.pendingResult = null;
      showResult(this.services.overlay, result.name, result.success, result.message, result.preview, cx);
    }
    if (this.active) this.loadChanges(cx);
  }

  private loadChanges(cx: AsyncContext): void {
    const git = this.services.git();
    const request = ++this.changesRequest;
    if (!git) {
      this.progress = null;
      this.changes = [];
      this.files.rebuild(null);
      this.diff.plain(this.services.repository()?.state === "none" ? "Not a Git repository" : "");
      return;
    }
    const context = this.services.context();
    const repository = this.services.repository();
    const files = repository?.state === "ready" ? repository.files : undefined;
    const mode = this.mode;
    cx.spawn(async (cx) => {
      try {
        const snapshot = await readChanges(git, mode, files);
        if (request !== this.changesRequest || context !== this.services.context()) return;
        this.error = null;
        const previous = this.changes[this.selectedChange];
        this.changes = snapshot.changes;
        this.comparison = snapshot.comparison;
        this.summaries = snapshot.summaries;
        this.titles = snapshot.titles;
        const index = previous
          ? this.changes.findIndex((change) => change.section === previous.section && change.path === previous.path)
          : -1;
        this.selectedChange = Math.max(0, index);
        this.files.rebuild(this.changes.length ? this.selectedChange : null);
        this.updateTarget();
        this.loadDiff(cx);
      } catch (error) {
        if (request === this.changesRequest) this.error = errorMessage(error);
      } finally {
        if (request === this.changesRequest) {
          this.progress = null;
          cx.notify();
        }
      }
    });
  }

  private updateTarget(): void {
    const change = this.changes[this.selectedChange];
    this.target = this.comparison ?? (change ? sectionTarget(change.section) : null) ?? this.target;
  }

  private selectChange(index: number, cx: AsyncContext): void {
    this.focusAfterLoad = false;
    if (this.changes.length === 0) return;
    const next = Math.min(index, this.changes.length - 1);
    if (next !== this.selectedChange) {
      this.diff.detach();
      this.diff.clearSelection();
    }
    this.selectedChange = next;
    this.updateTarget();
    this.loadDiff(cx);
  }

  private activateChange(index: number, cx: AsyncContext): void {
    this.selectChange(index, cx);
    this.setFocus("diff");
    this.diff.side = "After";
    this.focusAfterLoad = true;
  }

  private loadDiff(cx: AsyncContext): void {
    const git = this.services.git();
    const change = this.changes[this.selectedChange];
    const request = ++this.diffRequest;
    this.blameRequest++;
    this.blame = null;
    this.blameLoading = false;
    if (!git || !change) {
      this.diff.plain(git ? "No changes." : "Not a Git repository");
      return;
    }
    const target = this.target;
    const context = this.services.context();
    cx.spawn(async (cx) => {
      let text: string;
      let patch = false;
      try {
        text = await readTargetDiff(git, target, change.path);
        patch = text.length > 0;
        if (!patch) text = "No diff for this file and target.";
      } catch (error) {
        text = `Error: ${errorMessage(error)}`;
      }
      if (request !== this.diffRequest || context !== this.services.context()) return;
      if (patch) this.diff.set(text, change.path);
      else this.diff.plain(text);
      if (this.focusAfterLoad) {
        this.focusAfterLoad = false;
        this.diff.focusFirstChange();
        this.loadBlame(this.diff.cursor, cx);
      }
      cx.notify();
    });
  }

  private loadBlame(row: number, cx: AsyncContext): void {
    const line = this.diff.lineNumber("After", row);
    const change = this.changes[this.selectedChange];
    const git = this.services.git();
    if (line === null || !change || !git) {
      this.blameRequest++;
      this.blameLoading = false;
      this.blame = { line: 0, text: null, error: "select a context or added line" };
      return;
    }
    if (this.blame?.line === line && this.blame.text) return;
    const request = ++this.blameRequest;
    const revision = blameRevision(this.target);
    this.blameLoading = true;
    cx.spawn(async (cx) => {
      let blame: FocusedBlame;
      try {
        const [entry] = await readBlameRange(git, change.path, line, line, revision);
        blame =
          entry?.line === line
            ? { line, text: blameText(line, entry.sha, entry.author, entry.summary), error: null }
            : { line, text: null, error: "Blame result did not match the line" };
      } catch (error) {
        blame = { line, text: null, error: errorMessage(error) };
      }
      if (request !== this.blameRequest) return;
      this.blame = blame;
      this.blameLoading = false;
      cx.notify();
    });
  }

  private hoverBlame(row: number, cx: AsyncContext): void {
    const request = ++this.hoverRequest;
    cx.spawn(async (cx) => {
      await cx.sleep(HOVER_BLAME_MS);
      if (request !== this.hoverRequest || this.focused !== "diff" || this.diff.cursor !== row) return;
      this.loadBlame(row, cx);
      cx.notify();
    });
  }

  private stage(operation: StagingOperation, owner: string, cx: AsyncContext): void {
    if (this.services.busy()) {
      this.services.reportError("Wait for the current Git operation.");
      return;
    }
    if (this.services.repository()?.state !== "ready") {
      this.services.reportError("Not a Git repository");
      return;
    }
    this.stagingOwner = owner;
    this.services.mutate(
      this.services.context(),
      stagingLabel(operation),
      async (git) => {
        try {
          await runStaging(git, operation);
          this.pendingResult = { name: "Staging", success: true, message: stagingMessage(operation) };
        } catch (error) {
          const message = `${stagingPreview(operation)} failed: ${errorMessage(error)}`;
          this.pendingResult = { name: "Staging", success: false, message };
          throw error;
        }
      },
      cx,
    );
  }

  private confirmDiscard(paths: string[], cx: AsyncContext): void {
    if (this.services.busy()) {
      this.services.reportError("Wait for the current Git operation.");
      return;
    }
    const context = this.services.context();
    const operation: StagingOperation = { kind: "discard", paths };
    const more = paths.length > 5 ? `\n... and ${paths.length - 5} more` : "";
    this.services.overlay.open({
      kind: "confirm",
      title: "Confirm Git operation",
      lines: [
        `Discard unstaged changes in ${paths.length} tracked files?\nRestore from: index (staged content)\nStaged changes and untracked files are kept.\n\nUnstaged edits will be permanently lost.\n\n${paths.slice(0, 5).join("\n")}${more}`,
      ],
      hint: "Discard all tracked changes…",
      onConfirm: (cx) => {
        const preview = stagingPreview(operation);
        this.services.mutate(
          context,
          stagingLabel(operation),
          async (git) => {
            const output = await runStaging(git, operation).catch((error: unknown) => {
              this.pendingResult = { name: "Discard", success: false, message: errorMessage(error), preview };
              throw error;
            });
            this.pendingResult = { name: "Discard", success: true, message: output, preview };
          },
          cx,
        );
      },
    });
    cx.notify();
  }

  openFilesSearch(cx: AsyncContext): void {
    this.setFocus("files");
    const changes = this.changes;
    const all = treeRows(changes, new Set());
    const filtered = (query: string) => filterTree(all, changes, query);
    const pickerRows = (query: string): PickerRow[] =>
      filtered(query).map((row) => {
        const indent = "  ".repeat(row.depth);
        if (row.kind === "directory")
          return {
            id: `dir:${row.key}`,
            label: `${indent}${row.expanded ? GLYPH.expanded : GLYPH.collapsed} ${row.label}`,
          };
        const status = changes[row.change]?.status.slice(0, 1) ?? "";
        return { id: `file:${row.change}`, label: `${indent}${status.padEnd(4)} ${row.label}` };
      });
    const first = all.find((row) => row.kind === "file");
    this.services.overlay.open({
      kind: "picker",
      title: "Find Files",
      width: DIALOG.medium,
      maxRows: 15,
      rows: pickerRows,
      selected: first?.kind === "file" ? `file:${first.change}` : undefined,
      footer: (query) => {
        if (!query) return "";
        const count = filtered(query).filter((row) => row.kind === "file").length;
        return count === 0 ? "No matching files" : count === 1 ? "1 matching file" : `${count} matching files`;
      },
      primary: "[Enter] Open",
      secondary: "[Esc] Close",
      onChoose: (row, cx) => {
        if (!row.id.startsWith("file:")) return;
        const change = Number(row.id.slice(5));
        this.files.rebuild(change);
        this.activateChange(change, cx);
      },
    });
    cx.notify();
  }

  private openLineJump(): void {
    const side = this.diff.side;
    this.services.overlay.open({
      kind: "form",
      title: `Go to ${side} line`,
      width: DIALOG.narrow,
      fields: [{ label: "Line" }],
      hint: "Enter a positive line number",
      primary: "[Enter] Go",
      onSubmit: ([value = ""], cx) => {
        if (!/^\d+$/.test(value.trim())) return "Error: Enter a positive line number.";
        const line = Number(value.trim());
        if (line === 0) return "Error: Line numbers start at 1.";
        if (!this.diff.revealLine(side, line)) return `Error: Line ${line} is unavailable on ${side}.`;
        this.loadBlame(this.diff.cursor, cx);
        return null;
      },
    });
  }

  private copySelection(): boolean {
    if (this.diff.keyboardSelecting()) this.diff.finishSelection();
    const selection = this.diff.selection();
    const change = this.changes[this.selectedChange];
    if (!selection || !change) return false;
    openCopySelection(
      this.services,
      { path: change.path, side: selection.side, lines: selection.lines, code: selection.code },
      () => this.diff.clearSelection(),
    );
    return true;
  }

  private lineHistory(cx: AsyncContext): void {
    const selection = this.diff.selection();
    const change = this.changes[this.selectedChange];
    if (!selection || !change) return;
    const target = this.target;
    let side: ReviewSide = "Before";
    let revision: string | null = null;
    if (target.kind === "commit" && selection.side === "After") {
      side = "After";
      revision = target.commit;
    } else if (target.kind === "commit") {
      if (!target.parent) return;
      revision = target.parent;
    }
    const ranges: [number, number][] = [];
    for (const line of this.diff.linesOn(side)) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] + 1 === line) last[1] = line;
      else ranges.push([line, line]);
    }
    if (ranges.length === 0) return;
    const name = change.path.split("/").pop() ?? change.path;
    openLineHistory(
      this.services,
      `${name}:${lineNumbersText(selection.lines)}`,
      { file: change.path, ranges, revision },
      { cols: this.size.cols, rows: this.size.rows },
      cx,
    );
  }

  private reviewKey(key: string, cx: Context): boolean {
    if (key === "y") return this.copySelection();
    if (key === "h" && this.diff.selection()) {
      this.lineHistory(cx);
      return true;
    }
    if (key === "escape" && this.diff.hasSelection()) {
      this.diff.clearSelection();
      return true;
    }
    return false;
  }

  private diffKey(event: KeyEvent, cx: Context): void {
    if (isChord(event)) return;
    const key = event.keystroke;
    let handled = true;
    if (key === "b") this.loadBlame(this.diff.cursor, cx);
    else if (key === "g" && !this.diff.keyboardSelecting()) this.openLineJump();
    else if (this.reviewKey(key, cx)) handled = true;
    else if (this.diff.key(event, cx)) {
      if (["up", "down", "j", "k", "home", "end"].includes(key)) this.hoverRequest++;
      return;
    } else handled = false;
    if (!handled) return;
    cx.stop_propagation();
    cx.notify();
  }

  private filesKey(event: KeyEvent, cx: Context): void {
    if (this.files.key(event, cx) || (event.keystroke === "b" && !isChord(event))) {
      if (event.keystroke === "b") this.loadBlame(this.diff.cursor, cx);
      cx.stop_propagation();
      cx.notify();
    }
  }

  private comparisonKey(event: KeyEvent, cx: Context): void {
    const key = event.key.toLowerCase();
    const index = event.modifiers.alt && key === "d" ? 0 : event.modifiers.alt && key === "m" ? 1 : null;
    const composed = event.key_char === "∂" ? 0 : event.key_char === "µ" ? 1 : null;
    const choice = index ?? composed;
    if (choice === null) return;
    cx.stop_propagation();
    this.selectComparison(choice, cx);
    cx.notify();
  }

  private resize(column: number): void {
    const divider = this.divider;
    const total = this.size.cols;
    if (divider === null || total < MIN_FILES + MIN_DIFF * 2) return;
    const [first, second] = changesPaneWidths(total, this.splits);
    const edge = first + second;
    const pointer = Math.max(0, Math.min(column, total));
    const target =
      divider === 0
        ? Math.max(MIN_FILES, Math.min(pointer, edge - MIN_DIFF))
        : Math.max(first + MIN_DIFF, Math.min(pointer, total - MIN_DIFF));
    this.splits[divider] = Math.floor((target * SPLIT_SCALE) / total);
  }

  private dividerElement(look: Look, index: 0 | 1, boundary: number): Element {
    const { t } = look;
    const shown = this.divider === index || this.hoveredDivider === index;
    return div()
      .id(`git-changes-divider-${index}`)
      .absolute()
      .top(0)
      .bottom(0)
      .left(cols(look, boundary - 1))
      .w(cols(look, 3))
      .cursor_col_resize()
      .on_hover((hovered, cx) => {
        const next = hovered ? index : this.hoveredDivider === index ? null : this.hoveredDivider;
        if (next === this.hoveredDivider) return;
        this.hoveredDivider = next;
        cx.notify();
      })
      .on_mouse_down("left", (_, cx) => {
        cx.stop_propagation();
        this.divider = index;
        cx.notify();
      })
      .when(shown, (el) =>
        el.child(
          div()
            .absolute()
            .top(0)
            .bottom(0)
            .left(look.cell)
            .w(look.cell)
            .bg(t.hover)
            .child(
              div()
                .absolute()
                .top(0)
                .bottom(0)
                .left(look.cell / 2 - 1)
                .w(2)
                .bg(t.accent),
            ),
        ),
      );
  }

  private selectionTitle(look: Look, side: ReviewSide): Element | null {
    const selection = this.diff.selection();
    const change = this.changes[this.selectedChange];
    if (!selection || selection.side !== side || !change) return null;
    const name = change.path.split("/").pop() ?? change.path;
    return h_flex()
      .child(`${side} · `)
      .child(
        div()
          .text_color(look.t.accent)
          .font_weight(700)
          .child(`${name}:${lineNumbersText(selection.lines)}`),
      );
  }

  private diffBoxes(look: Look): { before: Element; after: Element } {
    const focused = this.focused === "diff" && !this.workspaces.isFocused();
    const panes = this.diff.render(look, {
      focused,
      hint: !this.services.overlay.isOpen(),
      onPointer: (_, row, cx) => {
        if (this.focused !== "diff") this.setFocus("diff");
        this.blameRequest++;
        this.blameLoading = false;
        this.blame = this.blame?.line === this.diff.lineNumber("After", row) ? this.blame : null;
        this.hoverBlame(row, cx);
      },
      onClick: (side, row, cx) => {
        this.setFocus("diff");
        this.hoverRequest++;
        if (this.diff.toggleFold(row)) return;
        if (this.diff.keyboardSelecting()) {
          this.diff.finishSelection();
          return;
        }
        this.diff.beginSelection(side, row, false);
        this.loadBlame(row, cx);
      },
    });
    const before = box(
      look,
      {
        id: "git-changes-before",
        title: this.selectionTitle(look, "Before") ?? `Before · ${this.diff.language()}`,
        focused: focused && this.diff.side === "Before",
      },
      panes.before,
    ).on_mouse_down("left", () => this.setFocus("diff"));
    const after = box(
      look,
      {
        id: "git-changes-after",
        title: this.selectionTitle(look, "After") ?? "After",
        focused: focused && this.diff.side === "After",
      },
      panes.after,
    )
      .track_focus(this.diffHandle)
      .on_key_down((event, cx) => this.diffKey(event, cx))
      .on_mouse_down("left", () => this.setFocus("diff"));
    return { before, after };
  }

  private syncSelectionBlame(cx: AsyncContext): void {
    if (this.diff.dragging()) return;
    const selection = this.diff.selection();
    const change = this.changes[this.selectedChange];
    this.selectionBlame.sync(
      this.services,
      selection && change && selection.side === "After"
        ? { file: change.path, lines: selection.lines, revision: blameRevision(this.target) }
        : null,
      cx,
    );
  }

  render(look: Look, size: BodySize, cx: Context): Element {
    this.size = size;
    if (!size.wide) this.divider = null;
    this.syncSelectionBlame(cx);
    const repository = this.services.repository();
    const filesBox = v_flex()
      .flex_1()
      .min_h(0)
      .min_w(0)
      .on_key_down((event, cx) => this.filesKey(event, cx))
      .child(
        this.files
          .render(look, {
            focused: this.focused === "files" && !this.workspaces.isFocused(),
            hints: this.hints,
            repository: !repository || repository.state === "ready",
            owner: this.services.busy() ? this.stagingOwner : null,
          })
          .flex_1(),
      );
    const left = v_flex()
      .min_h(0)
      .min_w(0)
      .child(filesBox)
      .child(v_flex().flex_1().min_h(0).min_w(0).child(this.workspaces.render(look).flex_1()));
    const { before, after } = this.diffBoxes(look);
    const root = (size.wide ? h_flex() : v_flex())
      .id("git-changes")
      .relative()
      .size_full()
      .min_h(0)
      .min_w(0)
      .on_key_down((event, cx) => this.comparisonKey(event, cx))
      .on_mouse_up("left", (_, cx) => {
        this.divider = null;
        this.diff.pointerUp(cx);
        this.files.pointerUp(cx);
      })
      .on_mouse_move((event, cx) => {
        if (this.divider === null) return;
        this.resize(Math.round(event.local_position.x / look.screenCell));
        cx.notify();
      });
    if (!size.wide) {
      const first = Math.floor((size.rows * 25) / 100);
      const second = Math.floor((size.rows * 37) / 100);
      return root
        .child(left.h(rows(look, first)).flex_none())
        .child(before.h(rows(look, second)).flex_none())
        .child(after.flex_1());
    }
    const [first, second] = changesPaneWidths(size.cols, this.splits);
    return root
      .child(left.w(cols(look, first)).h_full().flex_none())
      .child(before.w(cols(look, second)).h_full().flex_none())
      .child(after.flex_1().h_full())
      .child(this.dividerElement(look, 0, first))
      .child(this.dividerElement(look, 1, first + second));
  }
}
