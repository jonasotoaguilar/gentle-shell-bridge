/**
 * Sidebar rail interception (S4, S9): the backend that lets the bridge contribute to
 * gentle-shell's fullscreen rail.
 *
 * ## Why the rail map, and not an API
 *
 * The rail is painted from ONE process-global map: `Symbol.for("gentle-pi.experimental-sidebar.state")`
 * on the terminal object → `state.parts`, a `Map<string, SidebarRail>` (`lib/shell-sidebar.ts:6,78-90`).
 * The layout paints only the hard-coded keys `["todo","jobs","agents","footer"]`
 * (`lib/shell-sidebar-layout.ts:344`), so a new key never renders: appending to an existing part is
 * the only way in, and the `footer` part is the last one painted, which is why our sections can
 * follow every native section without interleaving (`lib/shell-bar.ts:247,251-316` keeps the status
 * sections in a closure we cannot reach — the documented limit).
 *
 * ## Order independence (S4)
 *
 * The host registers the `footer` part itself (`extensions/gentle-shell.ts:2681`), so our arming may
 * run before OR after it. The rail itself is therefore not the seam; the MAP is. On install we patch
 * the map instance's own `set` and `get`:
 *
 * - `set` wraps the value when the key is the rail we append to, so a registration that happens
 *   after our arm is captured with no polling;
 * - `get` wraps and stores on read, so a value written by a path that skipped our `set` (foreign
 *   code calling `Map.prototype.set`, a copy loaded before us) still arrives wrapped, and every
 *   later read returns the SAME wrapper object — stable identity matters, because the layout's memo
 *   compares the component and foreign readers compare `parts.get(key).spend` results.
 *
 * **Why patch the instance instead of subclassing or replacing the map:** `sidebarPart` and every
 * other reader re-reads `state.parts` from the state object, but nothing in the host forbids a
 * third-party extension from holding its own reference to the map it got earlier. A replacement
 * `Map` would leave those holders writing into a copy nobody intercepts, and a `Map` subclass cannot
 * be created from an existing map without changing its identity. Patching the instance's own
 * `set`/`get` (non-enumerable, configurable) keeps the identity every holder already has, keeps the
 * prototype's methods intact, and — unlike a prototype patch — is scoped to the one host map.
 * Restoring is exact: the own property is deleted, or the own descriptor that was there before is
 * put back.
 *
 * ## Wrapping a rail
 *
 * The wrapper spreads the host rail (`{ ...rail, render, cardGroups, handleMouse }`) so `digest`,
 * `spend`, `surface`, `summary`, `open`, `alert`, `invalidate` and every other field keep reaching
 * their readers with their identity untouched. `digest` is specifically NOT wrapped: the layout memo
 * keys on its value, and a wrapper that recomputed it would defeat the memo. The host's rails are
 * object literals (`extensions/gentle-shell.ts:2681`, `extensions/gentle-agents.ts:2172`), so an
 * own-property spread carries every field; a class instance whose methods live on the prototype
 * would need a prototype-preserving wrapper, which no host rail requires today.
 *
 * `render`/`cardGroups` delegate first and only then add. `handleMouse` delegates to the host's own
 * handler and consults our targets only where the host declined, so the original is never replaced.
 * `cardGroups` returns the host's own layout object untouched when nothing contributes.
 *
 * ## Markers and idempotency
 *
 * Same discipline as the row capture backend (`./capture.ts`): a marker certifies the EXACT function
 * or object it names, is read as an OWN property, and never through the prototype chain.
 *
 * - `PARTS_INTERCEPTED` (own property on the map) → the exact `set` function we installed. A second
 *   install, a rebind or a second copy of this package sees it and reports `already-intercepted`
 *   instead of stacking a second layer.
 * - `RAIL_WRAPPED` (own property on the wrapper) → the exact host rail object it wraps. That makes
 *   wrapping idempotent (re-wrapping our own wrapper would double every contributed group) and
 *   leaves a FOREIGN wrapper in place: we wrap around it, never replace it.
 *
 * ## Disable and foreign references
 *
 * `disableSidebarBackend()` puts the host's rail back and unpatches the map, then bumps the
 * generation. Every method the wrapper exposes captures the generation it was built in and degrades
 * to a plain pass-through afterwards, so a wrapper that foreign code kept a reference to cannot
 * contribute rows, groups or mouse targets once the backend is off.
 *
 * ## Getting a real `tui` (open wiring question)
 *
 * A rail state is reached through a `tui`: `sidebarState(tui)` reads `tui.terminal`
 * (`lib/shell-sidebar.ts:78-80`). Pi does not expose a `tui` getter: `ExtensionUIContext` has no such
 * member (verified in `dist/core/extensions/types.d.ts` — `TUI` appears only as a factory parameter).
 * The only surfaces that hand an extension's factory the real TUI are
 * `ctx.ui.setWidget(key, factory)` (`interactive-mode.js:1998`, `content(this.ui, theme)`),
 * `setFooter` (`:2084`), `setHeader`, `custom` and `setEditorComponent`, and each installs a rendered
 * component. So this backend takes the rail state from a RESOLVER the caller supplies
 * (`installSidebarBackend(() => tuiLike)`), which keeps the eventual acquisition path — a widget
 * factory that stores the `tui` it receives and then yields a component rendering no rows — a wiring
 * detail rather than a rewrite. Whether such an empty component leaves the editor area untouched is
 * UNCONFIRMED: it has not been observed in a running Pi TUI.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { isRecord } from "./rows.ts";
import { notePanelCandidate } from "./section-panel.ts";

/** The host's own state key: the seam this backend intercepts. Never our own state. */
const HOST_STATE = Symbol.for("gentle-pi.experimental-sidebar.state");

