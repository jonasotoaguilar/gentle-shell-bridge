/**
 * The extension entry Pi loads (`pi.extensions` in package.json).
 *
 * Two responsibilities, no more:
 * 1. arm the bridge on `session_start`, only when the context has a UI. Arming is already
 *    idempotent (the capture target and the hook registry carry non-enumerable markers), so this
 *    module adds no second guard layer — a double load, a `/reload` or a rebind all resolve to
 *    "already armed".
 * 2. register the `status` command and print the formatter output.
 *
 * The API surface used here was confirmed against `docs/extensions.md`: `pi.on("session_start",
 * async (_event, ctx) => …)` and `pi.registerCommand(name, { description, handler })` with
 * `ctx.ui.notify(message, level)` inside the handler.
 *
 * Nothing runs at import time: no arming, no registration, no global writes.
 */

import { armBridge } from "./arm.ts";
import { collectStatus, formatStatus } from "./status.ts";

/**
 * Command name. Pi has no built-in `/status` (verified against `docs/slash-commands.md`), and
 * gentle-shell owns the `gentle:` prefix, so a bare `bridge-status` cannot collide with either
 * while staying one short token in Pi's command menu.
 */
export const STATUS_COMMAND = "bridge-status";

/** The part of the session context this extension reads. */
export interface BridgeSessionContext {
  hasUI?: boolean;
  ui?: unknown;
}

/** The part of the command context this extension reads. */
export interface BridgeCommandContext {
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  };
}

export type BridgeSessionHandler = (event: unknown, ctx: BridgeSessionContext) => unknown;
export type BridgeCommandHandler = (args: string, ctx: BridgeCommandContext) => unknown;

/** The part of Pi's `ExtensionAPI` this extension uses. */
export interface BridgeExtensionApi {
  on(event: "session_start", handler: BridgeSessionHandler): void;
  registerCommand(
    name: string,
    command: { description?: string; handler: BridgeCommandHandler },
  ): void;
}

export default function gentleShellBridge(pi: BridgeExtensionApi): void {
  pi.on("session_start", (_event, ctx) => {
    // Without a UI there is no customize menu to reach, so there is nothing to arm.
    if (ctx.hasUI !== true) return;
    armBridge(ctx.ui);
  });

  pi.registerCommand(STATUS_COMMAND, {
    description: "Show gentle-shell-bridge providers, backend, capture and store diagnostics",
    handler: (_args, ctx) => {
      const report = formatStatus(collectStatus()).join("\n");
      ctx.ui?.notify?.(report, "info");
    },
  });
}
