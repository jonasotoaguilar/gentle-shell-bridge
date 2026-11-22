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
 * ## Two moments, because the view fixes its page list in the constructor (S18)
 *
 * The view derives `categories` ONCE, in the constructor
 * (`this.categories = [...new Set(options.rows.map(row => row.category ?? "Settings"))]`,
 * `lib/visual-customize-view.ts:387`). `categoryRows()` then filters `options.rows` live
 * (`:391-393`), which is why a row that joins an EXISTING page appears after a late push — and
 * why a row that names a BRAND-NEW page never did: the page list was already fixed, so nothing
 * could select it.
 *
 * So the probe injects at the earlier moment too, for the one array it can PROVE is the menu's,
 * BEFORE that array's `map` reads it. The host's `Set` then contains the new pages, in registry
 * order, after the host's own pages.
 *
 * ## The early step is provisional and is reconciled at the end of the factory (S20)
 *
 * The early step is a GUESS about which array is the menu, made before the factory finished; the
 * late decision is the one that knows (it holds every candidate, the ambiguity rule and the async
 * check). So the early step is provisional, and the late decision has the last word:
 *
 * - every early push is recorded: the array, where the rows were appended, the rows themselves, the
 *   `Card style` splice it made, and the marker it set;
 * - when the factory returns a component the late decision runs. If it picks the SAME array, the
 *   rows stay and the build is reported `injected`; if it picks ANOTHER array, the session proved
 *   several (ambiguous), or the factory returned a promise, the early rows, the splice and the
 *   marker are REMOVED from the early array and the previous behaviour applies exactly;
 * - when the factory throws, the same rollback runs in the `finally` that restores
 *   `Array.prototype.map`, so a throw leaves no trace — and a session only ever rolls back the
 *   array it pushed into, so an inner factory's rollback can never touch the outer session's rows.
 *
 * Net guarantee: after any factory invocation, no array holds bridge rows except the one the late
 * decision chose. The cost, stated honestly: for the duration of the factory an array that
 * satisfies the strict proof can hold bridge rows, visible only to code running inside that
 * factory, and the guess is undone whenever the decision disagrees with it.
 *
 * ## The proof: what makes an array the menu's rows
 *
 * Nothing is written to an array that is not PROVEN at that `map` call, and the proof runs on
 * EVERY call — never once per array, because the host may map its rows to something else first.
 * A `map` call proves the array when the callback, run exactly as `Array.prototype.map` runs it:
 *
 * - derives `row.category ?? "Settings"` for every element of the array;
 * - derives `"Settings"` for a synthetic row with NO category, and a unique sentinel page for a
 *   synthetic row naming it — so `row => row.category` and any constant mapper cannot qualify on
 *   the host's own rows alone;
 * - does not throw (a throw means "not proven", never a broken host call);
 * - and derives `row.category ?? "Settings"` for every row the bridge is about to append, run over
 *   them BEFORE they are pushed, so the host's own `map` can never throw because of a bridge row.
 *
 * Stated cost of the proof: the host's mapper runs over the host's own rows once more per row-like
 * `map` call, and once over each row the bridge appends. It is the host's own
 * `row => row.category ?? "Settings"`, pure by construction in the host; a mapper with side effects
 * sees them once more per element, which is the price of not guessing.
 *
 * Exactly one injection happens per menu build: the early path records what it pushed, the late
 * path reports that and does not repeat it, and the array marker keeps a second build of the same
 * menu from injecting twice.
 *
 * ## Capture-selection rule (why a wrong target can never be silent)
 *
 * Each wrapped `custom` call owns one capture *session* and one candidate list, and the probe
 * records a mapped array into the innermost active session only. The probe is installed around the
 * FACTORY INVOCATION, not around the host call, so a host that resolves its factory in a later
 * microtask (`Promise.resolve().then(factory)`) is still covered; a factory that itself returns a
 * promise stays the documented unsupported case, and the early guess is rolled back for it.
 *
 * - A nested `custom` call — from the host factory or from a provider's own `rows()` — gets its
 *   own session, so it can never steal the outer menu's capture, and its menu receives its own
 *   injection.
 * - A nested session that throws rolls back only its own array: nothing is left in it, and the
 *   outer session continues and resolves its own array.
 * - If ONE session captures more than one row-like array (an incidental row-shaped array before
 *   the menu, for example) the bridge does not guess: the outcome is `uncaptured (ambiguous)` and
 *   nothing is injected. The one exception is the proof above: when exactly ONE of those arrays
 *   derives pages like the menu does, that array is the menu by evidence and is what the late path
 *   takes (S18 needs it, or a brand-new page could never be reached); two proven arrays are
 *   ambiguous, and so are two unproven ones.
 *
 * Diagnostics never claim an injection into an array that received nothing.
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