/** Process-global backend state, shared across copies like the bus (jiti's `moduleCache: false`). */
const BACKEND_STATE = Symbol.for("gentle-shell-bridge.sidebar.state.v1");
/** Own property on an intercepted map → the exact `set` function this module installed. */
const PARTS_INTERCEPTED = Symbol.for("gentle-shell-bridge.sidebar.parts.v1");
/** Own property on a wrapper rail → the exact host rail object it wraps. */
const RAIL_WRAPPED = Symbol.for("gentle-shell-bridge.sidebar.rail.v1");

/**
 * The part we append to. The layout paints `todo`, `jobs`, `agents`, `footer` in that order
 * (`lib/shell-sidebar-layout.ts:344`), so wrapping the last one puts our sections after every native
 * section; any other key would interleave.
 */
export const SIDEBAR_RAIL_KEY = "footer";

/** Row ranges of the section cards a part draws, as the host's `cardGroups` returns them. */
export interface RailGroupLayout {
  groups: Array<{ start: number; end: number }>;
  loose?: number[];
}

/** What a pointer handler answers: the host's `{ handled, render }`, or our target's own result. */
export interface RailMouseResult {
  handled?: boolean;
  render?: boolean;
  [key: string]: unknown;
}

/**
 * The part of a rail this backend depends on. Every OTHER own enumerable string-keyed property of
 * the host's rail is carried through the wrapper's spread — in practice `digest`, `spend`,
 * `surface`, `summary`, `open`, `alert` and `invalidate` — but "every field" would be false: a
 * non-enumerable property, a method that lives on the prototype, and a getter (snapshotted once at
 * wrap time) do not survive the spread. Every host rail observed so far is an object literal
 * (`extensions/gentle-shell.ts:2681`, `extensions/gentle-agents.ts:2172`), so nothing it carries is
 * lost; `test/sidebar-independent.test.ts` pins the limit rather than leaving it to prose.
 */
export interface SidebarRailLike {
  render(width: number): string[];
  cardGroups?(width: number): RailGroupLayout | undefined;
  /** The `Component`'s normalized mouse handler (`pi-tui` `Component.handleMouse`). */
  handleMouse?(event: unknown): RailMouseResult | undefined;
  /**
   * Cheap live-state digest; the layout memo skips re-renders while it holds (`digest !== undefined
   * ? existing.digest === digest : … cache.revision`, `lib/shell-sidebar-layout.ts:114-119`).
   *
   * A WRAPPER may answer `undefined` when neither the host nor a contributor has a signature: the
   * layout's reader (`railDigest`) treats that as "no digest" and falls back to the revision, which
   * is exactly how a rail without this member behaves. That case must stay distinguishable, so the
   * option is typed here rather than hidden behind a cast.
   */
  digest?(): string | undefined;
}

/**
 * A value in the host's rail map. The host types it as a map of rails; the bridge hands anything it
 * cannot wrap back unchanged instead of claiming every value is a rail, so a foreign write cannot
 * crash a read.
 */
export type RailMapValue = SidebarRailLike | Record<string, unknown> | undefined;

