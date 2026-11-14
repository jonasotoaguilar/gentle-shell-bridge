/**
 * The per-tool DESIGN bus (S4, S5, S7): one registry per tool name, one process-global slot.
 *
 * ## Why the bus, and not each plugin
 *
 * Pi has exactly one sanctioned way to choose how a tool's card is drawn:
 * `pi.registerToolRenderer(resolver)` (`docs/extensions.md:2123`;
 * `dist/core/extensions/types.d.ts:546`). Resolvers COMPOSE — Pi chains every extension's resolver
 * (`dist/core/extensions/runner.js:550-553`) — so two plugins that each called it would each wrap the
 * other's component, and neither could see the other's choice. They also have nowhere to put a
 * customize row that the other agrees with.
 *
 * So the BRIDGE registers the resolver (`./tool-design-wiring.ts`), once, and fans it out to the
 * designs plugins contributed here. Two plugins contributing a design for the same tool do not
 * collide: they are two VALUES of that tool's line, and they only conflict when they claim the same
 * identity (`tool` + `id`) or the same visible label — which is reported, never silently replaced.
 *
 * ## Nothing here is bash-specific (S7)
 *
 * A design is declared for a tool NAME, and the registry is keyed by that name. There is no list of
 * known tools, no default design and no branch on any name: a design declared for `write`, `edit`,
 * `lsp_navigation` or a tool that does not exist yet behaves exactly like one declared for `bash`.
 *
 * ## The selection
 *
 * One persisted value per tool, in the bridge's own store file (`bridge-tool-designs`, never the
 * host's config). The stored value is a design ID — identity, so renaming a label never loses a
 * user's choice — and `native` means "the host's own card", the documented degrade when a selected
 * design is disposed (`missing`, reported instead of rendering a design nobody owns).
 *
 * This module is internal: `src/index.ts` re-exports `registerToolDesign` and the two public types,
 * never this file's diagnostics or its `reset…ForTests` seam.
 */

import { assertRegistrationId } from "./bus.ts";
import { attributeRegistration } from "./plugin-lines.ts";
import { isRecord } from "./rows.ts";
import { createStore } from "./store.ts";
import type { ToolDesignContext, ToolDesignRegistration } from "./types.ts";

/** The value meaning "no design: the host draws the card", shared by every tool's line. */
export const TOOL_DESIGN_NATIVE = "native";

/**
 * The bridge's own plugin id for the selection file. One namespaced file holds every tool's value,
 * so a tool's selection never lands in the host's `visual-customization.json`.
 */
export const TOOL_DESIGN_STORE_ID = "bridge-tool-designs";

/** The one key in that file: `{ "bash": "loon.bash-heading", "write": "native" }`. */
export const TOOL_DESIGN_STORE_KEY = "selections";

/** Why a registration did not become the live one: it replaced one, or it was refused. */
export type ToolDesignConflictKind = "replaced" | "label";

/** One registration that replaced another, or was refused, kept for `/bridge-status`. */
export interface ToolDesignConflict {
  tool: string;
  id: string;
  kind: ToolDesignConflictKind;
  /** What happened, as a person reads it. */
  message: string;
}

/** One design that failed while the host's card was drawn; deduplicated by (tool, id, message). */
export interface ToolDesignFailure {
  tool: string;
  designId: string;
  message: string;
}

/** How many failures are kept for `/bridge-status`; a design that throws every frame is one fact. */
const MAX_FAILURES = 8;

interface DesignEntry {
  tool: string;
  design: ToolDesignRegistration;
}

interface ToolDesignState {
  /** Every live registration, in registration order; one entry per (`tool`, `id`). */
  entries: DesignEntry[];
  conflicts: ToolDesignConflict[];
  failures: ToolDesignFailure[];
  /**
   * How many times the persisted selections were READ since the last reset. One read is exactly one
   * `readFileSync` (`./store.ts`'s `get`), so this counts the file work a render pass costs.
   */
  selectionReads: number;
}

/** Stable process-global slot, like the bus and the store: two copies must agree. */
const DESIGNS_KEY = Symbol.for("gentle-shell-bridge.tool-designs.v1");

