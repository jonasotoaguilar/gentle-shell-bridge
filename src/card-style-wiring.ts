/**
 * Wiring the transform to a live TUI (S5, S4): the only way in, done once, with the same marker and
 * generation discipline the sidebar backend already uses (`./sidebar.ts:52-90`).
 *
 * ## The path, and why it is walked here
 *
 * `./card-styles.ts` §1 records the evidence: Pi hands an extension a real `tui` only through
 * `ctx.ui.setWidget`, and from there the conversation component is reachable in two ways —
 *
 * 1. `tui.children[0]` → the document container → `children[2]` (the chat container). `children` is
 *    a declared member of the public `TUI` interface (`pi-tui/dist/tui.d.ts:223-231`) and Pi fills
 *    it in both renderer modes, document first (`interactive-mode.js:623-625,722-731`), so this is
 *    the primary hop.
 * 2. `tui.layoutRoot` → its layout entries → `entries[0].component` (the primary `ScrollView`) →
 *    the scroll view's child (`[LAYOUT_NODE]().component`, `scroll-view.d.ts:57`) → the document →
 *    `children[2]`. `layoutRoot` is TypeScript-`private` and exists only on the fullscreen renderer,
 *    so this is the secondary hop, tried when the first one does not land.
 *
 * Both end at the same component, and the marker below certifies the exact wrapper installed on it,
 * read as an OWN property, so a rebind, a second arm or a second copy of this package reports
 * `already-wrapped` instead of stacking a second transform.
 *
 * ## What the wrapper does
 *
 * It calls the host's own `render(width)` first (the host's failure path stays the host's), and then
 * hands the rows to the pipeline: `transformCardLines` repaints the selected card style (a
 * pass-through unless a style is selected, and it never throws), and `applyTransforms` then runs the
 * registered transcript transforms in order over that output (`./transform-pipeline.ts`). With no
 * style selected and no transform registered the host's own array is what the wrapper returns, so a
 * session that uses neither is byte-identical. The wrapper captures the generation it was created
 * in: once `disableCardStyleTransform()` (or a reset) bumps it, a wrapper foreign code kept a
 * reference to is a plain pass-through, not an injector.
 *
 * ## Every absence is a reported state
 *
 * The `tui` is host state, so the walk never assumes a shape and never creates one: no tui, no
 * children, a first child that is not the document, a document without a third child, a third child
 * that cannot render, an accessor that throws — each is an outcome recorded for `/bridge-status`
 * (`no-tui`, `no-children`, `no-document`, `no-conversation`, `render-missing`, `wrong-shape`), and
 * none of them throws. A session that never got a `tui` keeps `lastOutcome` undefined, which is
 * reported as "not armed" rather than as a failure.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { transformCardLines } from "./card-style-transform.ts";
import { isRecord } from "./rows.ts";
import { applyTransforms } from "./transform-pipeline.ts";

/** The layout protocol symbol, exactly as `pi-tui` defines it (`layout-node.js:1`). */
const LAYOUT_NODE: symbol = Symbol.for("@earendil-works/pi-tui/layout-node");

/** Own property on a wrapped component → the exact wrapper function this module installed. */
const TRANSFORM_WRAPPED: symbol = Symbol.for("gentle-shell-bridge.card-style-transform.wrapped.v1");

/** Process-global, like every other piece of bridge state (`./bus.ts` explains why). */
const WIRING_STATE: symbol = Symbol.for("gentle-shell-bridge.card-style-wiring.state.v1");

/** Why the transform is (or is not) attached. Every value is reported, none is a throw. */
export type CardStyleInstallOutcome =
  | "wrapped"
  | "already-wrapped"
  | "no-tui"
  | "no-children"
  | "no-document"
  | "no-conversation"
  | "render-missing"
  | "wrong-shape";

export interface InstallCardStyleResult {
  installed: boolean;
  outcome: CardStyleInstallOutcome;
  /** The component the wrapper landed on, when it landed. */
  component?: "chat";
  /** Only for `wrong-shape`: the message a host accessor threw. */
  reason?: string;
}

export interface CardStyleWiringDiagnostics {
  /** Conversation components currently wrapped in this process. */
  wrapped: number;
  /** Present when at least one component is wrapped. */
  component?: "chat";
  /** The most recent install attempt's outcome; absent when the transform was never attempted. */
  lastOutcome?: CardStyleInstallOutcome;
  /** Only for `wrong-shape`: the reason, verbatim. */
  lastReason?: string;
}