/** What a contributor adds to the wrapped part, appended after the host's own rows. */
export interface RailContribution {
  lines: string[];
  /** Card groups for `lines`, as row ranges RELATIVE to `lines[0]`; the wrapper offsets them. */
  groups: Array<{ start: number; end: number }>;
}

/**
 * The extension point the section renderer plugs into (T4). It knows nothing about sections: it
 * contributes rows and their card groups for one width, and may answer mouse events over them.
 */
export interface RailContributor {
  render(width: number): RailContribution | undefined;
  /**
   * A cheap signature of the live state the contributed rows paint (N14). The layout re-renders a
   * part only when its digest changes, so a row whose `meta` moved between frames must move this
   * value — otherwise the host would keep the cached rows and the field would look frozen.
   */
  digest?(): string;
  /**
   * Our own mouse targets; consulted only after the host's own handler declined the event. The
   * event's `y` is in the PART's frame, so `position.startRow` says which of those rows is the first
   * one this contributor rendered. Absent when no frame has been rendered at that width yet.
   */
  handleMouse?(event: unknown, position?: RailContributionPosition): RailMouseResult | undefined;
}

/** Where a contributor's rows sit inside the part's rendered frame. */
export interface RailContributionPosition {
  /** The index of the contributor's first row in the part's own `render(width)` output. */
  startRow?: number;
}

/**
 * A `tui`-like object: all this backend reads is `terminal`, which carries the host's rail state. The
 * index signature keeps the host's other members irrelevant instead of demanding an exact shape.
 */
export interface SidebarTuiLike {
  terminal?: unknown;
  [key: string]: unknown;
}

/**
 * Supplies the `tui`-like object whose `terminal` carries the host's rail state. Deliberately a
 * function: the real acquisition path may only have a `tui` later (see the module comment).
 */
export type SidebarTuiResolver = () => SidebarTuiLike | undefined;

export type SidebarInstallOutcome =
  | "intercepted"
  | "already-intercepted"
  | "no-sidebar-state"
  | "resolver-threw";

/**
 * What the wiring last recorded: an install attempt's outcome, or a problem that prevented one (no
 * `setWidget` surface, or a factory that has not run yet). `/bridge-status` reports the difference
 * between "we could not reach a rail" and "we never had a way to try".
 */
export type SidebarRecordedOutcome = SidebarInstallOutcome | "no-widget-surface";

/** What one install attempt did, so the caller and `/bridge-status` can report it. */
export interface InstallSidebarResult {
  installed: boolean;
  outcome: SidebarInstallOutcome;
  /** Whether the part we append to was already in the map when we looked. */
  rail: "wrapped" | "pending";
  /** Only for `resolver-threw`: the resolver's message. */
  reason?: string;
}

export type SidebarFailurePhase =
  | "render"
  | "cardGroups"
  | "contribute"
  | "handleMouse"
  | "digest";

/** A delegated host call or a contributor call that threw; recorded, never swallowed silently. */
export interface SidebarFailure {
  key: string;
  phase: SidebarFailurePhase;
  message: string;
}

export interface SidebarDiagnostics {
  /** Host rail maps currently intercepted in this process. */
  interceptedMaps: number;
  /** Rails currently wrapped (one per intercepted map that has the part). */
  wrappedRails: number;
  lastFailures: SidebarFailure[];
  /** The most recent install attempt's outcome; absent until the backend is installed once. */
  lastOutcome?: SidebarRecordedOutcome;
  /** Only for `resolver-threw` and `no-widget-surface`: the reason, verbatim. */
  lastReason?: string;
}

type Rail = SidebarRailLike & Record<string, unknown>;
type RailMap = Map<string, RailMapValue>;
type MapSet = RailMap["set"];
type MapGet = RailMap["get"];
type MapDelete = RailMap["delete"];
type MapClear = RailMap["clear"];

/** One patched map, with everything a restore needs. */
interface Interception {
  parts: RailMap;
  /** The own descriptor the map had before us, if any, so a restore is exact. */
  ownSet?: PropertyDescriptor;
  ownGet?: PropertyDescriptor;
  ownDelete?: PropertyDescriptor;
  ownClear?: PropertyDescriptor;
  /** The methods that were in force before us; a foreign patch stays reachable through them. */
  originalSet: MapSet;
  originalGet: MapGet;
  originalDelete: MapDelete;
  originalClear: MapClear;
  patchedSet: MapSet;
  patchedGet: MapGet;
  patchedDelete: MapDelete;
  patchedClear: MapClear;
}

