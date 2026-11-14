/**
 * The extension entry Pi loads (`pi.extensions` in package.json).
 *
 * Four responsibilities, no more:
 * 1. publish the runtime handshake and announce it. Importing `./api.ts` publishes the frozen API
 *    object at `Symbol.for("gentle-shell-bridge/api/v1")` at module load, before any
 *    `session_start`, so a plugin that registers from its own `session_start` handler finds the
 *    object or learns the bridge is absent. When Pi loads the plugin BEFORE this package — the
 *    real TUI order — an absent symbol is only "not yet", so the factory also announces the
 *    publication on `pi.events` (`gentle-shell-bridge:ready`), once per process and never for an
 *    incompatible slot (`announceBridgeReady`). A plugin therefore needs no path, no environment
 *    variable and no import.
 * 2. arm the row bridge on `session_start`, only when the context has a UI. Arming is already
 *    idempotent (the capture target and the hook registry carry non-enumerable markers), so this
 *    module adds no second guard layer: a double load, a `/reload` or a rebind all resolve to
 *    "already armed". The same event flushes the notices buffered before any context existed
 *    through `ctx.ui.notify` — the in-TUI channel — exactly once per message.
 * 3. install the sidebar surface: the `Sections` rows provider (needs no `tui`) and a
 *    `ui.setWidget` factory whose only job is to be handed the real `tui` (see `armSidebar`).
 * 4. register the `status` command and print the formatter output.
 *
 * The API surface used here was confirmed against `docs/extensions.md`: `pi.on("session_start",
 * async (_event, ctx) => …)`, `pi.registerCommand(name, { description, handler })` with
 * `ctx.ui.notify(message, level)` inside the handler, and `ctx.ui.setWidget(key, (tui, theme) =>
 * Component)` — the only documented way an extension receives a `tui`.
 *
 * At import time the only global write is the API publication above: no arming, no registration,
 * no command.
 */

import { armBridge } from "./arm.ts";
import { announceBridgeReady, publishBridgeApi, type BridgeEventBus } from "./api.ts";
import { flushNotices } from "./notices.ts";
import { isRecord } from "./rows.ts";
import { installCardStyleRows } from "./card-style-rows.ts";
import { installCardStyleTransform, installRailCardStyleTransform } from "./card-style-wiring.ts";
import { installSectionRows } from "./sections-rows.ts";
import { setSectionTheme } from "./section-panel.ts";
import { installSidebarBackend, noteSidebarUnavailable, type SidebarTuiLike } from "./sidebar.ts";
import { setRepaintHost } from "./repaint.ts";
import { clearPluginStatus, installPluginStatus } from "./plugin-lines.ts";
import { installSectionRail } from "./sidebar-render.ts";
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

/** Key of the widget whose only purpose is to receive the host's `tui`. */
export const SIDEBAR_WIDGET_KEY = "gentle-shell-bridge.sidebar";

/** What one sidebar wiring attempt achieved (also reported by `/bridge-status`). */
export type SidebarArmOutcome =
  | "widget-installed"
  | "awaiting-factory"
  | "no-set-widget"
  | "set-widget-threw";

export interface SidebarArmResult {
  outcome: SidebarArmOutcome;
  /** Present when nothing could be installed. */
  reason?: string;
}

/** The `ctx.ui` members this module reads. */
interface BridgeUiSurface {
  setWidget?: (key: string, factory: (tui: unknown, theme: unknown) => unknown) => void;
}

/**
 * Reach the sidebar rail through Pi's one documented hand-out of a `tui`.
 *
 * Pi has no `tui` getter (`ExtensionUIContext` in `dist/core/extensions/types.d.ts` exposes `TUI` only
 * as a factory parameter), and gentle-shell itself obtains one the same way
 * (`extensions/gentle-agents.ts:2165-2175`). So: register a widget factory, keep the `tui` it
 * receives, and return a component that renders NO rows.
 *
 * UNCONFIRMED: whether a widget whose component renders zero rows leaves the editor area visually
 * untouched has not been observed in a real Pi TUI. It is the reason this component paints nothing
 * at all rather than a small marker.
 *
 * Failure paths are reported, never thrown: a missing `setWidget` or a factory the host never runs
 * records `no-widget-surface` for `/bridge-status`, and the row side keeps working.
 */
