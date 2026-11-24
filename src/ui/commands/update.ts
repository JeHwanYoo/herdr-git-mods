import type { Context } from "gpui-kit";
import { appHome, checking, exec, notify, readTextFile, writeTextFile } from "herdr";
import { installRelease, latestRelease, type ModRelease } from "../../runtime/mod-release.ts";
import { BUNDLE_ASSET, BUNDLE_LIMIT, VERSION } from "../../version.ts";
import type { ConfirmSpec, Overlay } from "../overlay.ts";
import { DIALOG } from "../theme.ts";
import { errorMessage } from "./host.ts";
import { showResult } from "./result.ts";

const UPDATE_INTERVAL = 30 * 60 * 1000;
const UPDATE_TICK = 60 * 1000;
const LAST_CHECK = "git-release-check";
const LAST_NOTICE = "git-release-notice";
const TITLE = "Update Herdr Git Mods";

async function download(url: string): Promise<string> {
  const result = await exec(
    "curl",
    [
      "-q",
      "--silent",
      "--show-error",
      "--fail",
      "--location",
      "--max-redirs",
      "3",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--connect-timeout",
      "10",
      "--max-time",
      "30",
      "--max-filesize",
      String(BUNDLE_LIMIT),
      url,
    ],
    { cwd: appHome(), timeout: 35000 },
  );
  if (result.code !== 0) throw new Error(result.stderr.trim() || "GitHub request failed.");
  return result.stdout;
}

export class ModUpdate {
  private pending: Promise<ModRelease | null> | null = null;
  private available: ModRelease | null = null;
  private installing = false;
  private active = true;

  constructor(private readonly overlay: Overlay) {}

  release(): void {
    this.active = false;
  }

  status(): string | null {
    if (this.installing) return "Installing update…";
    if (this.pending) return "Checking GitHub…";
    return this.available ? `${this.available.tag} available` : null;
  }

  private check(): Promise<ModRelease | null> {
    if (this.pending) return this.pending;
    localStorage.setItem(LAST_CHECK, String(Date.now()));
    this.pending = latestRelease(VERSION, download)
      .then((release) => {
        this.available = release;
        return release;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  watch(cx: Context): void {
    if (checking()) return;
    this.background(cx);
    cx.timer.every(UPDATE_TICK, (cx) => this.background(cx));
  }

  private background(cx: Context): void {
    if (!this.active || this.installing) return;
    cx.spawn(async (cx) => {
      const elapsed = Date.now() - Number(localStorage.getItem(LAST_CHECK));
      if (elapsed >= 0 && elapsed < UPDATE_INTERVAL) return;
      let release: ModRelease | null;
      try {
        release = await this.check();
      } catch {
        if (this.active) cx.notify();
        return;
      }
      if (!this.active) return;
      if (release && localStorage.getItem(LAST_NOTICE) !== release.tag) {
        localStorage.setItem(LAST_NOTICE, release.tag);
        notify({ title: `Herdr Git Mods ${release.tag} is available`, body: "Open Git Settings to install it." });
      }
      cx.notify();
    });
  }

  open(cx: Context): void {
    if (this.installing) return;
    const dialog = this.progress("Checking GitHub Releases…");
    cx.spawn(async (cx) => {
      try {
        const release = await this.check();
        if (!this.active || this.overlay.current() !== dialog) return;
        if (release) this.confirm(release);
        else showResult(this.overlay, "Update check", true, `Herdr Git Mods v${VERSION} is up to date.`, undefined, cx);
      } catch (error) {
        if (!this.active || this.overlay.current() !== dialog) return;
        showResult(this.overlay, "Update check", false, errorMessage(error));
      }
      cx.notify();
    });
  }

  private progress(message: string): ConfirmSpec {
    const dialog: ConfirmSpec = {
      kind: "confirm",
      title: TITLE,
      width: DIALOG.medium,
      lines: [message],
      primary: "",
      secondary: "[Esc] Close",
      enabled: () => false,
      onConfirm: () => {},
    };
    this.overlay.open(dialog);
    return dialog;
  }

  private confirm(release: ModRelease): void {
    this.overlay.open({
      kind: "confirm",
      title: TITLE,
      width: DIALOG.medium,
      lines: [`v${VERSION} → ${release.tag}`, "", "Install the GitHub release and reload Git?"],
      primary: "[Enter] Install",
      onConfirm: (cx) => this.install(release, cx),
    });
  }

  private install(release: ModRelease, cx: Context): void {
    if (this.installing) return;
    this.installing = true;
    const dialog = this.progress(`Installing ${release.tag}…`);
    cx.spawn(async (cx) => {
      try {
        const path = `${appHome()}/mods/git/${BUNDLE_ASSET}`;
        await installRelease(
          VERSION,
          release,
          { read: () => readTextFile(path), replace: (text, expected) => writeTextFile(path, text, expected) },
          download,
        );
        this.available = null;
        if (!this.active) return;
        notify({ title: `Installed Herdr Git Mods ${release.tag}`, level: "success" });
        if (this.overlay.current() === dialog) this.overlay.close(cx);
      } catch (error) {
        if (!this.active) return;
        if (this.overlay.current() === dialog) showResult(this.overlay, TITLE, false, errorMessage(error));
        else notify({ title: "Herdr Git Mods update failed", body: errorMessage(error), level: "error" });
      } finally {
        this.installing = false;
      }
      if (this.active) cx.notify();
    });
  }
}