/** One wrapped part, per (map, key), so a disable can put the host's own rail back. */
interface WrappedRailRecord {
  parts: RailMap;
  key: string;
  original: RailMapValue;
  wrapper: RailMapValue;
}

/** One render's worth of state, so `cardGroups` need not re-run the host or the contributor. */
interface RailMemoEntry {
  nativeLength: number;
  contribution?: RailContribution;
}

interface SidebarBackendState {
  /** Bumped by a disable/reset; a wrapper from an older generation is a pass-through. */
  generation: number;
  intercepted: Interception[];
  wrapped: WrappedRailRecord[];
  contributor?: RailContributor;
  lastFailures: SidebarFailure[];
  /** Remembered so `/bridge-status` can answer "was the rail ever reached?" (T6). */
  lastOutcome?: SidebarRecordedOutcome;
  lastReason?: string;
}

function backendHost(): Record<symbol, SidebarBackendState | undefined> {
  // SAFETY: only `sidebarState()` writes this key, and it validates every field before trusting a
  // value it finds, so a foreign or partial slot is replaced rather than used.
  return globalThis as unknown as Record<symbol, SidebarBackendState | undefined>;
}

function sidebarState(): SidebarBackendState {
  const host = backendHost();
  const existing = host[BACKEND_STATE];
  if (
    existing !== undefined &&
    typeof existing.generation === "number" &&
    Array.isArray(existing.intercepted) &&
    Array.isArray(existing.wrapped) &&
    Array.isArray(existing.lastFailures)
  ) {
    return existing;
  }
  const created: SidebarBackendState = {
    generation: 0,
    intercepted: [],
    wrapped: [],
    lastFailures: [],
  };
  host[BACKEND_STATE] = created;
  return created;
}

/** Diagnostics snapshot for `status` (T6) and for this backend's own tests. */
export function getSidebarDiagnostics(): SidebarDiagnostics {
  const state = sidebarState();
  return {
    interceptedMaps: state.intercepted.length,
    wrappedRails: state.wrapped.length,
    lastFailures: [...state.lastFailures],
    ...(state.lastOutcome === undefined ? {} : { lastOutcome: state.lastOutcome }),
    ...(state.lastReason === undefined ? {} : { lastReason: state.lastReason }),
  };
}

/** Test-only seam: forget every record and failure, so one test cannot leak into another. */
export function resetSidebarStateForTests(): void {
  const state = sidebarState();
  state.intercepted.length = 0;
  state.wrapped.length = 0;
  state.contributor = undefined;
  state.lastFailures.length = 0;
  delete state.lastOutcome;
  delete state.lastReason;
  // Bump so a wrapper a previous test retained becomes a pass-through instead of contributing.
  state.generation += 1;
}

/** Install (or clear) the renderer that contributes rows and groups to the wrapped part. */
export function setRailContributor(contributor: RailContributor | undefined): void {
  sidebarState().contributor = contributor;
}

/**
 * Record that the wiring could not even attempt an install — Pi's UI has no `setWidget`, or the
 * factory it accepted has not run yet. Reported by `/bridge-status` as unarmed WITH the reason, so
 * a missing section is explainable instead of silent. Never throws: reporting must not break a
 * session start.
 */
export function noteSidebarUnavailable(reason: string): void {
  const state = sidebarState();
  state.lastOutcome = "no-widget-surface";
  state.lastReason = reason;
}

/**
 * Intercept the host's rail map so our contribution reaches the part the layout paints, whether the
 * host registers that part before or after this call. Safe to call repeatedly: a second arm, a
 * rebind or a second copy of the package reports `already-intercepted` and installs nothing new.
 */
export function installSidebarBackend(resolveTui: SidebarTuiResolver): InstallSidebarResult {
  const result = attemptInstall(resolveTui);
  // Remembered for `/bridge-status`: "the rail was never reached" must be answerable (T6).
  const state = sidebarState();
  state.lastOutcome = result.outcome;
  if (result.reason === undefined) delete state.lastReason;
  else state.lastReason = result.reason;
  return result;
}

function attemptInstall(resolveTui: SidebarTuiResolver): InstallSidebarResult {
  let resolved: SidebarTuiLike | undefined;
  try {
    resolved = resolveTui();
  } catch (error) {
    // The wiring may not have a `tui` yet; that is a reported outcome, never a crash.
    return {
      installed: false,
      outcome: "resolver-threw",
      rail: "pending",
      reason: errorMessage(error),
    };
  }

  const parts = resolveParts(resolved);
  if (parts === undefined) return { installed: false, outcome: "no-sidebar-state", rail: "pending" };
  // One of the objects the bridge is handed: if a host ever publishes its panel builders on the
  // sidebar state, the section renderer uses them and `/bridge-status` says so (N11, N15).
  notePanelCandidate("the terminal sidebar state", hostSidebarStateOf(resolved));
  return intercept(parts);
}

