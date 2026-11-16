import { v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type KeyEvent } from "gpui-kit";
import { type Remote, readRemotes } from "../../git/remotes.ts";
import { DIALOG, type Look, rows } from "../theme.ts";
import { dialogFooter, ListViewport } from "../widgets.ts";
import { Dialog, type DialogOptions } from "./dialog.ts";
import { type CommandHost, errorMessage } from "./host.ts";

export function openAddRemote(host: CommandHost, values?: { name: string; url: string; error: string }): void {
  const remotes = host.context().remotes;
  const overlay = host.services.overlay;
  overlay.open({
    kind: "form",
    title: "Add Remotes",
    width: DIALOG.medium,
    fields: [
      { label: "Name", value: values?.name ?? (remotes.length ? "" : "origin") },
      { label: "URL", value: values?.url ?? "" },
    ],
    primary: "[Enter] Add",
    onSubmit: (fields, cx) => {
      const name = (fields[0] ?? "").trim();
      const url = (fields[1] ?? "").trim();
      if (!name || name.startsWith("-") || /\s/.test(name)) return "Error: Enter a remote name without spaces.";
      if (host.context().remotes.includes(name)) return "Error: A remote with this name already exists.";
      if (!url || [...url].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
        return "Error: Enter a repository URL or path.";
      host.run("add-remote", { kind: "add-remote", name, url }, cx, (success, output, cx) => {
        if (success) new RemoteList(host, cx).open(cx);
        else openAddRemote(host, { name, url, error: output });
        return true;
      });
      return null;
    },
  });
  if (values) overlay.setError(`Error: ${values.error}`);
}

export class RemoteList extends Dialog {
  private remotes: Remote[] = [];
  private loading = true;
  private error: string | null = null;
  private readonly list = new ListViewport("git-remotes");

  constructor(
    private readonly host: CommandHost,
    cx: AsyncContext,
  ) {
    super(host.services.overlay, cx);
  }

  open(cx: AsyncContext): void {
    this.show();
    const git = this.host.services.git();
    if (!git) return;
    cx.spawn(async (cx) => {
      try {
        this.remotes = await readRemotes(git);
      } catch (error) {
        this.error = errorMessage(error);
      }
      this.loading = false;
      cx.notify();
    });
  }

  protected options(): DialogOptions {
    return { title: "Show Remotes", width: DIALOG.wide, height: Math.max(10, this.remotes.length + 7) };
  }

  private remove(cx: Context): void {
    const remote = this.remotes[this.list.selected];
    if (!remote) return;
    this.close(cx);
    this.host.confirm("remove-remote", { kind: "remove-remote", name: remote.name }, cx);
  }

  protected key(event: KeyEvent, cx: Context): boolean {
    if (event.keystroke === "delete" || event.keystroke === "d") this.remove(cx);
    else return this.list.key(event, this.remotes.length) === "moved";
    return true;
  }

  private content(look: Look): Element {
    if (this.loading) return div().text_color(look.t.hint).child("Loading remotes");
    if (this.error) return div().text_color(look.t.error).child(`Error: ${this.error}`);
    if (!this.remotes.length) return div().child("No remotes configured.");
    return this.list.render(look, {
      length: this.remotes.length,
      focused: true,
      marker: true,
      row: ({ index }) => {
        const remote = this.remotes[index];
        return div()
          .truncate()
          .child(remote ? `${remote.name}${index === 0 ? " (default)" : ""}  ${remote.url}` : "");
      },
      onSelect: (index) => {
        this.list.selected = index;
      },
    });
  }

  protected body(look: Look): Element {
    const selected = this.remotes[this.list.selected];
    return v_flex()
      .size_full()
      .min_h(rows(look, 7))
      .child(v_flex().flex_1().min_h(0).child(this.content(look)))
      .child(
        v_flex()
          .flex_none()
          .h(rows(look, 2))
          .text_color(look.t.hint)
          .when(!!selected, (el) =>
            el
              .child(
                div()
                  .truncate()
                  .child(`Push URL: ${selected?.pushUrl ?? ""}`),
              )
              .child(div().child("[j/k] Select")),
          ),
      )
      .child(
        dialogFooter(
          look,
          { id: "git-remotes-remove", label: "[Del] Remove", onClick: (cx) => this.remove(cx) },
          { id: "git-remotes-close", label: "[Esc] Close", onClick: (cx) => this.close(cx) },
        ),
      );
  }
}
