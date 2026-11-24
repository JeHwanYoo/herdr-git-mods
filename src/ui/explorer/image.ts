import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { platform } from "node:process";
import { type AsyncContext, div, type Element, image } from "gpui-kit";
import { appHome, exec } from "herdr";

export type ImageFormat = "png" | "jpeg" | "webp";

export interface PreviewImage {
  path: string;
  format: ImageFormat;
}

const ASSET_FOLDER = "data/git-image-previews";
const BYTE_LIMIT = 5 * 1024 * 1024;
const READ_LIMIT = BYTE_LIMIT + 1;
const EXEC_TIMEOUT = 5_000;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const REDRAW_DELAYS = [150, 700] as const;

async function readImage(path: string): Promise<Buffer> {
  const result = await (platform === "win32" || platform === "windows"
    ? exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", windowsReadImage(path)], {
        timeout: EXEC_TIMEOUT,
      })
    : exec(
        "sh",
        [
          "-c",
          'test ! -L "$1" || exit 3; test -f "$1" || exit 2; head -c "$2" "$1" | base64',
          "git-preview",
          path,
          String(READ_LIMIT),
        ],
        { timeout: EXEC_TIMEOUT },
      ));
  if (result.code === 2) throw new Error("Image is unavailable in the working tree");
  if (result.code === 3) throw new Error("Image preview requires a regular file");
  if (result.code !== 0) throw new Error("Could not read the image");
  const bytes = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
  if (bytes.length > BYTE_LIMIT) throw new Error("Image exceeds the 5 MiB preview limit");
  return bytes;
}

function windowsReadImage(path: string): string {
  const source = Buffer.from(path).toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))
$item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
if ($null -eq $item -or $item.PSIsContainer) { exit 2 }
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 3 }
$stream = [IO.File]::OpenRead($item.FullName)
try {
  $bytes = New-Object byte[] ${READ_LIMIT}
  $offset = 0
  while ($offset -lt $bytes.Length) {
    $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
    if ($count -eq 0) { break }
    $offset += $count
  }
  [Console]::Write([Convert]::ToBase64String($bytes, 0, $offset))
} finally {
  $stream.Dispose()
}
`;
  return Buffer.from(script, "utf16le").toString("base64");
}

function imageFormat(bytes: Buffer): ImageFormat | null {
  if (bytes.length < 12) return null;
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  if (
    Buffer.from(bytes.subarray(0, 12))
      .toString("ascii")
      .match(/^RIFF....WEBP$/s)
  )
    return "webp";
  return null;
}

interface Asset {
  relative: string;
  absolute: string;
  digest: string;
}

export class ImagePreview {
  private asset: Asset | null = null;

  clear(): void {
    const previous = this.asset;
    this.asset = null;
    if (previous) void unlink(previous.absolute).catch(() => undefined);
  }

  async load(source: PreviewImage, current: () => boolean, cx: AsyncContext): Promise<void> {
    const bytes = await readImage(source.path);
    if (!current()) return;
    if (imageFormat(bytes) !== source.format) throw new Error("File does not contain a supported image");
    const digest = String(createHash("sha256").update(bytes).digest("hex"));
    if (this.asset?.digest === digest) return;
    const directory = `${appHome()}/${ASSET_FOLDER}`;
    const name = `${randomUUID()}.${source.format}`;
    const asset: Asset = { relative: `${ASSET_FOLDER}/${name}`, absolute: `${directory}/${name}`, digest };
    try {
      await mkdir(directory, { recursive: true });
      if (!current()) return;
      await writeFile(asset.absolute, bytes);
      if (!current()) return;
      this.clear();
      this.asset = asset;
      for (const delay of REDRAW_DELAYS) {
        cx.timer.after(delay, (cx) => {
          if (this.asset === asset) cx.notify();
        });
      }
    } finally {
      if (this.asset !== asset) await unlink(asset.absolute).catch(() => undefined);
    }
  }

  render(): Element {
    const viewport = div().flex().flex_1().w_full().min_w(0).min_h(0).overflow_hidden();
    if (this.asset) viewport.child(image(this.asset.relative).size_full());
    return viewport;
  }
}
