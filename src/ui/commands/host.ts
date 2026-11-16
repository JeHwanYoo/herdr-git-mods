import type { AsyncContext } from "gpui-kit";
import type { GitOperation } from "../../git/workflows.ts";
import type { Services } from "../shell.ts";
import type { CommandContext, CommandId } from "./catalog.ts";

export type OperationDone = (success: boolean, output: string, cx: AsyncContext) => boolean;

export interface CommandHost {
  readonly services: Services;
  context(): CommandContext;
  run(command: CommandId, operation: GitOperation, cx: AsyncContext, done?: OperationDone): void;
  confirm(command: CommandId, operation: GitOperation, cx: AsyncContext): void;
  dispatch(id: CommandId, cx: AsyncContext): void;
  fail(name: string, message: string, cx?: AsyncContext): void;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