function designsHost(): Record<symbol, ToolDesignState | undefined> {
  // SAFETY: only `designState()` writes this key, and it re-checks every list before trusting a
  // value left behind by another copy or an older load.
  return globalThis as unknown as Record<symbol, ToolDesignState | undefined>;
}

function designState(): ToolDesignState {
  const host = designsHost();
  const existing = host[DESIGNS_KEY];
  if (existing !== undefined && Array.isArray(existing.entries)) {
    // A slot created by a copy that predates the diagnostics keeps its live registrations and gains
    // the lists in place, so two copies always see one registry.
    if (!Array.isArray(existing.conflicts)) existing.conflicts = [];
    if (!Array.isArray(existing.failures)) existing.failures = [];
    if (typeof existing.selectionReads !== "number") existing.selectionReads = 0;
    return existing;
  }
  const created: ToolDesignState = { entries: [], conflicts: [], failures: [], selectionReads: 0 };
  host[DESIGNS_KEY] = created;
  return created;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertLabel(tool: string, id: string, label: unknown): void {
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error(
      `gentle-shell-bridge: invalid tool design ${JSON.stringify(id)} for tool ` +
        `${JSON.stringify(tool)}: label must be a non-empty string. It is the value the user reads ` +
        "on the customize line, so keep it short.",
    );
  }
  if (label === TOOL_DESIGN_NATIVE) {
    throw new Error(
      `gentle-shell-bridge: invalid tool design label ${JSON.stringify(label)} for ` +
        `${JSON.stringify(id)}: it is the reserved value meaning "the host's own card", so the line ` +
        `would show ${JSON.stringify(label)} twice. Pick a distinct label.`,
    );
  }
}

function assertApplyFunction(tool: string, id: string, apply: unknown): void {
  if (typeof apply !== "function") {
    throw new Error(
      `gentle-shell-bridge: invalid tool design ${JSON.stringify(id)} for tool ` +
        `${JSON.stringify(tool)}: apply must be a function of (lines, ctx) that returns the lines to ` +
        "draw. A design rewrites the rows the host's card produced; the bridge hands a copy, isolates " +
        "its throw and reports it in /bridge-status (S5).",
    );
  }
}

/**
 * The label is what the user sees, so two designs of one tool showing the same text cannot be told
 * apart (the same rule the card-style line applies). Rejected BEFORE anything is stored, with the
 * clash recorded so `/bridge-status` explains why the second design is not in the menu.
 */
function assertLabelIsDistinct(design: ToolDesignRegistration): void {
  const clash = snapshotToolDesigns(design.tool).find(
    (candidate) => candidate.id !== design.id && candidate.label === design.label,
  );
  if (clash === undefined) return;
  const message =
    `gentle-shell-bridge: invalid tool design label ${JSON.stringify(design.label)} for ` +
    `${JSON.stringify(design.id)}: it is already used by ${JSON.stringify(clash.id)} on tool ` +
    `${JSON.stringify(design.tool)}. Two values reading the same cannot be told apart on the line. ` +
    "Pick a distinct label.";
  recordConflict({
    tool: design.tool,
    id: design.id,
    kind: "label",
    message,
  });
  throw new Error(message);
}

function recordConflict(conflict: ToolDesignConflict): void {
  const state = designState();
  const index = state.conflicts.findIndex(
    (candidate) =>
      candidate.tool === conflict.tool &&
      candidate.id === conflict.id &&
      candidate.kind === conflict.kind &&
      candidate.message === conflict.message,
  );
  if (index === -1) state.conflicts.push(conflict);
  else state.conflicts[index] = conflict;
}

