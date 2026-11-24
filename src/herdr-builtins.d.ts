declare module "node:buffer" {
  export class Buffer extends Uint8Array {
    static from(value: string | Uint8Array, encoding?: string): Buffer;
    toString(encoding?: string): string;
  }
}

declare module "node:crypto" {
  export function createHash(algorithm: "sha256"): {
    update(data: string | Uint8Array): { digest(encoding: "hex"): string };
  };
  export function randomUUID(): string;
}

declare module "node:fs/promises" {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function unlink(path: string): Promise<void>;
  export function writeFile(path: string, contents: Uint8Array): Promise<void>;
}

declare module "node:process" {
  export const platform: string;
}
