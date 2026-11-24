import { h_flex } from "gpui-base";
import { div, type Element } from "gpui-kit";
import { authorRelative, type Commit, type CommitRef, type CommitRefKind } from "../../git/history.ts";
import { ICON_CELLS, type IconName } from "../icons.ts";
import { shortCommit } from "../shell.ts";
import type { Color, Look, Palette } from "../theme.ts";
import { type CellSpan, displayWidth, spanElements, spansWidth, truncateToWidth } from "../widgets.ts";

const TIME_MIN_WIDTH = 56;
const TIME_WIDTH = 14;
const MIN_GRAPH_WIDTH = 3;
const MIN_SUBJECT_WIDTH = 12;

export function graphViewWidth(width: number): number {
  return Math.min(Math.max(Math.floor((width * 2) / 5), MIN_GRAPH_WIDTH), Math.max(0, width - 1));
}

function badgeStyle(kind: CommitRefKind, t: Palette): { icon?: IconName; symbol?: string; bg: Color } {
  const styles: Record<CommitRefKind, { icon?: IconName; symbol?: string; bg: Color }> = {
    head: { symbol: "●", bg: t.badgeHead },
    local: { icon: "branch", bg: t.badgeLocal },
    remote: { icon: "remote", bg: t.badgeRemote },
    "remote-head": { icon: "remote", bg: t.badgeRemoteHead },
    tag: { icon: "tag", bg: t.badgeTag },
    other: { symbol: "◆", bg: t.badgeOther },
  };
  return styles[kind];
}

function badgeSpans(references: readonly CommitRef[], width: number, t: Palette): CellSpan[] {
  const spans: CellSpan[] = [];
  let remaining = width - 1;
  for (const reference of references) {
    const separator = spans.length ? 1 : 0;
    const available = remaining - separator;
    const { icon, symbol, bg } = badgeStyle(reference.kind, t);
    const fixed = (icon ? ICON_CELLS : 1) + 3;
    if (available <= fixed) break;
    const name = truncateToWidth(reference.name, available - fixed);
    const badgeWidth = fixed + displayWidth(name);
    if (separator) {
      spans.push({ text: " " });
      remaining -= 1;
    }
    if (icon) spans.push({ text: " ", bg }, { text: ` ${name} `, icon, bg });
    else spans.push({ text: ` ${symbol} ${name} `, bg });
    remaining -= badgeWidth;
  }
  if (spans.length) spans.push({ text: " " });
  return spans;
}

function subjectSpans(prose: string, t: Palette): CellSpan[] {
  const spans: CellSpan[] = [];
  let cursor = 0;
  for (const match of prose.matchAll(/#\d+/g)) {
    const start = match.index ?? 0;
    if (cursor < start) spans.push({ text: prose.slice(cursor, start) });
    spans.push({ text: match[0], color: t.reference, bold: true });
    cursor = start + match[0].length;
  }
  if (cursor < prose.length) spans.push({ text: prose.slice(cursor) });
  return spans;
}

export interface CommitText {
  width: number;
  gutter: number;
  nowSeconds: number;
  bold: boolean;
}

function titleSpans(look: Look, commit: Commit, subjectWidth: number): CellSpan[] {
  const { t } = look;
  if (!commit.sha) return [{ text: truncateToWidth("Uncommitted changes", subjectWidth), color: t.hint, bold: true }];
  const badges = badgeSpans(
    commit.refs,
    Math.min(Math.max(0, subjectWidth - MIN_SUBJECT_WIDTH), Math.floor(subjectWidth / 2)),
    t,
  );
  return [
    ...badges,
    ...subjectSpans(truncateToWidth(commit.subject, Math.max(0, subjectWidth - spansWidth(badges))), t),
  ];
}

function line(look: Look, left: CellSpan[], right: CellSpan | null, bold: boolean): Element {
  return h_flex()
    .h(look.row)
    .min_w(0)
    .flex_1()
    .overflow_hidden()
    .whitespace_nowrap()
    .when(bold, (el) => el.font_weight(700))
    .child(h_flex().flex_1().min_w(0).overflow_hidden().children(spanElements(look, left)))
    .when(!!right, (el) => el.children(spanElements(look, right ? [right] : [])).child(div().flex_none().w(look.cell)));
}

export function commitTitle(look: Look, commit: Commit, text: CommitText): Element {
  const textWidth = Math.max(0, text.width - text.gutter);
  const time =
    commit.sha && text.width >= TIME_MIN_WIDTH
      ? truncateToWidth(authorRelative(commit, text.nowSeconds), TIME_WIDTH)
      : "";
  const timeWidth = time ? displayWidth(time) + 2 : 0;
  const spans = titleSpans(look, commit, Math.max(0, textWidth - timeWidth));
  return line(look, spans, time ? { text: time, color: look.t.hint } : null, text.bold);
}

export function commitDetail(look: Look, commit: Commit, text: CommitText): Element {
  const textWidth = Math.max(0, text.width - text.gutter);
  if (!commit.sha)
    return line(look, [{ text: truncateToWidth("Working tree", textWidth), color: look.t.muted }], null, false);
  const sha = truncateToWidth(shortCommit(commit.sha), textWidth);
  const author = truncateToWidth(commit.authorName, Math.max(0, textWidth - displayWidth(sha) - 2));
  return line(
    look,
    [{ text: sha, color: look.t.accent }],
    author ? { text: author, color: look.t.secondary } : null,
    false,
  );
}