/**
 * Read the host's rail map from a `tui`-like object, exactly as `sidebarState(tui)` does: the state
 * hangs on `tui.terminal`, never on the `tui` itself. Absent state is never created here — inventing
 * an empty map would fabricate host state and mask a wiring mistake.
 */
function resolveParts(tui: SidebarTuiLike | undefined): RailMap | undefined {
  const state = hostSidebarStateOf(tui);
  if (state === undefined) return undefined;
  const parts = state.parts;
  if (!(parts instanceof Map)) return undefined;
  // SAFETY: the host declares `parts` as `Map<string, SidebarRail>`, and `SidebarRailLike` is the
  // part of a rail this backend relies on; anything else a foreign writer puts there is handled
  // defensively by `isRailLike` before it is wrapped.
  return parts as RailMap;
}

/**
 * The host's sidebar state object, read from the `tui` exactly as `sidebarState(tui)` writes it
 * (`lib/shell-sidebar.ts:78-81`): the state hangs on `tui.terminal`, never on the `tui` itself.
 *
 * Exported for the pointer claim (`./section-pointer.ts`), which performs the host's own
 * `setSidebarHover` steps against the SAME published slots — `parts` here, `hover` there. One reader
 * for one seam: a second copy of this lookup would be a second place to get the symbol wrong.
 */
export function hostSidebarStateOf(tui: unknown): Record<string, unknown> | undefined {
  if (!isRecord(tui)) return undefined;
  const terminal = tui.terminal;
  if (!isRecord(terminal)) return undefined;
  // SAFETY: the host stores its state under a symbol key; `isRecord` already proved the terminal is
  // an object, and everything read below is re-validated before use.
  const state = (terminal as Record<symbol, unknown>)[HOST_STATE];
  return isRecord(state) ? state : undefined;
}

function intercept(parts: RailMap): InstallSidebarResult {
  const state = sidebarState();
  const existing = state.intercepted.find((record) => record.parts === parts);

  // The marker certifies the EXACT function we installed, read as an own property: a marker found
  // through the prototype chain describes some other object, and a marker whose value is not the
  // live `set` means foreign code replaced ours since (so we re-patch around it below).
  if (existing !== undefined && parts.set === existing.patchedSet) {
    // Already intercepted. Still make sure the part currently in the map is wrapped: a value that
    // arrived through a path which skipped our `set` is wrapped by our `get`.
    void parts.get(SIDEBAR_RAIL_KEY);
    return { installed: true, outcome: "already-intercepted", rail: railStatus(parts) };
  }
  if (existing !== undefined) state.intercepted.splice(state.intercepted.indexOf(existing), 1);

  const ownSet = Object.getOwnPropertyDescriptor(parts, "set");
  const ownGet = Object.getOwnPropertyDescriptor(parts, "get");
  const ownDelete = Object.getOwnPropertyDescriptor(parts, "delete");
  const ownClear = Object.getOwnPropertyDescriptor(parts, "clear");
  // Whatever is in force now stays reachable, so a foreign patch already on the map keeps running.
  const originalSet = parts.set;
  const originalGet = parts.get;
  const originalDelete = parts.delete;
  const originalClear = parts.clear;

  const patchedSet = function (this: RailMap, key: string, value: RailMapValue) {
    const stored = key === SIDEBAR_RAIL_KEY ? wrapRail(parts, key, value) : value;
    return originalSet.call(this, key, stored);
  } as MapSet;

  const patchedGet = function (this: RailMap, key: string) {
    const value = originalGet.call(this, key);
    if (key !== SIDEBAR_RAIL_KEY || value === undefined) return value;
    const wrapped = wrapRail(parts, key, value);
    if (wrapped === value) return value;
    // Store through the ORIGINAL set: re-entering our own patch would wrap twice for nothing.
    originalSet.call(this, key, wrapped);
    return wrapped;
  } as MapGet;

  // Deletion prunes the wrapped record, so diagnostics cannot claim a part is wrapped after the host
  // dropped it.
  const patchedDelete = function (this: RailMap, key: string): boolean {
    const deleted = originalDelete.call(this, key);
    if (deleted) forgetWrapped(parts, key);
    return deleted;
  } as MapDelete;

  const patchedClear = function (this: RailMap): void {
    originalClear.call(this);
    forgetWrapped(parts);
  } as MapClear;

  defineHidden(parts, "set", patchedSet);
  defineHidden(parts, "get", patchedGet);
  defineHidden(parts, "delete", patchedDelete);
  defineHidden(parts, "clear", patchedClear);
  defineHidden(parts, PARTS_INTERCEPTED, patchedSet);

  state.intercepted.push({
    parts,
    ownSet,
    ownGet,
    ownDelete,
    ownClear,
    originalSet,
    originalGet,
    originalDelete,
    originalClear,
    patchedSet,
    patchedGet,
    patchedDelete,
    patchedClear,
  });
  void parts.get(SIDEBAR_RAIL_KEY);
  return { installed: true, outcome: "intercepted", rail: railStatus(parts) };
}