import { recordObservedHostCategories, recordRowPlacementLandings } from "./bus.ts";
import { recordNotice } from "./notices.ts";
import { extendCardStyleLine } from "./card-style-rows.ts";
import { findCardStyleLine } from "./card-style-line.ts";
import {
  applyRowPlacementPlan,
  buildRows,
  createRowContext,
  planRowPlacement,
  rowPlacementLandingsAfterSkippedMove,
  type RowBuildFailure,
  type RowPlacementPlan,
} from "./rows.ts";
import {
  patchSharedSections,
  resetSharedSectionsPreviewForTests,
  undoSharedSections,
  type SharedSectionsPatch,
} from "./sections-preview.ts";
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

/**
 * The host's own category for a row that names none, read from the view's page derivation
 * (`row.category ?? "Settings"`, `lib/visual-customize-view.ts:387`). The early injection's proof
 * compares against it, so a host that renames the default falls back to the late path instead of
 * qualifying an array on a guess.
 */
const HOST_DEFAULT_CATEGORY = "Settings";

/**
 * The page name no host row can name, used by the proof's second synthetic row (S20). A mapper that
 * ignores its argument — a constant — cannot return this for one row and `"Settings"` for another,
 * and a mapper that echoes `row.category` cannot return `"Settings"` for the row that has none.
 */
const SENTINEL_CATEGORY = "gentle-shell-bridge probe sentinel";

/**
 * The two rows the host never had. They are the whole difference between "this callback derives
 * pages" and "this callback happens to fit these rows": an incidental array mapped with
 * `row => row.category` fits the host's rows perfectly and returns `undefined` for the first one
 * (JD-A-001).
 */
const SYNTHETIC_PROOF_ROWS: readonly CustomizeRow[] = [
  { label: "Bridge probe without a category", action: () => {} },
  { category: SENTINEL_CATEGORY, label: "Bridge probe with a sentinel category", action: () => {} },
];

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

/**
 * The callback a `map` call passed, typed the way `Array.prototype.map` calls it — the shape the
 * proof runs it with, so a mapper sees exactly what it would have seen.
 */
type CategoryMapper = (
  this: unknown,
  row: CustomizeRow,
  index: number,
  rows: readonly CustomizeRow[],
) => unknown;

type MutableTarget = Record<PropertyKey, unknown> & { custom?: unknown };

type CaptureWrapper = (this: unknown, ...args: unknown[]) => HostCustomResult;

/** One wrapped `custom` call in flight, with the arrays its factory mapped. */
interface CaptureSession {
  candidates: CustomizeRow[][];
  /** The candidates that proved themselves to be the menu's rows at a `map` call (S20). */
  proven: CustomizeRow[][];
  /**
   * The theme this factory invocation received, so the rows can be built BEFORE the factory
   * returns — the early path runs inside the view constructor's own `map` call.
   */
  theme: unknown;
  /** True while this session is building/injecting rows, so its own maps are not re-captured. */
  injecting: boolean;
  /** True while a `map` call is being proved, so a mapper that maps again cannot recurse. */
  proving: boolean;
  /**
   * True once the host's own `Card style` line was extended in this build. The splice is not
   * idempotent (`src/card-style-line.ts:94-109`), so exactly one of the two paths may do it — and a
   * rollback clears it again, so the array the late path picks gets its splice.
   */
  extendedCardStyle: boolean;
  /** What the early path pushed and where, so the late decision can keep or undo it (S20). */
  earlyInjection?: EarlyInjection;
}

