/**
 * Capture backend (docs/architecture.md §2–§5, docs/contract.md §5, §7).
 *
 * gentle-shell's `ctx.ui.custom` factory returns a plain adapter, not the view, so the rows
 * array is unreachable by duck-typing. The only reachable moment is the view constructor's
 * `options.rows.map(...)` (`lib/visual-customize-view.ts:387`), which runs synchronously inside
 * the factory call. So: swap `Array.prototype.map` for the duration of the outermost factory
 * call, record every row-like array it is invoked on BY REFERENCE, restore the original in
 * `finally`, then push the providers' rows into that captured array and invalidate the adapter.
 *
 * ## Capture-selection rule (why a wrong target can never be silent)
 *
 * Each wrapped `custom` call owns one capture *session* and one candidate list, and the probe
 * records a mapped array into the innermost active session only. The probe is installed around the
 * FACTORY INVOCATION, not around the host call, so a host that resolves its factory in a later
 * microtask (`Promise.resolve().then(factory)`) is still covered; a factory that itself returns a
 * promise stays the documented unsupported case. That makes attribution exact:
 *
 * - A nested `custom` call — from the host factory or from a provider's own `rows()` — gets its
 *   own session, so it can never steal the outer menu's capture, and its menu receives its own
 *   injection.
 * - A nested session that throws never reaches resolution, so nothing is injected into it; the
 *   outer session continues and resolves its own array.
 * - If ONE session captures more than one row-like array (an incidental row-shaped array before
 *   the menu, for example) the bridge does not guess: the outcome is
 *   `uncaptured (ambiguous)` and nothing is injected. Diagnostics never claim an injection into
 *   an array that received nothing.
 *
 * Arming is idempotent per target: the non-enumerable marker holds the exact wrapper function it
 * installed, and is read as an OWN property, so a rebind that installs a new `custom` on an
 * instance inheriting an already-wrapped prototype always rearms. Every wrapper also carries the
 * generation it was created in: `disableCaptureBackend()` bumps the generation, so a wrapper that
 * foreign code kept a reference to becomes a plain pass-through instead of injecting later.
 *
 * Shared state lives on `globalThis` behind a `Symbol.for` key, like the bus: a second copy of
 * this package loaded by jiti's `moduleCache: false` must see the same arming, the same sessions
 * and the same diagnostics.
 */

import { extendCardStyleLine } from "./card-style-rows.ts";
import { buildRows, createRowContext, type RowBuildFailure } from "./rows.ts";
import type { CustomizeRow } from "./types.ts";

/** Marks a UI target this module wrapped; the value is the wrapper function it installed. */
const CAPTURE_WRAPPED = Symbol.for("gentle-shell-bridge.capture.wrapped.v1");
/** Marks a captured rows array that already received an injection. */
const CAPTURE_INJECTED = Symbol.for("gentle-shell-bridge.capture.injected.v1");
/** Process-global arming/diagnostics slot. */
const CAPTURE_STATE = Symbol.for("gentle-shell-bridge.capture.state.v1");

/**
 * Minimum length for a mapped array to count as the host's rows array.
 *
 * There is no type or name to key on, so the shape test is structural: an array of at least
 * three objects that each expose a callable `action`. The threshold comes from the probe that
 * proved this technique in the real TUI, where the customize menu builds far more than three
 * rows; three keeps incidental one- and two-element arrays of objects out of the capture without
 * matching anything smaller. The cost is explicit: a host menu with fewer than three rows is
 * below the threshold and would not be captured.
 */
const MIN_ROW_ARRAY_LENGTH = 3;

/** A provider that threw while its rows were built; its rows were dropped. */
export type CaptureFailure = RowBuildFailure;

/** Outcome of the most recent menu build the backend observed. */
export interface CaptureOutcome {
  kind: "injected" | "uncaptured" | "already-injected";
  /** How many rows this backend pushed into the captured array. */
  injectedRows: number;
  /** Only for `uncaptured`: why nothing was injected. */
  reason?: "async-factory" | "no-capture" | "ambiguous" | "factory-threw";
}

/** What diagnostics (`status`, S6) reads from the capture backend. */
export interface CaptureDiagnostics {
  /** Number of UI targets currently wrapped in this process. */
  armedTargets: number;
  /** Nesting depth of in-flight `custom` calls; 0 when idle. */
  nestingDepth: number;
  lastOutcome?: CaptureOutcome;
  /** Failures recorded during the most recent menu build. */
  lastFailures: CaptureFailure[];
}