export function armSidebar(ui: unknown): SidebarArmResult {
  let captured: SidebarTuiLike | undefined;
  try {
    // Reading `setWidget` can itself throw (a getter on the host's UI object), so the whole
    // acquisition happens inside this guard: a broken accessor must never escape the session
    // handler and take the row side with it.
    const surface = isRecord(ui) ? (ui as BridgeUiSurface) : undefined;
    const setWidget = surface?.setWidget;
    if (surface === undefined || typeof setWidget !== "function") {
      noteSidebarUnavailable("ctx.ui has no setWidget, so a tui cannot be acquired");
      return { outcome: "no-set-widget" };
    }

    // `this` matters: Pi's setWidget is a method on the UI context.
    //
    // The factory's SECOND argument is Pi's theme (`dist/core/extensions/types.d.ts:113`: `(tui:
    // theme) => Component`), the same documented hand-out gentle-shell's own parts take their theme
    // from. The bridge keeps it so a section header and its rows paint in the host's roles instead
    // of the terminal's defaults (N11); without it the drawing is uncoloured and `/bridge-status`
    // says so.
    setWidget.call(surface, SIDEBAR_WIDGET_KEY, (tui: unknown, theme?: unknown) => {
      captured = isRecord(tui) ? (tui as SidebarTuiLike) : undefined;
      setSectionTheme(theme);
      // The renderer and the interception are installed from inside the factory: that is the first
      // moment a `tui` exists, and the resolver keeps working for a later re-install.
      installSectionRail();
      installSidebarBackend(() => captured);
      // The same hand-out is the only way to the conversation component (S4) and to the rail
      // component (R1), so both card-style wrappers arm here too — never at module load, never twice
      // (their marker decides), and every absence is a reported outcome instead of a throw inside
      // the host's factory. The captured `tui` is also what a bridge-owned write asks for a frame
      // through (R3), so it is remembered first: a later rail attach (the fullscreen layout may not
      // be mounted yet) reads it from there.
      setRepaintHost(captured);
      installCardStyleTransform(captured);
      installRailCardStyleTransform(captured);
      return { render: () => [], invalidate: () => {} };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    noteSidebarUnavailable(`setWidget threw: ${reason}`);
    return { outcome: "set-widget-threw", reason };
  }

  if (captured === undefined) {
    // The host accepted the factory but has not run it yet: there is nothing to intercept until it
    // does, and the reason is recorded instead of guessed.
    noteSidebarUnavailable("the setWidget factory has not run yet, so no tui is available");
    return { outcome: "awaiting-factory" };
  }
  return { outcome: "widget-installed" };
}

/** The part of Pi's `ExtensionAPI` this extension uses. */
export interface BridgeExtensionApi {
  on(event: "session_start" | "session_shutdown", handler: BridgeSessionHandler): void;
  registerCommand(
    name: string,
    command: { description?: string; handler: BridgeCommandHandler },
  ): void;
  /** Pi's cross-extension bus (`docs/extensions.md:1965-1972`); absent only in a bare harness. */
  events?: BridgeEventBus;
}

export default function gentleShellBridge(pi: BridgeExtensionApi): void {
  // The module load above already published the object; this factory is the first moment `pi` —
  // and therefore `pi.events` — exists, so it is where the process is told. Both calls are
  // idempotent: publishing again hands back the slot's object, and the announcement happens once
  // per process even when two copies of this package are loaded.
  publishBridgeApi();
  announceBridgeReady(pi.events);

  pi.on("session_start", (_event, ctx) => {
    // Without a UI there is no customize menu to reach, so there is nothing to arm. There is also
    // no `notify` to show a buffered notice with: those stay pending for the next UI session.
    if (ctx.hasUI !== true) return;
    // The in-TUI diagnostics channel. A notice produced at module load (an incompatible API slot)
    // has been waiting for this moment; delivered notices stay in the buffer, so `/bridge-status`
    // keeps reporting them afterwards.
    flushNotices(ctx.ui);
    armBridge(ctx.ui);
    // The `Sections` provider needs no `tui`, so it is installed even when the rail cannot be
    // reached: the user can still see and toggle a section. Re-installing is idempotent — the bus
    // replaces a provider with the same id in place.
    installSectionRows();
    // The card-style fallback line needs no `tui`: it is the bridge's own `Bridge card style` line,
    // registered only while the host's own line cannot be extended (the capture decides that, and
    // disposes this provider the moment it extends the host's line instead).
    installCardStyleRows();
    armSidebar(ctx.ui);
    // The ONE INTEGRATIONS line each plugin gets (I1–I6). A plugin that registered before any `ui`
    // existed is painted here; a plugin that registers later repaints its own key in place. A host
    // whose `ctx.ui` has no `setStatus` is recorded as unavailable instead of throwing (I6).
    installPluginStatus(ctx.ui);
  });

  // The footer row is session state, like everything the bridge paints: the host is told to drop
  // every key this module set (`undefined`) before the next bind, and the records survive so the
  // next `session_start` paints the same keys again (I5).
  pi.on("session_shutdown", () => {
    clearPluginStatus();
  });

  pi.registerCommand(STATUS_COMMAND, {
    description: "Show gentle-shell-bridge providers, backend, capture, store and plugin line diagnostics",
    handler: (_args, ctx) => {
      const report = formatStatus(collectStatus()).join("\n");
      ctx.ui?.notify?.(report, "info");
    },
  });
}
