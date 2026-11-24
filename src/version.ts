export const VERSION = "0.1.0";
export const BUNDLE_ASSET = "main.js";
export const BUNDLE_LIMIT = 1024 * 1024;

export function bundleHeader(version: string): string {
  return `// Herdr Git Mods v${version}\n`;
}