/** Result of one arming attempt, so diagnostics can report why nothing was armed. */
export interface InstallCaptureResult {
  armed: boolean;
  /** Where the wrapper landed: the instance's own `custom`, the prototype's, or nowhere. */
  target: "instance" | "prototype" | "none";
  outcome: "armed" | "already-armed" | "no-custom";
}

/**
 * What the host's `custom` hands back: the plain adapter component gentle-shell returns
 * (`gentle-shell.ts:3550-3562`), possibly wrapped in a promise (`interactive-mode.ts:3136`).
 * Opaque by design — the bridge only ever calls `invalidate()`, and only on the sync shape.
 */
export interface HostComponent {
  invalidate?: () => void;
  [key: string]: unknown;
}

export type HostCustomResult = HostComponent | PromiseLike<HostComponent>;

type HostCustom = (this: unknown, factory: unknown, ...rest: unknown[]) => HostCustomResult;
type HostFactory = (ui: unknown, theme: unknown, ...rest: unknown[]) => HostCustomResult;
/** `Array.prototype.map` with the argument types widened, for the temporary patch only. */
type LooseMap = (this: unknown, callback: unknown, thisArg?: unknown) => unknown[];

type MutableTarget = Record<PropertyKey, unknown> & { custom?: unknown };

type CaptureWrapper = (this: unknown, ...args: unknown[]) => HostCustomResult;

/** One wrapped `custom` call in flight, with the arrays its factory mapped. */
interface CaptureSession {
  candidates: CustomizeRow[][];
}

interface CaptureState {
  armedTargets: number;
  nestingDepth: number;
  /** Bumped by `disableCaptureBackend()`; a wrapper from an older generation is a pass-through. */
  generation: number;
  /** Innermost last: a mapped array is recorded into the top session only. */
  sessions: CaptureSession[];
  /** The `Array.prototype.map` in force before the probe was installed, while it is installed. */
  savedMap?: typeof Array.prototype.map;
  lastOutcome?: CaptureOutcome;
  lastFailures: CaptureFailure[];
  /** One record per wrapped target, so a backend transition can restore the host's own method. */
  wrappers: Array<{ target: MutableTarget; original: unknown; wrapper: CaptureWrapper }>;
}

function captureHost(): Record<symbol, CaptureState | undefined> {
  // SAFETY: the only writes to this key are the `captureState()` creation below, so if the key
  // holds anything it is a CaptureState from this module. Foreign or partial values are not
  // trusted: `captureState()` checks `armedTargets` and replaces an unusable slot.
  return globalThis as unknown as Record<symbol, CaptureState | undefined>;
}

function captureState(): CaptureState {
  const host = captureHost();
  const existing = host[CAPTURE_STATE];
  if (existing !== undefined && typeof existing.armedTargets === "number") return existing;
  const created: CaptureState = {
    armedTargets: 0,
    nestingDepth: 0,
    generation: 0,
    sessions: [],
    lastOutcome: undefined,
    lastFailures: [],
    wrappers: [],
  };
  host[CAPTURE_STATE] = created;
  return created;
}

/** Diagnostics snapshot for `status` (S6) and for the backend's own tests. */
export function getCaptureDiagnostics(): CaptureDiagnostics {
  const state = captureState();
  return {
    armedTargets: state.armedTargets,
    nestingDepth: state.nestingDepth,
    lastOutcome: state.lastOutcome,
    lastFailures: [...state.lastFailures],
  };
}

/**
 * Test-only seam: forget arming counts, the last outcome and the last failures. Deliberately not
 * re-exported from `src/index.ts`. Markers live on host objects and arrays and are not cleared;
 * `disableCaptureBackend()` is the seam that unwraps.
 */
export function resetCaptureStateForTests(): void {
  const state = captureState();
  state.armedTargets = 0;
  state.nestingDepth = 0;
  // Bump so wrappers left in foreign closures from an earlier test become pass-throughs.
  state.generation += 1;
  state.sessions = [];
  state.savedMap = undefined;
  state.lastOutcome = undefined;
  state.lastFailures = [];
  state.wrappers = [];
}