/** One provisional injection: what landed, where, and how to take it back out. */
interface EarlyInjection {
  array: CustomizeRow[];
  /** The array exactly as it was before the provider blocks were placed, by identity. */
  original: readonly CustomizeRow[];
  /** The provider rows appended, by identity, so a rollback can identify the provisional build. */
  rows: readonly CustomizeRow[];
  /** The plan: where the blocks go once the host's category map has finished. */
  plan: RowPlacementPlan;
  /** The in-place `Card style` splice, when one happened, so a rollback can undo it exactly. */
  cardStyle?: EarlyCardStyleSplice;
  /** The in-place `Sections` preview patch, when one happened, for the same rollback. */
  sectionPreview?: SharedSectionsPatch;
  /** What the build recorded while failing, reported if the injection survives. */
  failures: CaptureFailure[];
}

/** The provisional `Card style` splice, recorded so it can be undone (`spliceCardStyleValues`). */
interface EarlyCardStyleSplice {
  /** Index of the host's line in the array. */
  start: number;
  /** How many host rows the splice replaced at that index. */
  hostCount: number;
  /** How many bridge value rows it inserted after them. */
  values: number;
  /** The host's own rows, by identity, exactly as they were before the splice. */
  original: readonly CustomizeRow[];
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
  // The shared `Sections` preview keeps the last patch, which is how a bridge row finds the host's
  // base list; a new test starts with no patched array to borrow from.
  resetSharedSectionsPreviewForTests();
}

