/**
 * Repaint triggers (R3) and per-surface bookkeeping (R4): the half of a bridge-owned write that
 * makes it visible.
 *
 * ## Why a write needs to ask for a frame
 *
 * The bridge owns state that a HOST surface draws: a section's visibility (the rail paints the
 * section) and the card-style selection (both surfaces paint chrome from it). The bridge persists
 * that state synchronously — the host's row renderer re-reads `current()` when it repaints — but
 * persistence alone changes nothing on screen: gentle-shell re-renders a rail part only when its
 * digest changes or when the layout's own revision counter moves
 * (`lib/shell-sidebar-layout.ts:310-350`). That counter is what a part OWNER bumps:
 *
 * ```ts
 * if (sidebarTui) invalidateSidebar(sidebarTui);   // lib/shell-sidebar-layout.ts:105-107
 * host?.requestRender();                           // extensions/gentle-agents.ts:2147-2148
 * ```
 *
 * Both calls are the host's documented contract for "I changed what your rail shows". This package
 * cannot import gentle-shell's modules (Pi loads every extension through its own jiti loader with
 * `moduleCache: false`), so the two steps are performed against the same published state the host
 * itself uses:
 *
 * 1. `invalidateSidebar(tui)` is exactly `tui.terminal[CACHE].revision++`, where `CACHE` is
 *    `Symbol.for("gentle-pi.experimental-sidebar.cache")` — the symbol the host declares and reads
 *    (`lib/shell-sidebar-layout.ts:97-107`, `symbol.for` so every loaded copy shares it);
 * 2. `tui.invalidate()` (`pi-tui/dist/tui.js:585-590`), which drops every mounted component's own
 *    frame cache — the caches that would otherwise hand back the rows of the PREVIOUS value (the
 *    host bash card's `ToolCardRows`, `cards-bash-v2` `extensions/quiet-tools.ts:926-966`);
 * 3. `tui.requestRender(true)`: a forced frame (`tui.js:658-663`), so a render already queued cannot
 *    dedupe this one away.
 *
 * Steps 2 and 3 are the plugin-facing `requestRepaint()` (T4), and every repaint path here uses that
 * one forced path — bridge-owned rows cache their frames exactly the same way.
 *
 * Nothing else: no timer, no poll, no retry. A repaint that cannot happen is RECORDED and reported
 * by `/bridge-status` (`./status.ts`), because "the toggle did nothing" must always have an answer.
 *
 * ## Surfaces
 *
 * Two surfaces paint bridge-owned chrome: the conversation (the component
 * `./card-style-wiring.ts` wraps) and the rail (the host's rail component, wrapped the same way).
 * The reach of each is recorded where the attach is attempted, so a report can say "the rail was
 * never reached, and why" instead of only "no frame".
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { isRecord } from "./rows.ts";

/** What a plugin-facing full repaint records as its cause, so `/bridge-status` reads as a sentence. */
const PLUGIN_REPAINT_CAUSE = "a plugin asked for a full repaint";

/** Why nothing could be repainted: no host was captured at all. */
const NO_HOST_REASON = "no tui has been captured, so no surface can be repainted";

/** Why nothing could be repainted: the captured host has no frame request on it. */
const NO_FRAME_REQUEST_REASON =
  "the captured tui has no requestRender(), so no frame can be asked for";

/** The surfaces a card style can paint. Order is the order the report prints. */
export const PAINT_SURFACES = ["conversation", "rail"] as const;

export type PaintSurface = (typeof PAINT_SURFACES)[number];

/**
 * The host's terminal-side frame cache (`lib/shell-sidebar-layout.ts:97-107`). Symbol-keyed, so
 * every separately loaded copy of the host shares one counter per terminal.
 */
export const HOST_SIDEBAR_CACHE: symbol = Symbol.for("gentle-pi.experimental-sidebar.cache");

/** Whether a surface's repaint path was reached, and why not when it was not. */
export interface SurfaceReach {
  reached: boolean;
  /** Only when `reached` is false: the attach outcome, e.g. `no-layout-root`. */
  reason?: string;
}

/** What one `action()` did about the screen, as `/bridge-status` prints it. */
export interface RepaintTrigger {
  /** What changed, as a person reads it: `section "loon.music" → hidden`. */
  cause: string;
  /** The surfaces that display it, and whose repaint was requested. */
  surfaces: PaintSurface[];
  outcome: "repainted" | "unavailable";
  /** Only for `unavailable`: why no frame could be requested. */
  reason?: string;
}