/** The part of a component this module needs: Pi's `Component.render(width): string[]`. */
interface Renderable {
  render(width: number): readonly string[];
}

/** What a host-shaped component's `render` may be, before the wrapper checks it at runtime. */
type RenderFunction = Renderable["render"];

/** A walk's answer: the component, or the hop that failed. */
type ConversationFound =
  | { found: true; component: Renderable }
  | { found: false; outcome: CardStyleInstallOutcome };

interface WrappedRecord {
  component: Renderable;
  original: RenderFunction;
  wrapper: RenderFunction;
}

interface WiringState {
  /** Bumped by a disable/reset; a wrapper from an older generation is a pass-through. */
  generation: number;
  wrapped: WrappedRecord[];
  lastOutcome?: CardStyleInstallOutcome;
  lastReason?: string;
}

function wiringHost(): Record<symbol, WiringState | undefined> {
  // SAFETY: only `wiringState()` writes this key, and it re-checks the shape before trusting it.
  return globalThis as unknown as Record<symbol, WiringState | undefined>;
}

function wiringState(): WiringState {
  const host = wiringHost();
  const existing = host[WIRING_STATE];
  if (
    existing !== undefined &&
    typeof existing.generation === "number" &&
    Array.isArray(existing.wrapped)
  ) {
    return existing;
  }
  const created: WiringState = { generation: 0, wrapped: [] };
  host[WIRING_STATE] = created;
  return created;
}

/** Diagnostics snapshot for `/bridge-status` (T4) and for this module's own tests. */
export function getCardStyleWiringDiagnostics(): CardStyleWiringDiagnostics {
  const state = wiringState();
  return {
    wrapped: state.wrapped.length,
    ...(state.wrapped.length === 0 ? {} : { component: "chat" as const }),
    ...(state.lastOutcome === undefined ? {} : { lastOutcome: state.lastOutcome }),
    ...(state.lastReason === undefined ? {} : { lastReason: state.lastReason }),
  };
}

/** Test-only seam: forget every record, so one test cannot leak into another. */
export function resetCardStyleWiringForTests(): void {
  const state = wiringState();
  state.wrapped.length = 0;
  delete state.lastOutcome;
  delete state.lastReason;
  // Bump so a wrapper a previous test retained becomes a pass-through instead of injecting.
  state.generation += 1;
}

/** Read `[LAYOUT_NODE]()` from a component, if it exposes it. */
function layoutNodeOf(value: unknown): { entries?: ReadonlyArray<{ component?: unknown }>; component?: unknown } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const read = (value as Record<symbol, unknown>)[LAYOUT_NODE];
  if (typeof read !== "function") return undefined;
  const node: unknown = read.call(value);
  return isRecord(node) ? (node as { entries?: ReadonlyArray<{ component?: unknown }>; component?: unknown }) : undefined;
}

/**
 * The conversation component inside a document container: `children[2]`
 * (`interactive-mode.js:404-407`). Returns why it is not, when it is not.
 */
function conversationOf(document: unknown): ConversationFound {
  if (!isRecord(document)) return { found: false, outcome: "no-document" };
  const children = document.children;
  if (!Array.isArray(children)) return { found: false, outcome: "no-document" };
  const candidate = children[2];
  if (!isRecord(candidate)) return { found: false, outcome: "no-conversation" };
  if (typeof candidate.render !== "function") return { found: false, outcome: "render-missing" };
  // SAFETY: `render` is verified callable above, and it is the only member this module reads;
  // everything a foreign object might carry instead is irrelevant to the wrapper it gets.
  return { found: true, component: candidate as unknown as Renderable };
}

/**
 * Walk `tui` down to the conversation component: primary through `children`, secondary through the
 * layout root. The outcome names the FIRST hop that failed, so `/bridge-status` can say which shape
 * was not what this host promised.
 */