/** Drop the wrapped-rail records for a part, so a deleted or cleared key is not reported as wrapped. */
function forgetWrapped(parts: RailMap, key?: string): void {
  const state = sidebarState();
  for (let index = state.wrapped.length - 1; index >= 0; index -= 1) {
    const record = state.wrapped[index];
    if (record.parts !== parts) continue;
    if (key !== undefined && record.key !== key) continue;
    state.wrapped.splice(index, 1);
  }
}

function railStatus(parts: RailMap): "wrapped" | "pending" {
  return parts.get(SIDEBAR_RAIL_KEY) === undefined ? "pending" : "wrapped";
}

/** Put the host's own rail back and unpatch every map we intercepted. Returns rails restored. */
export function disableSidebarBackend(): number {
  const state = sidebarState();
  const rails = state.wrapped.splice(0);
  let restored = 0;

  for (const interception of state.intercepted.splice(0)) {
    for (const rail of rails) {
      if (rail.parts !== interception.parts) continue;
      // Write through the ORIGINAL methods: our own `set` would wrap the host's rail again.
      const current = interception.originalGet.call(interception.parts, rail.key);
      if (current !== rail.wrapper) continue; // foreign code replaced it since: leave its value
      interception.originalSet.call(interception.parts, rail.key, rail.original);
      restored += 1;
    }
    restoreOwnMethod(interception.parts, "set", interception.patchedSet, interception.ownSet);
    restoreOwnMethod(interception.parts, "get", interception.patchedGet, interception.ownGet);
    restoreOwnMethod(
      interception.parts,
      "delete",
      interception.patchedDelete,
      interception.ownDelete,
    );
    restoreOwnMethod(
      interception.parts,
      "clear",
      interception.patchedClear,
      interception.ownClear,
    );
    if (Object.hasOwn(interception.parts, PARTS_INTERCEPTED)) {
      // SAFETY: the marker is the only symbol-keyed property this module writes on the map, and a
      // `Map` is an object, so it is reachable through a widened index type; this only removes it.
      delete (interception.parts as unknown as Record<PropertyKey, unknown>)[PARTS_INTERCEPTED];
    }
  }

  // A wrapper retained by foreign code becomes a pass-through through this bump. The remembered
  // outcome stays: "installed once, now off" is what lets `/bridge-status` answer "unarmed" rather
  // than "never attempted".
  state.generation += 1;
  return restored;
}

function restoreOwnMethod(
  parts: RailMap,
  name: "set" | "get" | "delete" | "clear",
  patched: unknown,
  own: PropertyDescriptor | undefined,
): void {
  // SAFETY: `parts` is a real `Map`, i.e. an object; `set`/`get` are ordinary string-keyed
  // properties of it, so reading and deleting them through a widened index type is exact.
  const target = parts as unknown as Record<string, unknown>;
  if (target[name] !== patched) return; // not ours any more: never clobber a foreign patch
  if (own === undefined) delete target[name];
  else Object.defineProperty(parts, name, own);
}

/**
 * Wrap one host rail, once. A value that is already our wrapper is returned unchanged, which is what
 * keeps a second install, a rebind and a second package copy from stacking wrappers or doubling the
 * contributed card groups.
 */