export interface RepaintDiagnostics {
  /** Whether a `tui` has been captured yet; without one nothing can be repainted. */
  hostCaptured: boolean;
  reach: Partial<Record<PaintSurface, SurfaceReach>>;
  lastTrigger?: RepaintTrigger;
}

/** The host object Pi hands the widget factory, as far as this module reads it. */
export type RepaintHost = Record<string, unknown>;

interface RepaintState {
  tui?: unknown;
  reach: Partial<Record<PaintSurface, SurfaceReach>>;
  lastTrigger?: RepaintTrigger;
}

/** Process-global, like every other piece of bridge state (`./bus.ts` explains why). */
const REPAINT_STATE = Symbol.for("gentle-shell-bridge.repaint.state.v1");

function repaintHost(): Record<symbol, RepaintState | undefined> {
  // SAFETY: only `repaintState()` writes this key, and it re-checks the shape it finds.
  return globalThis as unknown as Record<symbol, RepaintState | undefined>;
}

/**
 * The slot's shape, checked before use so a value another copy or an older load left behind is
 * replaced rather than trusted. `tui` and `lastTrigger` are only ever copied or replaced wholesale,
 * and both readers re-validate what they read.
 */
function isRepaintStateLike(value: unknown): value is RepaintState {
  return isRecord(value) && isRecord(value.reach);
}

function repaintState(): RepaintState {
  const host = repaintHost();
  const existing = host[REPAINT_STATE];
  if (isRepaintStateLike(existing)) return existing;
  const created: RepaintState = { reach: {} };
  host[REPAINT_STATE] = created;
  return created;
}

/**
 * Remember the `tui` Pi handed the widget factory (`./extension.ts`): the one documented hand-out,
 * and the only object whose `requestRender()` reaches the host's render loop.
 */
export function setRepaintHost(tui: unknown): void {
  repaintState().tui = tui;
}

/** The captured `tui`, for a caller that must attempt an attach before asking for a frame. */
export function getRepaintHost(): RepaintHost | undefined {
  const tui = repaintState().tui;
  return isRecord(tui) ? tui : undefined;
}

/** Record whether one surface's repaint path was reached (called where the attach is attempted). */
export function recordSurfaceReach(surface: PaintSurface, reach: SurfaceReach): void {
  repaintState().reach[surface] =
    reach.reached || reach.reason === undefined
      ? { reached: reach.reached }
      : { reached: false, reason: reach.reason };
}

/** The reach last recorded for one surface. */
export function getSurfaceReach(surface: PaintSurface): SurfaceReach | undefined {
  const reach = repaintState().reach[surface];
  return reach === undefined ? undefined : { ...reach };
}