/** The probe records into the innermost session and forwards to the saved original. */
const probe = function (this: unknown, callback: unknown, thisArg?: unknown): unknown[] {
  const state = captureState();
  const session = state.sessions[state.sessions.length - 1];
  if (session !== undefined) {
    try {
      if (isRowLikeArray(this) && !session.candidates.includes(this)) {
        session.candidates.push(this);
      }
    } catch {
      // Never break the host's own `map` call.
    }
  }

  const original = state.savedMap;
  // Unreachable while the probe is installed (installing saves the original first); returning an
  // empty array keeps the host's call from throwing if a foreign swap cleared the saved value.
  if (original === undefined) return [];
  // SAFETY: `original` is the real `Array.prototype.map` captured in `installProbe()`; `LooseMap`
  // only widens the parameter types so this forwards whatever the host's own call passed.
  return (original as unknown as LooseMap).call(this, callback, thisArg);
};

function installProbe(): void {
  const state = captureState();
  if (state.savedMap !== undefined) return;
  state.savedMap = Array.prototype.map;
  // SAFETY: `probe` forwards the exact (callback, thisArg) pair to the saved original and only
  // observes `this`, so it is a behavioural drop-in for the duration of one outermost call; the
  // original is restored by `removeProbe()` in the wrapper's `finally`.
  Array.prototype.map = probe as unknown as typeof Array.prototype.map;
}

function removeProbe(): void {
  const state = captureState();
  const saved = state.savedMap;
  if (saved === undefined) return;
  Array.prototype.map = saved;
  state.savedMap = undefined;
}

/**
 * Arm the capture backend on a `ctx.ui`-shaped object. Idempotent per target and per function:
 * the marker is an own property holding the exact wrapper installed, so a rebind that gives the
 * instance a new `custom` always rearms instead of reporting a stale `already-armed`.
 *
 * Both shapes Pi can use are covered. When the instance owns `custom`, that own property is
 * wrapped. Otherwise the prototype method that provides `custom` is wrapped once for every
 * instance that inherits it.
 */
export function installCaptureBackend(ui: unknown): InstallCaptureResult {
  if (ui === null || typeof ui !== "object") {
    return { armed: false, target: "none", outcome: "no-custom" };
  }
  const instance = ui as MutableTarget;

  if (Object.prototype.hasOwnProperty.call(instance, "custom")) {
    return wrapCustom(instance, "instance");
  }

  const proto: unknown = Object.getPrototypeOf(instance);
  const protoCustom =
    proto !== null && typeof proto === "object" ? (proto as MutableTarget).custom : undefined;
  if (typeof protoCustom === "function") {
    return wrapCustom(proto as MutableTarget, "prototype");
  }

  return { armed: false, target: "none", outcome: "no-custom" };
}

function wrapCustom(target: MutableTarget, shape: "instance" | "prototype"): InstallCaptureResult {
  const current = target.custom;
  if (typeof current !== "function") {
    return { armed: false, target: "none", outcome: "no-custom" };
  }

  // Own-property check plus function identity: an inherited marker describes the prototype's
  // function, not this instance's, so it must never certify this target.
  if (Object.hasOwn(target, CAPTURE_WRAPPED) && target[CAPTURE_WRAPPED] === current) {
    return { armed: false, target: shape, outcome: "already-armed" };
  }

  const callHost = current as HostCustom;
  // SAFETY: `current` is verified callable above, and the host's `custom` is documented to
  // resolve its factory to a component (or a promise of one) — architecture.md §3. The bridge
  // never inspects the result, it only forwards it, so the return type is not a claim about its
  // shape.

  const generation = captureState().generation;
  const wrapper = function (this: unknown, ...args: unknown[]): HostCustomResult {
    const state = captureState();
    const factory = args[0];
    const rest = args.slice(1);
    // A wrapper retained by foreign code after a disable must never capture or inject again; it
    // behaves exactly like the host's own method.
    if (state.generation !== generation || typeof factory !== "function") {
      return callHost.apply(this, args as [unknown, ...unknown[]]);
    }
    return callHost.apply(this, [createCaptureFactory(factory as HostFactory), ...rest]);
  };

  target.custom = wrapper;
  Object.defineProperty(target, CAPTURE_WRAPPED, {
    value: wrapper,
    enumerable: false,
    configurable: true,
  });
  const state = captureState();
  const previous = state.wrappers.findIndex((record) => record.target === target);
  if (previous === -1) state.armedTargets += 1;
  else state.wrappers.splice(previous, 1);
  state.wrappers.push({ target, original: current, wrapper });
  return { armed: true, target: shape, outcome: "armed" };
}

/**
 * Disable every capture wrapper, restoring the host's own `custom` on the exact targets that were
 * wrapped. Used when a different backend becomes active, so one menu cannot receive two copies of
 * the bridge's rows.
 */