function findConversation(tui: Record<string, unknown>): ConversationFound {
  const children = tui.children;
  const primary: ConversationFound =
    Array.isArray(children) && children.length > 0
      ? conversationOf(children[0])
      : { found: false, outcome: "no-children" };
  if (primary.found) return primary;

  // The secondary hop exists because a host may not have mounted its children yet (or at all) while
  // its layout root still carries the transcript. It is tried whenever the primary hop failed.
  const root = tui.layoutRoot;
  if (root !== undefined) {
    const entries = layoutNodeOf(root)?.entries;
    const scroll = Array.isArray(entries) ? entries[0]?.component : undefined;
    const document = layoutNodeOf(scroll)?.component;
    if (document !== undefined) {
      const secondary = conversationOf(document);
      if (secondary.found) return secondary;
    }
  }
  return primary;
}

/** Wrap one component, once, with a marker that certifies the exact function installed. */
function wrapConversation(component: Renderable): InstallCardStyleResult {
  const current = component.render;
  // SAFETY: a component is an object (verified by `isRecord` before it gets here) and the marker is
  // the only symbol-keyed property this module writes on it, so reading it through a widened record
  // is exact.
  const marked = component as unknown as Record<symbol, unknown>;
  if (Object.hasOwn(component, TRANSFORM_WRAPPED) && marked[TRANSFORM_WRAPPED] === current) {
    return { installed: true, outcome: "already-wrapped", component: "chat" };
  }

  const state = wiringState();
  const generation = state.generation;
  const wrapper = function (this: unknown, width: number): readonly string[] {
    // The host's own render always runs first: a host failure stays the host's to report.
    const lines = current.call(component, width);
    if (wiringState().generation !== generation) return lines;
    if (!Array.isArray(lines)) return lines;
    // SAFETY: `Array.isArray` just proved this is the host's own `string[]`; the card-style
    // transformer and the transform pipeline only ever read it and return either that instance or a
    // new array of strings.
    return applyTransforms(transformCardLines(lines as string[], width), width);
  };

  component.render = wrapper;
  Object.defineProperty(component, TRANSFORM_WRAPPED, {
    value: wrapper,
    enumerable: false,
    configurable: true,
  });
  // Reconfiguring a component we already wrapped (a foreign rebind kept the marker but replaced
  // `render`) replaces the record instead of adding a second one.
  const previous = state.wrapped.findIndex((record) => record.component === component);
  const record: WrappedRecord = { component, original: current, wrapper };
  if (previous === -1) state.wrapped.push(record);
  else state.wrapped[previous] = record;
  return { installed: true, outcome: "wrapped", component: "chat" };
}

/**
 * Attach the transform to the live conversation component behind `tui`.
 *
 * Called from the one place this package receives a real `tui` (`./extension.ts`'s widget factory),
 * never at module load. Safe to call repeatedly: a second call on the same component reports
 * `already-wrapped` and installs nothing. Any absence is an outcome, never a throw — this runs
 * inside the host's widget factory, where an exception would take the sidebar and the rows with it.
 */
export function installCardStyleTransform(tui: unknown): InstallCardStyleResult {
  const state = wiringState();
  const result = attemptInstall(tui);
  state.lastOutcome = result.outcome;
  if (result.reason === undefined) delete state.lastReason;
  else state.lastReason = result.reason;
  return result;
}

function attemptInstall(tui: unknown): InstallCardStyleResult {
  if (!isRecord(tui)) return { installed: false, outcome: "no-tui" };
  try {
    const found = findConversation(tui);
    if (!found.found) return { installed: false, outcome: found.outcome };
    return wrapConversation(found.component);
  } catch (error) {
    // A host accessor that throws is a shape problem, not a crash: report it and stay inert.
    return {
      installed: false,
      outcome: "wrong-shape",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Restore every wrapped component's own `render` and bump the generation, so a wrapper retained by
 * foreign code becomes a pass-through. Returns how many components were restored.
 */
export function disableCardStyleTransform(): number {
  const state = wiringState();
  let restored = 0;
  for (const record of state.wrapped.splice(0)) {
    try {
      if (record.component.render === record.wrapper) {
        record.component.render = record.original;
      }
      if (Object.hasOwn(record.component, TRANSFORM_WRAPPED)) {
        // SAFETY: the marker is the only symbol-keyed property this module writes on a component,
        // and this only removes it; the widened record is how a `symbol` key is deleted.
        delete (record.component as unknown as Record<PropertyKey, unknown>)[TRANSFORM_WRAPPED];
      }
      restored += 1;
    } catch {
      // A component that refuses the assignment keeps its wrapper; the generation still makes it
      // a pass-through, so the transform is off either way.
    }
  }
  state.generation += 1;
  return restored;
}