/** Diagnostics snapshot for `/bridge-status` (R4) and for this module's own tests. */
export function getRepaintDiagnostics(): RepaintDiagnostics {
  const state = repaintState();
  const reach: Partial<Record<PaintSurface, SurfaceReach>> = {};
  for (const surface of PAINT_SURFACES) {
    const recorded = state.reach[surface];
    if (recorded !== undefined) reach[surface] = { ...recorded };
  }
  return {
    hostCaptured: state.tui !== undefined,
    reach,
    ...(state.lastTrigger === undefined ? {} : { lastTrigger: { ...state.lastTrigger } }),
  };
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetRepaintForTests(): void {
  const state = repaintState();
  delete state.tui;
  state.reach = {};
  delete state.lastTrigger;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bump the host's cache revision exactly as `invalidateSidebar(tui)` does
 * (`lib/shell-sidebar-layout.ts:105-107`): `tui.terminal[CACHE].revision++`, creating the slot the
 * host creates on its first invalidate. Never throws: a terminal that cannot carry the slot is a
 * non-host object, and the `requestRender()` that follows is still worth attempting.
 */
function invalidateHostSidebar(tui: Record<string, unknown>): void {
  try {
    const terminal = tui.terminal;
    if (!isRecord(terminal)) return;
    // SAFETY: the host stores a `{ revision: number }` object under this symbol on the terminal
    // (`lib/shell-sidebar-layout.ts:99-107`); a value of any other shape is replaced by the same
    // default the host itself uses, never trusted.
    const slot = terminal as Record<symbol, unknown>;
    const existing = slot[HOST_SIDEBAR_CACHE];
    if (isRecord(existing) && typeof existing.revision === "number") {
      existing.revision += 1;
      return;
    }
    slot[HOST_SIDEBAR_CACHE] = { revision: 1 };
  } catch {
    // A frozen terminal cannot be invalidated; the frame request below is still honest.
  }
}

/**
 * Drop the host's caches so the next frame is BUILT, not replayed.
 *
 * Two caches stand between a setting change and the pixels:
 *
 * 1. the rail layout's revision counter, bumped exactly as `invalidateSidebar(tui)` does
 *    (`lib/shell-sidebar-layout.ts:105-107`);
 * 2. every mounted component's OWN frame cache, through `tui.invalidate()`
 *    (`pi-tui/dist/tui.js:585-590`), which walks the mounted roots and calls each component's
 *    `invalidate()`. That is what drops a per-component frame like the host bash card's
 *    `ToolCardRows` (`cards-bash-v2` `extensions/quiet-tools.ts:926-966`): without it a forced frame
 *    repaints the chrome around rows that were drawn under the previous preference.
 *
 * Neither step may throw into a caller: a tree that refuses to drop a frame keeps it, and the forced
 * frame request that follows is still worth making.
 */
function invalidateHost(tui: Record<string, unknown>): void {
  invalidateHostSidebar(tui);
  try {
    const invalidate = tui.invalidate;
    if (typeof invalidate === "function") invalidate.call(tui);
  } catch {
    // A component (or a terminal) that refuses to invalidate keeps its frame; see above.
  }
}

/**
 * The one place a frame is asked for, shared by every repaint path.
 *
 * Order matters and is asserted by the tests: the host's caches are dropped FIRST, then a frame is
 * requested with `force = true` (`pi-tui/dist/tui.js:658-663`), which resets the renderer's state and
 * renders immediately instead of being deduped away by a render already queued. Returns the reason
 * the frame could not be asked for, or `undefined` when it was.
 */
function requestFrame(input: {
  cause: string;
  surfaces: readonly PaintSurface[];
}): RepaintTrigger {
  const state = repaintState();
  const record = (outcome: RepaintTrigger["outcome"], reason?: string): RepaintTrigger => {
    const trigger: RepaintTrigger = {
      cause: input.cause,
      surfaces: [...input.surfaces],
      outcome,
      ...(reason === undefined ? {} : { reason }),
    };
    state.lastTrigger = trigger;
    return { ...trigger, surfaces: [...trigger.surfaces] };
  };

  const tui = state.tui;
  if (!isRecord(tui)) return record("unavailable", NO_HOST_REASON);
  const requestRender = tui.requestRender;
  if (typeof requestRender !== "function") return record("unavailable", NO_FRAME_REQUEST_REASON);

  invalidateHost(tui);
  try {
    requestRender.call(tui, true);
  } catch (error) {
    // A host that refuses a frame is reported, never swallowed: the write DID land, the screen did
    // not change, and only a report can distinguish that from "the toggle is broken".
    return record("unavailable", `requestRender threw: ${errorMessage(error)}`);
  }
  return record("repainted");
}

/**
 * Ask the host for a frame after a write to bridge-owned state (R3).
 *
 * Runs synchronously, before the caller's action returns: the host's cache invalidation and then a
 * FORCED `requestRender()` (T4) — bridge-owned rows are drawn by a component that caches its own
 * frame, so an unforced request can hand back the rows of the previous value. Records the trigger —
 * cause, surfaces, outcome — so `/bridge-status` can report the last one, including the reason a
 * repaint could not happen.
 */
export function requestSurfaceRepaint(input: {
  cause: string;
  surfaces: readonly PaintSurface[];
}): RepaintTrigger {
  return requestFrame(input);
}

/**
 * Force a FULL repaint of everything the host draws (T4): the plugin-facing request behind
 * `api.requestRepaint()`.
 *
 * This is what a setting change needs to reach the cards ALREADY on screen. The host resolves a tool
 * row once and then caches the frame it drew (`ToolCardRows`, `cards-bash-v2`
 * `extensions/quiet-tools.ts:926-966`), so a new value alone changes the next card and nothing else.
 * `tui.invalidate()` drops those per-component frames and `requestRender(force = true)` draws the
 * whole surface again from them — the past and the future, not only the future.
 *
 * Both surfaces are named, because both paint chrome from the setting. Safe with no host captured
 * yet (a plugin may ask from its own `session_start`): the request is REPORTED as `unavailable` with
 * its reason, never thrown, and never queued for a host that may never arrive.
 */
export function requestRepaint(): RepaintTrigger {
  return requestFrame({ cause: PLUGIN_REPAINT_CAUSE, surfaces: PAINT_SURFACES });
}