export function disableCaptureBackend(): number {
  const state = captureState();
  let restored = 0;
  for (const record of state.wrappers.splice(0)) {
    try {
      if (record.target.custom === record.wrapper) record.target.custom = record.original;
      if (Object.hasOwn(record.target, CAPTURE_WRAPPED)) delete record.target[CAPTURE_WRAPPED];
      restored += 1;
    } catch {
      // A host object that refuses the assignment keeps its wrapper; the backend is still off.
    }
  }
  state.armedTargets = 0;
  state.generation += 1;
  return restored;
}

/** Wrap exactly one factory invocation, attributing every mapped array to its own session. */
function createCaptureFactory(factory: HostFactory): HostFactory {
  return (ui, theme, ...rest) => {
    const state = captureState();
    const outermost = state.sessions.length === 0;
    const session: CaptureSession = { candidates: [] };
    state.sessions.push(session);
    state.nestingDepth = state.sessions.length;
    // The probe wraps the FACTORY INVOCATION, so a host that calls the factory in a later
    // microtask still runs under it. A factory that returns a promise is handled below.
    if (outermost) installProbe();

    let component: HostCustomResult;
    try {
      component = factory(ui, theme, ...rest);
    } catch (error) {
      // Nothing was injected into this session: say so rather than leaving the previous outcome.
      state.lastOutcome = {
        kind: "uncaptured",
        injectedRows: 0,
        reason: "factory-threw",
      };
      throw error;
    } finally {
      // Restored even when the factory or the host throws, so neither the session stack nor the
      // patched `Array.prototype.map` can leak.
      state.sessions.pop();
      state.nestingDepth = state.sessions.length;
      if (outermost) removeProbe();
    }
    resolveSession(session, component, theme);
    return component;
  };
}

/**
 * Decide what this session's candidates mean and inject once. Never injects into an array it did
 * not capture, and never reports `injected` for a menu that received nothing.
 */
function resolveSession(session: CaptureSession, component: HostCustomResult, theme: unknown): void {
  const state = captureState();

  // The host may resolve its factory asynchronously (`interactive-mode.ts:3136`). This backend
  // only observes the synchronous shape, so the promise is returned untouched and recorded.
  if (isThenable(component)) {
    state.lastOutcome = { kind: "uncaptured", injectedRows: 0, reason: "async-factory" };
    return;
  }

  if (session.candidates.length === 0) {
    state.lastOutcome = { kind: "uncaptured", injectedRows: 0, reason: "no-capture" };
    return;
  }

  if (session.candidates.length > 1) {
    // More than one row-like array in one factory call: the target is ambiguous, so inject into
    // none of them and say so. Guessing here is what produced silent wrong-target injections.
    state.lastOutcome = { kind: "uncaptured", injectedRows: 0, reason: "ambiguous" };
    return;
  }

  const captured = session.candidates[0];

  if (Object.hasOwn(captured, CAPTURE_INJECTED)) {
    state.lastOutcome = { kind: "already-injected", injectedRows: 0 };
    return;
  }
  // Non-enumerable marker on the array: the same menu built twice injects once.
  Object.defineProperty(captured as object, CAPTURE_INJECTED, {
    value: true,
    enumerable: false,
    configurable: true,
  });

  // S1: the host's own `Card style` line is extended IN PLACE here, before the providers' rows are
  // appended — the one moment the array is reachable, and the only place the two could be confused.
  // It never throws: an unreachable line records the `separate` mode and leaves the fallback
  // provider to draw the bridge's own line on this same build.
  extendCardStyleLine(captured);

  const built = buildRows(createRowContext(theme));
  state.lastFailures = built.failures;
  if (built.rows.length > 0) captured.push(...built.rows);
  state.lastOutcome = { kind: "injected", injectedRows: built.rows.length };

  invalidate(component);
}

/**
 * Row-like means: an array of at least three objects that each expose a callable `action`.
 * Deliberately allocation-free and `map`-free, because it runs while `Array.prototype.map` is
 * patched.
 */
function isRowLikeArray(value: unknown): value is CustomizeRow[] {
  if (!Array.isArray(value) || value.length < MIN_ROW_ARRAY_LENGTH) return false;
  for (const element of value) {
    if (element === null || typeof element !== "object") return false;
    const action = (element as { action?: unknown }).action;
    if (typeof action !== "function") return false;
  }
  return true;
}

function invalidate(component: HostCustomResult): void {
  if (component === null || typeof component !== "object") return;
  const invalidateFn = (component as HostComponent).invalidate;
  if (typeof invalidateFn === "function") invalidateFn.call(component);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return typeof (value as { then?: unknown }).then === "function";
}