function wrapRail(parts: RailMap, key: string, rail: RailMapValue): RailMapValue {
  if (!isRailLike(rail)) return rail;
  if (isOurWrapper(rail)) return rail;

  const state = sidebarState();
  const original = rail;
  const generation = state.generation;
  const memo = new Map<number, RailMemoEntry>();

  const wrapper: Rail = {
    ...original,
    render: (width: number) => renderThrough(key, original, generation, memo, width),
    cardGroups: (width: number) => groupsThrough(key, original, generation, memo, width),
    handleMouse: (event: unknown) => mouseThrough(key, original, generation, memo, event),
  };

  // The host's panel builders are looked for on the part itself (N11, N15): if a host ever publishes
  // `renderPanelHeader`/`renderPanelRow` here, the section renderer uses them instead of its local
  // port, and `/bridge-status` says so. Looking on every object the bridge is handed is what makes
  // "the host's builders are unreachable" a measurement rather than a claim.
  notePanelCandidate("the rail part", original);

  // The digest is the one field that is not a pass-through (N14): the layout memo re-renders a part
  // only when its digest VALUE moves, so a live row field (`meta`) would otherwise never repaint.
  // The field therefore stays a function whose value is the host's own digest, unchanged, whenever
  // nothing contributes one — the passthrough tests pin the VALUE, because the memo compares values
  // and never function identity. When a contributor has a signature, it is appended, so a change in
  // the built rows reaches the memo as a new key.
  wrapper.digest = () => digestValue(key, original, generation);

  Object.defineProperty(wrapper, RAIL_WRAPPED, {
    value: original,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(wrapper, "railMemo", {
    value: memo,
    enumerable: false,
    configurable: true,
  });

  const record: WrappedRailRecord = { parts, key, original, wrapper };
  const index = state.wrapped.findIndex((entry) => entry.parts === parts && entry.key === key);
  if (index === -1) state.wrapped.push(record);
  else state.wrapped[index] = record;
  return wrapper;
}

function isRailLike(value: RailMapValue): value is Rail {
  return isRecord(value) && typeof value.render === "function";
}

/** Own-property identity check: the marker's value is the exact rail this object wraps. */
function isOurWrapper(value: RailMapValue): boolean {
  if (!isRecord(value) || !Object.hasOwn(value, RAIL_WRAPPED)) return false;
  // SAFETY: the only writer of this symbol key is `wrapRail` above, whose value is a rail object.
  return isRecord((value as Record<symbol, unknown>)[RAIL_WRAPPED]);
}

/** Delegate to the host's `render`, then append the contribution — if the host painted anything. */
function renderThrough(
  key: string,
  original: Rail,
  generation: number,
  memo: Map<number, RailMemoEntry>,
  width: number,
): string[] {
  if (sidebarState().generation !== generation) return [...(original.render(width) ?? [])];

  let native: string[];
  try {
    native = [...(original.render(width) ?? [])];
  } catch (error) {
    recordFailure(key, "render", error);
    // Never swallowed: the host's own failure path decides what a throwing part means.
    throw error;
  }

  if (native.length === 0) {
    // The host painted no frame (rail inactive, compact work row, another surface owns it). A frame
    // of ours here would appear exactly where the host suppressed its own.
    remember(memo, width, { nativeLength: 0 });
    return native;
  }

  const contribution = contributionFor(key, width);
  remember(memo, width, { nativeLength: native.length, contribution });
  return contribution === undefined ? native : [...native, ...contribution.lines];
}

/** Delegate to the host's `cardGroups`, then append our groups offset by the host's row count. */
function groupsThrough(
  key: string,
  original: Rail,
  generation: number,
  memo: Map<number, RailMemoEntry>,
  width: number,
): RailGroupLayout | undefined {
  if (sidebarState().generation !== generation) return original.cardGroups?.(width);

  const remembered = memo.get(width);
  let nativeLength = remembered?.nativeLength;
  if (nativeLength === undefined) {
    // `cardGroups` without a preceding `render`. The host always renders first (it needs the rows
    // before it asks for their ranges), so this is a fallback: measure instead of dropping our
    // groups silently, and let a throw surface exactly like it does through `render`.
    try {
      nativeLength = [...(original.render(width) ?? [])].length;
    } catch (error) {
      recordFailure(key, "render", error);
      throw error;
    }
  }
  const contribution =
    remembered !== undefined ? remembered.contribution : contributionFor(key, width);
  if (remembered === undefined) remember(memo, width, { nativeLength, contribution });

  let base: RailGroupLayout | undefined;
  try {
    base = original.cardGroups?.(width);
  } catch (error) {
    recordFailure(key, "cardGroups", error);
    throw error;
  }
  // Same default the layout applies: without `cardGroups` a part is one section headed by its first
  // row, and that one section must cover the rows we append too.
  const hostLayout: RailGroupLayout = base ?? { groups: [{ start: 0, end: nativeLength }] };

  if (contribution === undefined || nativeLength === 0 || contribution.groups.length === 0) {
    // Nothing of ours: the host's own layout object, untouched.
    return hostLayout;
  }

  return {
    groups: [
      ...hostLayout.groups,
      ...contribution.groups.map((group) => ({
        start: group.start + nativeLength,
        end: group.end + nativeLength,
      })),
    ],
    ...(hostLayout.loose === undefined ? {} : { loose: hostLayout.loose }),
  };
}

/** Delegate mouse dispatch to the host's own handler; our targets answer only where it declined. */
function mouseThrough(
  key: string,
  original: Rail,
  generation: number,
  memo: Map<number, RailMemoEntry>,
  event: unknown,
): RailMouseResult | undefined {
  const hostHandler = original.handleMouse;
  if (sidebarState().generation !== generation) {
    return typeof hostHandler === "function" ? hostHandler.call(original, event) : undefined;
  }

  if (typeof hostHandler === "function") {
    let result: RailMouseResult | undefined;
    try {
      result = hostHandler.call(original, event);
    } catch (error) {
      recordFailure(key, "handleMouse", error);
      throw error;
    }
    // The host's targets win whenever it handled the event: we add targets, never override.
    if (result !== undefined) return result;
  }

  const contributor = sidebarState().contributor;
  if (contributor?.handleMouse === undefined) return undefined;
  try {
    return contributor.handleMouse(event, contributionPosition(memo, event));
  } catch (error) {
    recordFailure(key, "handleMouse", error);
    return undefined; // a broken target must not break the host's dispatch
  }
}

/**
 * Where the contributor's rows start in the frame this event was mapped into.
 *
 * The host maps a hit to the part's own coordinates before calling its `handleMouse`
 * (`lib/shell-sidebar-layout.ts:245-259`), so `y` counts the HOST's rows first; the render that
 * preceded the event recorded how many there were at that width. Without such a frame there is
 * nothing to map, and the contributor declines instead of guessing an offset.
 */
function contributionPosition(
  memo: Map<number, RailMemoEntry>,
  event: unknown,
): RailContributionPosition {
  if (!isRecord(event)) return {};
  const width = event.width;
  if (typeof width !== "number") return {};
  const entry = memo.get(width);
  if (entry === undefined) return {};
  return { startRow: entry.nativeLength };
}

/**
 * The part's digest: the host's own value when nothing contributes one, otherwise the host's value
 * with the contributor's signature appended (N14).
 */
function digestValue(key: string, original: Rail, generation: number): string | undefined {
  const hostDigest = original.digest;
  const raw = typeof hostDigest === "function" ? hostDigest.call(original) : undefined;
  // A foreign rail can return anything; only a string is a digest the layout can compare.
  const hostValue = typeof raw === "string" ? raw : undefined;
  if (sidebarState().generation !== generation) return hostValue;
  const contributor = sidebarState().contributor;
  if (contributor?.digest === undefined) return hostValue;
  let contribution: string;
  try {
    contribution = contributor.digest();
  } catch (error) {
    // A broken signature must not take the host's memo down with it: record it and stay on the
    // host's own digest, which degrades to invalidation-only, exactly as the layout does.
    recordFailure(key, "digest", error);
    return hostValue;
  }
  return `${hostValue ?? ""}|${contribution}`;
}

function contributionFor(key: string, width: number): RailContribution | undefined {
  const contributor = sidebarState().contributor;
  if (contributor === undefined) return undefined;
  let contribution: RailContribution | undefined;
  try {
    contribution = contributor.render(width);
  } catch (error) {
    // A broken renderer loses its own rows and nothing else (S8): record it, draw the host's rows.
    recordFailure(key, "contribute", error);
    return undefined;
  }
  if (contribution === undefined || contribution.lines.length === 0) return undefined;
  return contribution;
}

function remember(memo: Map<number, RailMemoEntry>, width: number, entry: RailMemoEntry): void {
  if (memo.size > 32) memo.clear();
  memo.set(width, entry);
}

function recordFailure(key: string, phase: SidebarFailurePhase, error: unknown): void {
  const state = sidebarState();
  state.lastFailures.push({ key, phase, message: errorMessage(error) });
  if (state.lastFailures.length > 32) state.lastFailures.splice(0, state.lastFailures.length - 32);
}

function defineHidden<T extends object>(target: T, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
