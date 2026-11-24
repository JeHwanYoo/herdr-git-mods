import { createHash } from "node:crypto";
import { BUNDLE_ASSET, BUNDLE_LIMIT, bundleHeader } from "../version.ts";

const REPO = "JeHwanYoo/herdr-git-mods";
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type Download = (url: string) => Promise<string>;

export interface ModRelease {
  tag: string;
  sha256: string;
}

export interface BundleFile {
  read(): Promise<string | null>;
  replace(text: string, expected: string): Promise<null>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function newerVersion(candidate: string, current: string): boolean {
  const parts = candidate.slice(1).split(".").map(BigInt);
  const installed = current.split(".").map(BigInt);
  for (const [index, part] of installed.entries()) {
    const next = parts[index];
    if (next !== undefined && next !== part) return next > part;
  }
  return false;
}

export async function latestRelease(current: string, download: Download): Promise<ModRelease | null> {
  const data: unknown = JSON.parse(await download(LATEST));
  if (
    !object(data) ||
    typeof data.tag_name !== "string" ||
    !TAG.test(data.tag_name) ||
    data.draft !== false ||
    data.prerelease !== false
  ) {
    throw new Error("GitHub did not return a stable release.");
  }
  const tag = data.tag_name;
  if (!newerVersion(tag, current)) return null;
  const asset: unknown = Array.isArray(data.assets)
    ? data.assets.find((entry: unknown) => object(entry) && entry.name === BUNDLE_ASSET)
    : null;
  if (
    !object(asset) ||
    asset.state !== "uploaded" ||
    typeof asset.size !== "number" ||
    asset.size <= 0 ||
    asset.size > BUNDLE_LIMIT ||
    typeof asset.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
  ) {
    throw new Error(`${tag} has no verifiable ${BUNDLE_ASSET} release asset.`);
  }
  return { tag, sha256: asset.digest.slice("sha256:".length) };
}

export async function installRelease(
  current: string,
  release: ModRelease,
  file: BundleFile,
  download: Download,
): Promise<void> {
  if (!TAG.test(release.tag) || !newerVersion(release.tag, current)) {
    throw new Error("The release is no longer newer than this version.");
  }
  const installed = await file.read();
  if (installed === null || installed.split(/\r?\n/, 1)[0] !== bundleHeader(current).trimEnd()) {
    throw new Error("The installed bundle changed. Reopen Git before updating.");
  }
  const bundle = await download(`https://github.com/${REPO}/releases/download/${release.tag}/${BUNDLE_ASSET}`);
  const sha256 = createHash("sha256").update(bundle).digest("hex");
  if (sha256 !== release.sha256 || !bundle.startsWith(bundleHeader(release.tag.slice(1)))) {
    throw new Error(`The downloaded bundle failed verification for ${release.tag}.`);
  }
  await file.replace(bundle, installed);
}
