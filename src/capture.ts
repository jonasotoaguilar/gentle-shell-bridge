/**
 * Capture backend (docs/architecture.md §2–§4, docs/contract.md §5, §7).
 *
 * gentle-shell's `ctx.ui.custom` factory returns a plain adapter, not the view, so the rows
 * array is unreachable by duck-typing. The only reachable moment is the view constructor's
 * `options.rows.map(...)` (`lib/visual-customize-view.ts:387`), which runs synchronously inside
 * the factory call. So: swap `Array.prototype.map` for the duration of exactly one factory call,
 * record the first row-like array it is invoked on BY REFERENCE, restore the original in
 * `finally`, then push the providers' rows into that captured array and invalidate the adapter.
 *
 * Two independent wrappers collide (the inner patch wins), so a target is wrapped at most once
 * (non-enumerable marker) and nested `custom` calls share the outermost patch (nesting counter).
 *
 * Shared state lives on `globalThis` behind a `Symbol.for` key, like the bus: a second copy of
 * this package loaded by jiti's `moduleCache: false` must see the same arming and the same
 * diagnostics.
 */

import { buildRows, createRowContext, type RowBuildFailure } from "./rows.ts";
import type { CustomizeRow } from "./types.ts";

/** Marks a UI target this module already wrapped. Non-enumerable so the host never sees it. */
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
  reason?: "async-factory" | "no-capture";
}

/** What diagnostics (`status`, S6) reads from the capture backend. */
export interface CaptureDiagnostics {
  /** Number of UI targets wrapped in this process. */
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

interface CaptureState {
  armedTargets: number;
  nestingDepth: number;
  lastOutcome?: CaptureOutcome;
  lastFailures: CaptureFailure[];
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
    lastOutcome: undefined,
    lastFailures: [],
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
 * re-exported from `src/index.ts`. The non-enumerable markers live on host objects and arrays,
 * so they are not cleared here.
 */
export function resetCaptureStateForTests(): void {
  const state = captureState();
  state.armedTargets = 0;
  state.nestingDepth = 0;
  state.lastOutcome = undefined;
  state.lastFailures = [];
}

/**
 * Arm the capture backend on a `ctx.ui`-shaped object. Idempotent: a second call on the same
 * object never double-wraps.
 *
 * Both shapes Pi can use are covered. When the instance owns `custom`, that own property is
 * wrapped. Otherwise the prototype method that provides `custom` is wrapped once for every
 * instance that inherits it. Only one of them is ever wrapped, so one call chain carries one
 * wrapper.
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
  if (target[CAPTURE_WRAPPED] === true) {
    return { armed: false, target: shape, outcome: "already-armed" };
  }
  const original = target.custom;
  if (typeof original !== "function") {
    return { armed: false, target: "none", outcome: "no-custom" };
  }
  const callHost = original as HostCustom;
  // SAFETY: `original` is verified callable above, and the host's `custom` is documented to
  // resolve its factory to a component (or a promise of one) — architecture.md §3. The bridge
  // never inspects the result, it only forwards it, so the return type is not a claim about its
  // shape.

  const wrapper = function (this: unknown, ...args: unknown[]): HostCustomResult {
    const factory = args[0];
    const rest = args.slice(1);
    if (typeof factory !== "function") {
      return callHost.apply(this, args as [unknown, ...unknown[]]);
    }

    const state = captureState();
    const outermost = state.nestingDepth === 0;
    state.nestingDepth += 1;
    try {
      return callHost.apply(this, [createCaptureFactory(factory as HostFactory, outermost), ...rest]);
    } finally {
      // Restored even when the factory or the host throws, so the counter never leaks.
      state.nestingDepth -= 1;
    }
  };

  target.custom = wrapper;
  // Non-enumerable marker: a second `session_start`, a `/reload` or a second copy of the package
  // sees it and never double-wraps.
  Object.defineProperty(target, CAPTURE_WRAPPED, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  captureState().armedTargets += 1;
  return { armed: true, target: shape, outcome: "armed" };
}

/**
 * Wrap one host factory call. `outermost` is false for a nested `custom` call made while the
 * outermost factory is still running: the outer patch already covers it, and installing a second
 * one is exactly the collision the nesting counter exists to prevent.
 */
function createCaptureFactory(factory: HostFactory, outermost: boolean): HostFactory {
  return (ui, theme, ...rest) => {
    if (!outermost) return factory(ui, theme, ...rest);

    const state = captureState();
    const originalMap: typeof Array.prototype.map = Array.prototype.map;
    // SAFETY: `originalMap` IS Array.prototype.map; `LooseMap` only widens the parameter types so
    // the patch can forward whatever the host's own `map` call passed, unchanged.
    const callOriginalMap = originalMap as unknown as LooseMap;
    let captured: CustomizeRow[] | undefined;

    const probe = function (this: unknown, callback: unknown, thisArg?: unknown): unknown[] {
      if (captured === undefined) {
        try {
          if (isRowLikeArray(this)) captured = this;
        } catch {
          // Never break the host's own `map` call.
        }
      }
      return callOriginalMap.call(this, callback, thisArg);
    };
    // SAFETY: `probe` forwards the exact (callback, thisArg) pair to the saved original and only
    // observes `this`, so it is a behavioural drop-in for Array.prototype.map for the duration of
    // one synchronous factory call; the original is restored in the `finally` below.
    Array.prototype.map = probe as unknown as typeof Array.prototype.map;

    let component: HostCustomResult;
    try {
      component = factory(ui, theme, ...rest);
    } finally {
      Array.prototype.map = originalMap;
    }

    // The host may resolve its factory asynchronously (`interactive-mode.ts:3136`). This backend
    // only observes the synchronous shape, so the promise is returned untouched and recorded.
    if (isThenable(component)) {
      state.lastOutcome = { kind: "uncaptured", injectedRows: 0, reason: "async-factory" };
      return component;
    }

    if (captured === undefined) {
      state.lastOutcome = { kind: "uncaptured", injectedRows: 0, reason: "no-capture" };
      return component;
    }

    // `Object.hasOwn` keeps this cast-free and works with symbol keys.
    if (Object.hasOwn(captured, CAPTURE_INJECTED)) {
      state.lastOutcome = { kind: "already-injected", injectedRows: 0 };
      return component;
    }
    // Non-enumerable marker on the array: the same menu built twice injects once.
    Object.defineProperty(captured as object, CAPTURE_INJECTED, {
      value: true,
      enumerable: false,
      configurable: true,
    });

    const built = buildRows(createRowContext(theme));
    state.lastFailures = built.failures;
    if (built.rows.length > 0) captured.push(...built.rows);
    state.lastOutcome = { kind: "injected", injectedRows: built.rows.length };

    invalidate(component);
    return component;
  };
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