/**
 * Register a design for one tool and return a disposer that removes exactly that design.
 *
 * Same entry discipline as every other bridge surface, because a plugin author should not have to
 * learn two:
 *
 * - a second registration with the same (`tool`, `id`) replaces the previous one IN PLACE, so the
 *   value keeps the position its registration earned — and the replacement is RECORDED, because a
 *   silent takeover is exactly what two plugins must never experience (`getToolDesignConflicts`);
 * - the returned disposer removes only the registration it created: after a replacement the replaced
 *   design's disposer is a no-op instead of removing the replacement, and calling it twice does
 *   nothing the second time;
 * - validation happens BEFORE anything is stored (tool, id, label, distinctness, `apply`), so a
 *   refused design never half-registers and never reaches a menu;
 * - the registration is ATTRIBUTED like every other surface (`./plugin-lines.ts`): a plugin that
 *   contributes only designs still gets its one INTEGRATIONS line, its `name` is honoured once for
 *   the identity, and a refused design shows up as a rejection instead of disappearing.
 */
export function registerToolDesign(design: ToolDesignRegistration): () => void {
  return attributeRegistration("tool design", design, undefined, () =>
    registerToolDesignStored(design),
  );
}

/** The store half: validate, then replace in place or append. Called through attribution above. */
function registerToolDesignStored(design: ToolDesignRegistration): () => void {
  // Reused from the bus: identity is a plain-object key and the store's key set. The message reads
  // "invalid tool name" / "invalid tool design id", both of which name the field that was wrong.
  assertRegistrationId("tool name", design.tool);
  assertRegistrationId("tool design", design.id);
  assertLabel(design.tool, design.id, design.label);
  assertApplyFunction(design.tool, design.id, design.apply);
  assertLabelIsDistinct(design);

  const state = designState();
  const entry: DesignEntry = { tool: design.tool, design };
  const index = state.entries.findIndex(
    (candidate) => candidate.tool === design.tool && candidate.design.id === design.id,
  );
  if (index === -1) {
    state.entries.push(entry);
  } else {
    const previous = state.entries[index].design;
    if (previous !== design) {
      recordConflict({
        tool: design.tool,
        id: design.id,
        kind: "replaced",
        message:
          `gentle-shell-bridge: design ${JSON.stringify(design.id)} for tool ` +
          `${JSON.stringify(design.tool)} was registered again and the later registration is the ` +
          "live one. Only one design can own a (tool, id); the replacement is reported here instead " +
          "of happening silently.",
      });
    }
    state.entries[index] = entry;
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = state.entries.indexOf(entry);
    if (current !== -1) state.entries.splice(current, 1);
  };
}

/**
 * Every design of one tool, or of every tool when `tool` is omitted, in registration order. The array
 * is a fresh copy, so a fan-out that iterates it sees a stable list even if a design registers or
 * disposes mid-iteration.
 */
export function snapshotToolDesigns(tool?: string): ToolDesignRegistration[] {
  return designState()
    .entries.filter((entry) => tool === undefined || entry.tool === tool)
    .map((entry) => entry.design);
}

/** The tool names that have at least one design, in registration order (one line each, T9). */
export function toolNamesWithDesigns(): string[] {
  const names: string[] = [];
  for (const entry of designState().entries) {
    if (!names.includes(entry.tool)) names.push(entry.tool);
  }
  return names;
}

/** Conflicts recorded by registration, newest per (tool, id, kind, message), for `/bridge-status`. */
export function getToolDesignConflicts(): ToolDesignConflict[] {
  return designState().conflicts.map((conflict) => ({ ...conflict }));
}

/**
 * Record one design failure, ONCE per (tool, id, message): a design that throws every frame is one
 * fact, not one line per frame. Bounded, so a plugin cannot grow the report without limit.
 */
export function recordToolDesignFailure(tool: string, designId: string, message: string): void {
  const state = designState();
  const duplicate = state.failures.some(
    (failure) =>
      failure.tool === tool && failure.designId === designId && failure.message === message,
  );
  if (duplicate) return;
  state.failures.push({ tool, designId, message });
  if (state.failures.length > MAX_FAILURES) {
    state.failures.splice(0, state.failures.length - MAX_FAILURES);
  }
}

/** The failures the last frames recorded, oldest first. Read by `/bridge-status`. */
export function getToolDesignFailures(): ToolDesignFailure[] {
  return designState().failures.map((failure) => ({ ...failure }));
}