/** The probe records into the innermost session and forwards to the saved original. */
const probe = function (this: unknown, callback: unknown, thisArg?: unknown): unknown[] {
  const state = captureState();
  const session = state.sessions[state.sessions.length - 1];
  if (session !== undefined) {
    try {
      if (isRowLikeArray(this)) {
        if (!session.candidates.includes(this)) session.candidates.push(this);
        // S18: a brand-new page only exists if the rows are already in the array when the host's
        // own `map` reads it, so the proof and the push happen BEFORE the call is forwarded. S20:
        // the proof is evaluated on EVERY call, and the push is provisional until the factory ends.
        observeRowMap(session, this, callback, thisArg);
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
    const session: CaptureSession = {
      candidates: [],
      proven: [],
      theme,
      injecting: false,
      proving: false,
      extendedCardStyle: false,
    };
    state.sessions.push(session);
    state.nestingDepth = state.sessions.length;
    // The probe wraps the FACTORY INVOCATION, so a host that calls the factory in a later
    // microtask still runs under it. A factory that returns a promise is handled below.
    if (outermost) installProbe();

    let component: HostCustomResult;
    let failed = true;
    try {
      component = factory(ui, theme, ...rest);
      failed = false;
    } catch (error) {
      // Nothing was injected into this session: say so rather than leaving the previous outcome.
      state.lastOutcome = {
        kind: "uncaptured",
        injectedRows: 0,
        reason: "factory-threw",
      };
      throw error;
    } finally {
      // A throw leaves no trace (JD-A-004): the early rows and the marker come out of the array in
      // the SAME `finally` that restores `Array.prototype.map`. Only this session's own array is
      // touched, so an inner factory's rollback can never reach the outer session's rows.
      // The stack and the patched `map` are restored FIRST and unconditionally (E10), so nothing the
      // rollback does can leave either installed. `rollbackEarly` never throws.
      state.sessions.pop();
      state.nestingDepth = state.sessions.length;
      if (outermost) removeProbe();
      if (failed) {
        rollbackEarly(session);
        state.lastFailures = [];
      }
    }
    resolveSession(session, component);
    return component;
  };
}

/**
 * Decide what this session's candidates mean and inject once. Never injects into an array it did
 * not capture, and never reports `injected` for a menu that received nothing.
 *
 * S20: this is also where the provisional early injection is reconciled. The early step is a guess;
 * this function is the decision, so it either keeps the guess (same array, sync factory) or takes
 * it back before applying the previous behaviour exactly.
 */
function resolveSession(session: CaptureSession, component: HostCustomResult): void {
  const state = captureState();

  // The host may resolve its factory asynchronously (`interactive-mode.ts:3136`). This backend only
  // observes the synchronous shape, so the promise is returned untouched, the early rows are taken
  // back (JD-A-005: no late decision will ever run for them) and the outcome is the previous one.
  if (isThenable(component)) {
    rollbackEarly(session);
    state.lastFailures = [];
    state.lastOutcome = { kind: "uncaptured", injectedRows: 0, reason: "async-factory" };
    return;
  }

  const picked = pickLateTarget(session);
  if (picked.kind === "none") {
    // No array can be named, or several can (the ambiguity rule). Either way the guess is undone
    // first, so the net guarantee holds whatever the report says.
    rollbackEarly(session);
    state.lastFailures = [];
    state.lastOutcome = { kind: "uncaptured", injectedRows: 0, reason: picked.reason };
    return;
  }
  const captured = picked.array;
  const early = session.earlyInjection;

  // The early path put the rows in before the view read its page list (S18) and the late decision
  // agrees: report that build and do not build a second time, so the providers run once.
  if (early !== undefined && early.array === captured) {
    // The provisional step APPENDED the blocks so the host's `new Set(...)` could see a new page.
    // The factory has returned, so that map is finished; place the blocks at their slots now. This
    // is also why the provisional step must not splice in the middle: the host's own map captured
    // the length it will iterate, and shifting rows under it would make it read the wrong pages.
    // A frozen/exotic array skips the move; the report then states the landing it really got (S5).
    const problem = early.plan.optsIn ? placeEarlyBlocks(early) : undefined;
    recordRowPlacementLandings(
      problem === undefined
        ? early.plan.landings
        : rowPlacementLandingsAfterSkippedMove(early.plan, problem),
    );
    state.lastFailures = early.failures;
    state.lastOutcome = { kind: "injected", injectedRows: early.rows.length };
    invalidate(component);
    return;
  }

  // The guess did not survive the decision (another array, or several arrays proved themselves):
  // remove every trace of it before the late path runs.
  rollbackEarly(session);

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
  // provider to draw the bridge's own line on this same build. The early path extends the same line
  // at the same point in the array's life; the splice is not idempotent, so only one of them runs.
  if (!session.extendedCardStyle) {
    session.extendedCardStyle = true;
    extendCardStyleLine(captured);
  }

  // S1/S2: the host's own `Sections` rows now preview the bridge's sections too. Patched after the
  // splice, so the recorded indices describe the array the providers are about to join, and before
  // the rows are built: a bridge row's preview reads the patch lazily, at render time.
  patchSharedSections(captured);

  const built = buildRows(createRowContext(session.theme));
  state.lastFailures = built.failures;
  // S4/S5: place each provider's block at the slot the ONE resolver names. The plan is computed
  // against the array as it is now and written in one in-place splice, so no insertion index can
  // drift. A host `choice.setting` pair is never split: every insertion point is a block boundary.
  const plan = planRowPlacement(captured, built.providers, built.blocks);
  recordObservedHostCategories(plan.hostCategories);
  if (!plan.optsIn) {
    // No provider opted in: the pre-feature tail append, exactly (S6).
    if (built.rows.length > 0) captured.push(...built.rows);
    recordRowPlacementLandings([]);
  } else {
    const problem = applyRowPlacementPlan(captured, plan.planned);
    if (problem === undefined) {
      recordRowPlacementLandings(plan.landings);
    } else {
      // The planned splice is refused (a read-only index, a frozen array): change nothing, leave
      // the rows where the pre-feature path put them, and report the landing that really happened.
      try {
        if (built.rows.length > 0) captured.push(...built.rows);
      } catch {
        // the host refuses even the tail append; the landing report still says why nothing moved
      }
      recordRowPlacementLandings(rowPlacementLandingsAfterSkippedMove(plan, problem));
    }
  }
  state.lastOutcome = { kind: "injected", injectedRows: built.rows.length };

  invalidate(component);
}

/** What the late decision chose: one array, or nothing with the reason to report. */
type LatePick =
  | { kind: "pick"; array: CustomizeRow[] }
  | { kind: "none"; reason: "no-capture" | "ambiguous" };

/**
 * The late decision: which array this factory's rows belong in, if any.
 *
 * The rule is the previous one — one row-like candidate is the menu, none means nothing was
 * captured, several are ambiguous and nothing is injected — with one refinement S18 needs: when
 * exactly ONE candidate proved itself the menu's rows at a `map` call (S20's proof), that array is
 * the menu by evidence, so a merely row-LIKE array mapped beside it does not make the target
 * ambiguous. Two proven arrays are ambiguous, and so are two unproven ones: the bridge still never
 * guesses between two arrays that both look like the menu.
 */
function pickLateTarget(session: CaptureSession): LatePick {
  if (session.proven.length === 1) {
    const proven = session.proven[0];
    if (proven !== undefined) return { kind: "pick", array: proven };
  }
  if (session.proven.length > 1) return { kind: "none", reason: "ambiguous" };
  if (session.candidates.length === 0) return { kind: "none", reason: "no-capture" };
  if (session.candidates.length > 1) return { kind: "none", reason: "ambiguous" };
  const only = session.candidates[0];
  if (only === undefined) return { kind: "none", reason: "no-capture" };
  return { kind: "pick", array: only };
}

/**
 * Put the provisional blocks at the slots the resolver named, once the host's category map has
 * finished. Only the exact `original + inserted rows` shape is reordered: if the host changed its
 * array in the meantime, the appended rows stay where they are rather than losing a host row.
 */
function placeEarlyBlocks(early: EarlyInjection): string | undefined {
  const { array } = early;
  const expectedLength = early.original.length + early.rows.length;
  if (array.length !== expectedLength) return "the host array changed before the planned move";
  for (let index = 0; index < early.original.length; index++) {
    if (array[index] !== early.original[index]) return "the host array changed before the planned move";
  }
  for (let index = 0; index < early.rows.length; index++) {
    if (array[early.original.length + index] !== early.rows[index]) {
      return "the host array changed before the planned move";
    }
  }
  return applyRowPlacementPlan(array, early.plan.planned);
}

/**
 * Remove exactly the rows this build appended, without writing a retained host index (S10).
 *
 * The normal case is the unchanged array `original + rows`: shrinking `length` removes the tail
 * append and writes no element, so a retained read-only index is never touched and no hole can
 * appear. If the host appended its own rows after ours, only the indices at or after the append point
 * are rewritten, again guarded and preflighted as one change. Anything that cannot be done leaves the
 * array consistent and returns the reason for the notice.
 */
function removeInjectedTail(early: EarlyInjection): string | undefined {
  const { array, original, rows } = early;
  if (rows.length === 0) return undefined;
  const start = original.length;
  try {
    const length = array.length;
    const target = start + rows.length;
    if (length < target) {
      // The host already removed part of the append (for example through `pop()`). Report what is
      // still there and how much of the build's work could not be undone.
      const available = Math.max(0, Math.min(rows.length, length - start));
      let found = 0;
      for (let index = 0; index < available; index += 1) {
        if (array[start + index] !== rows[index]) {
          return (
            "the host changed the appended rows before the rollback " +
            `(found ${found} of ${rows.length} appended rows; ` +
            `${rows.length - found} could not be removed)`
          );
        }
        found += 1;
      }
      return (
        "the host array no longer holds the appended segment " +
        `(found ${found} of ${rows.length} appended rows; ` +
        `${rows.length - found} could not be removed)`
      );
    }
    for (let index = 0; index < rows.length; index += 1) {
      if (array[start + index] !== rows[index]) {
        return (
          "the host changed the appended rows before the rollback " +
          `(found ${index} of ${rows.length} appended rows; ` +
          `${rows.length - index} could not be removed)`
        );
      }
    }
    if (length === target) {
      const descriptor = Object.getOwnPropertyDescriptor(array, "length");
      if (descriptor !== undefined && descriptor.writable === false) {
        return `the host array's length is read-only (${rows.length} appended rows could not be removed)`;
      }
      array.length = start;
      return array.length === start
        ? undefined
        : `the host array kept a phantom length (${rows.length} appended rows could not be removed)`;
    }

    // The host appended rows after ours: shift those rows left over the exact appended segment. Only
    // indices >= `start` are written; retained host indices are never touched. Preflight every index
    // `splice` will assign (it writes even an equal value), plus the length.
    const nextLength = length - rows.length;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(array, "length");
    if (lengthDescriptor !== undefined && lengthDescriptor.writable === false) {
      return `the host array's length is read-only (${rows.length} appended rows could not be removed)`;
    }
    for (let index = start; index < nextLength; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
      if (descriptor !== undefined && descriptor.writable === false) {
        return `index ${index} is read-only (${rows.length} appended rows could not be removed)`;
      }
      if (descriptor === undefined && !Object.isExtensible(array)) {
        return `index ${index} cannot be written (${rows.length} appended rows could not be removed)`;
      }
    }
    try {
      array.splice(start, rows.length);
    } catch {
      return `the host array refused the tail trim (${rows.length} appended rows could not be removed)`;
    }
    return array.length === nextLength
      ? undefined
      : `the host array kept a phantom length (${rows.length} appended rows could not be removed)`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return (
      `the host array could not be inspected or changed (${detail}); ` +
      `${rows.length} appended rows could not be removed`
    );
  }
}

/**
 * Take a provisional injection back out, exactly.
 *
 * Three things were written and all three are undone in place, on the SAME array object the host
 * holds: the appended provider rows (removed from their tail segment, never by filtering identities),
 * the `Card style` values the provisional splice inserted into the host's own line, and the injection
 * marker. A retained index the build never changed is never written (S10); if the host moved the
 * appended rows the rollback reports that instead of guessing, but the marker still comes off.
 */
function rollbackEarly(session: CaptureSession): void {
  const early = session.earlyInjection;
  if (early === undefined) return;
  session.earlyInjection = undefined;
  const { array } = early;

  // Every step is best effort and none may throw (E10): the host can freeze, seal or proxy its array
  // between our push and this rollback, and a rollback that threw would replace the host's own error
  // and skip the steps after it. An array we cannot restore is left as the host made it.
  const rollbackProblem = removeInjectedTail(early);
  if (rollbackProblem !== undefined) {
    recordNotice(
      `gentle-shell-bridge: could not fully roll back the provisional rows: ${rollbackProblem}. ` +
        "The host menu was left as consistent as the array allowed.",
      "error",
    );
  }
  // Reverse order of the writes: the preview patch was applied after the `Card style` splice, so it
  // goes back FIRST, while its recorded indices still describe the array it edited.
  try {
    undoSharedSections(early.sectionPreview);
  } catch {
    // same: the host's own previews stay as the host left them
  }
  try {
    undoCardStyleSplice(array, early.cardStyle);
  } catch {
    // same: the host's own line stays as the host left it
  }
  // The late path may now extend the line of the array IT picks; the splice runs once per build.
  session.extendedCardStyle = false;
  try {
    Reflect.deleteProperty(array as object, CAPTURE_INJECTED);
  } catch {
    // A hostile Proxy can refuse even the marker removal; the host's own error still surfaces.
  }
}

/**
 * Observe one `map` call on a row-like array (S18, S20).
 *
 * The proof runs on EVERY call — never latched to the first one, because the host may map its rows
 * to labels before the constructor maps them to categories (JD-A-002). An array that proves itself
 * is remembered as such, and the provisional push happens at most once per build.
 */
function observeRowMap(
  session: CaptureSession,
  array: CustomizeRow[],
  callback: unknown,
  thisArg: unknown,
): void {
  // Reentrancy: building the rows itself maps row-like arrays (a provider's own array, a nested
  // menu's), and those maps belong to the build, not to the host's menu. A mapper that itself maps
  // is the same case: the callback is proved once, and its own maps prove nothing.
  if (session.injecting || session.proving) return;
  session.proving = true;
  let proven: boolean;
  try {
    proven = provesCategoryMap(array, callback, thisArg);
  } finally {
    session.proving = false;
  }
  if (!proven) return;
  if (!session.proven.includes(array)) session.proven.push(array);
  injectProvisionalRows(session, array, callback, thisArg);
}

/**
 * S18: give a brand-new page to the view before it fixes its page list — provisionally (S20).
 *
 * The view computes `categories` once, in its constructor, from `options.rows.map(...)`
 * (`lib/visual-customize-view.ts:387`). A row that joins an EXISTING page is visible after a late
 * push because `categoryRows()` filters `options.rows` live (`:391-393`); a row naming a NEW page
 * is not, because nothing can select a page the list does not hold. So the rows must be in the
 * array before that `map` reads it.
 *
 * Everything here is recorded so `rollbackEarly` can undo it: the append index, the rows by
 * identity, and the `Card style` splice. The mapper is also run over the rows about to be appended,
 * before they are pushed, so the host's own `map` can never throw because of a bridge row
 * (JD-A-003) — if it would, nothing is appended and the late path behaves exactly as before.
 */
function injectProvisionalRows(
  session: CaptureSession,
  array: CustomizeRow[],
  callback: unknown,
  thisArg: unknown,
): void {
  // One injection per build, and a menu built twice already received its rows.
  if (session.earlyInjection !== undefined) return;
  if (Object.hasOwn(array, CAPTURE_INJECTED)) return;

  session.injecting = true;
  const state = captureState();
  let cardStyle: EarlyCardStyleSplice | undefined;
  let sectionPreview: SharedSectionsPatch | undefined;
  try {
    // S1, same ordering as the late path: the host's own line is extended before the providers'
    // rows are appended (the fallback provider's contribution depends on that order). The splice is
    // NOT idempotent, so it happens once per menu build.
    if (!session.extendedCardStyle) {
      session.extendedCardStyle = true;
      cardStyle = extendCardStyleProvisional(array);
    }
    // S1/S2: the host's `Sections` rows are patched BEFORE the host's own `map` reads this array,
    // so the list it previews already names the bridge's sections. Undone with everything else.
    sectionPreview = patchSharedSections(array);
    const built = buildRows(createRowContext(session.theme));
    // S4/S5: the provisional placement uses the same plan as the late path, computed against the
    // array BEFORE the host's own `map` reads it. A brand-new page is already in the array, so the
    // host's `new Set(...)` sees it; an existing page gets its `start`/`after` slots at the block
    // boundaries the resolver named.
    const plan = planRowPlacement(array, built.providers, built.blocks);
    recordObservedHostCategories(plan.hostCategories);
    if (
      plan.rows.length > 0 &&
      !provesPlannedRows(callback, thisArg, plan.planned, plan.rows)
    ) {
      // The host's own `map` would meet a row it cannot derive a page for. Nothing is written: the
      // splice and the preview patch go back too, and the late path handles this array exactly as it
      // did before S18.
      undoSharedSections(sectionPreview);
      undoCardStyleSplice(array, cardStyle);
      session.extendedCardStyle = false;
      return;
    }
    const original = [...array];
    // Append the PRE-FEATURE tail order, never splice in the middle: this runs while the host is
    // inside its own `rows.map(...)`, whose length was captured before the callback. A new page is
    // still in the array before `new Set(...)` reads it; the blocks move to their real slots once the
    // factory returns, and if that move is refused they are already exactly where the old path put
    // them (S6).
    if (built.rows.length > 0) array.push(...built.rows);
    Object.defineProperty(array as object, CAPTURE_INJECTED, {
      value: true,
      enumerable: false,
      configurable: true,
    });
    const injection: EarlyInjection = {
      array,
      original,
      rows: built.rows,
      plan,
      failures: built.failures,
    };
    if (cardStyle !== undefined) injection.cardStyle = cardStyle;
    if (sectionPreview !== undefined) injection.sectionPreview = sectionPreview;
    session.earlyInjection = injection;
    state.lastFailures = built.failures;
  } catch {
    // The provider build isolates its own failures, so reaching this means the array refused the
    // edit. Nothing of the provisional step stays behind.
    undoSharedSections(sectionPreview);
    undoCardStyleSplice(array, cardStyle);
    session.extendedCardStyle = false;
  } finally {
    session.injecting = false;
  }
}

/**
 * Extend the host's `Card style` line in place, remembering the splice so a rollback can undo it.
 * Returns `undefined` when nothing was written (no line, nothing registered, or a refusing array).
 */
function extendCardStyleProvisional(array: CustomizeRow[]): EarlyCardStyleSplice | undefined {
  const line = findCardStyleLine(array);
  const original = line === undefined ? [] : array.slice(line.start, line.start + line.count);
  const before = array.length;
  extendCardStyleLine(array);
  const values = array.length - before;
  if (line === undefined || values <= 0) return undefined;
  return { start: line.start, hostCount: line.count, values, original };
}

/** Put the host's own rows back where the provisional splice replaced them. */
function undoCardStyleSplice(array: CustomizeRow[], splice: EarlyCardStyleSplice | undefined): void {
  if (splice === undefined) return;
  const total = splice.hostCount + splice.values;
  if (array.length < splice.start + total) return;
  array.splice(splice.start, total, ...splice.original);
}

/**
 * The proof that qualifies an array for the early injection (S20).
 *
 * The host's own mapper is run exactly as `Array.prototype.map` would run it — same `this`, element,
 * index and array, and nothing else — over:
 *
 * 1. the array's own elements, each required to derive that element's `category ?? "Settings"`
 *    (the view's page derivation, `lib/visual-customize-view.ts:387`);
 * 2. two synthetic rows the host never had, required to derive `"Settings"` for the one with no
 *    category and its own unique page for the one naming the sentinel. This is what a mapper that
 *    merely echoes what it is given, or ignores it, can never do;
 * 3. never a throw: a mapper that throws on any of those rows is simply not proven, so the host's
 *    own call keeps its own behaviour and nothing is mutated.
 *
 * Nothing here mutates, runs a provider, or forwards anything to the host.
 */
function provesCategoryMap(
  array: readonly CustomizeRow[],
  callback: unknown,
  thisArg: unknown,
): boolean {
  if (typeof callback !== "function") return false;
  const mapper = callback as CategoryMapper;
  try {
    for (let index = 0; index < array.length; index++) {
      const row = array[index];
      if (mapper.call(thisArg, row, index, array) !== expectedCategory(row)) return false;
    }
    for (let index = 0; index < SYNTHETIC_PROOF_ROWS.length; index++) {
      const row = SYNTHETIC_PROOF_ROWS[index];
      if (mapper.call(thisArg, row, index, SYNTHETIC_PROOF_ROWS) !== expectedCategory(row)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The mapper, run over only the rows this injection inserts — at the index they will have in
 * `planned`, so a mapper that throws on a bridge row (or would put one in the wrong page) never
 * meets one in the host's own `map` call (JD-A-003). The host's own rows are already proved.
 */
function provesPlannedRows(
  callback: unknown,
  thisArg: unknown,
  planned: readonly CustomizeRow[],
  rows: readonly CustomizeRow[],
): boolean {
  if (typeof callback !== "function") return false;
  const mapper = callback as CategoryMapper;
  const inserted = new Set(rows);
  try {
    for (let index = 0; index < planned.length; index++) {
      const row = planned[index];
      if (!inserted.has(row)) continue;
      if (mapper.call(thisArg, row, index, planned) !== expectedCategory(row)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The page the view would derive for a row: `row.category ?? "Settings"` (`:387`). */
function expectedCategory(row: CustomizeRow): string {
  return row.category ?? HOST_DEFAULT_CATEGORY;
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