/**
 * Hand the host's own rows to the selected design (`./tool-design-wiring.ts` calls this on every
 * render pass).
 *
 * Returns `undefined` when the host's rows must stand — a throw, or a return value that is not an
 * array of strings — so the caller draws the host's card unchanged. The design receives a COPY: a
 * design that mutates its input cannot corrupt the array the host's component still owns.
 */
export function applyToolDesign(
  design: ToolDesignRegistration,
  lines: readonly string[],
  ctx: ToolDesignContext,
): string[] | undefined {
  let applied: unknown;
  try {
    applied = design.apply([...lines], ctx);
  } catch (error) {
    recordToolDesignFailure(design.tool, design.id, errorMessage(error));
    return undefined;
  }
  if (!Array.isArray(applied) || !applied.every((line) => typeof line === "string")) {
    recordToolDesignFailure(
      design.tool,
      design.id,
      "apply returned something that is not an array of strings; the host's own rows are drawn " +
        "instead. Return the rows to draw, e.g. `return lines`.",
    );
    return undefined;
  }
  // SAFETY: the element check above proves every member is a string.
  return applied as string[];
}

// ---------------------------------------------------------------------------------------------
// The selection: one persisted value per tool
// ---------------------------------------------------------------------------------------------

/**
 * The persisted selections, read live. An unreadable or malformed file reads as empty, so a
 * hand-edited file can never select a design the user did not choose.
 */
function readSelections(): Record<string, unknown> {
  designState().selectionReads += 1;
  const stored = createStore(TOOL_DESIGN_STORE_ID).get<unknown>(TOOL_DESIGN_STORE_KEY, {});
  return isRecord(stored) ? stored : {};
}

/**
 * How many persisted-selection reads happened since the last reset. Each one is a single
 * `readFileSync` of the bridge's tool-design store, so a caller can bound the file work a switch or a
 * frame performs instead of timing it (S13/T23). Read by the cost test; not part of the public API.
 */
export function getToolDesignSelectionReads(): number {
  return designState().selectionReads;
}

/** Test-only seam for the read counter; deliberately not re-exported from `src/index.ts`. */
export function resetToolDesignSelectionReads(): void {
  designState().selectionReads = 0;
}

/** The design id stored for one tool, or `native` when it has none (or the value is unusable). */
export function getToolDesignSelection(tool: string): string {
  const selections = readSelections();
  if (!Object.hasOwn(selections, tool)) return TOOL_DESIGN_NATIVE;
  const stored = selections[tool];
  return typeof stored === "string" && stored.trim() !== "" ? stored : TOOL_DESIGN_NATIVE;
}

/**
 * Persist one tool's selection, FIRST and synchronously: the repaint reads the stored value, so the
 * bullet cannot land on a value that was never written.
 */
export function setToolDesignSelection(tool: string, id: string): void {
  createStore(TOOL_DESIGN_STORE_ID).set(TOOL_DESIGN_STORE_KEY, { ...readSelections(), [tool]: id });
}

/**
 * What the stored value means right now: `native` (the host's own card), the live `design`, or
 * `missing` when the design it names was disposed. `missing` is a first-class answer, never an error:
 * the resolver degrades to the host's card and `/bridge-status` says why.
 */
export type ToolDesignSelection =
  | { kind: "native" }
  | { kind: "design"; design: ToolDesignRegistration }
  | { kind: "missing"; id: string };

/** Resolve one tool's persisted selection against the live registry. Never throws. */
export function resolveToolDesignSelection(tool: string): ToolDesignSelection {
  const id = getToolDesignSelection(tool);
  if (id === TOOL_DESIGN_NATIVE) return { kind: "native" };
  const design = snapshotToolDesigns(tool).find((candidate) => candidate.id === id);
  return design === undefined ? { kind: "missing", id } : { kind: "design", design };
}

/** Test-only seam: empties the registry, the conflict records and the failure records in place. */
export function resetToolDesignsForTests(): void {
  const state = designState();
  state.entries.length = 0;
  state.conflicts.length = 0;
  state.failures.length = 0;
  state.selectionReads = 0;
}
