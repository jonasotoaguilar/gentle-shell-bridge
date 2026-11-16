/**
 * The DESIGN bus (S1–S9): designs per tool, joined into LINES, one process-global slot.
 *
 * ## Why the bus, and not each plugin
 *
 * Pi has exactly one sanctioned way to choose how a tool's card is drawn:
 * `pi.registerToolRenderer(resolver)` (`docs/extensions.md:2123`;
 * `dist/core/extensions/types.d.ts:546`). Resolvers COMPOSE — Pi chains every extension's resolver
 * (`dist/core/extensions/runner.js:550-553`) — so two plugins that each called it would each wrap the
 * other's component, and neither could see the other's choice.
 *
 * So the BRIDGE registers the resolver (`./tool-design-wiring.ts`), once, and fans it out to the
 * designs plugins contributed here. Two plugins contributing a design for the same line do not
 * collide: they are two VALUES of that line, and they only conflict when they claim the same identity
 * (`line` + `id`) or the same visible label — which is reported, never silently replaced.
 *
 * ## Two registration shapes, one line each
 *
 * - `{ tool, id, label, apply }` is UNGROUPED. It gets an implicit line keyed by the tool name
 *   (`Card bash`), exactly as it did before lines existed (S4).
 * - `{ line, tools, id, label, apply }` is GROUPED. It joins the line named `line`; several
 *   registrations naming the same line produce ONE customize line (`Card tools`) and that line's
 *   tool set is the union of their `tools` (S2, S3).
 *
 * A tool belongs to at most ONE line (S5/D1): a registration that would put it in a second line — or
 * add a legacy `Card <tool>` registration to a tool that already has a line — is refused whole and
 * recorded. Nothing here is bash-specific: a design is declared for a tool NAME, and the registry is
 * keyed by that name.
 *
 * ## The selection
 *
 * One persisted value per line in the bridge's own store file (`bridge-tool-designs`, never the
 * host's config): grouped lines live under `lines` (`{ "tools": "<id>" }`), ungrouped ones keep the
 * historical per-tool `selections` map (`{ "bash": "<id>" }`), untouched. The stored value is a design
 * ID — identity, so renaming a label never loses a user's choice — and `native` means "the host's own
 * card", the documented degrade when a selected design is disposed (`missing`) or does not cover a
 * tool of the line (`not-covered`, S6/D4).
 *
 * Migration (D3) happens ONCE, at REGISTRATION time, never in the render path: a tool joining a line
 * that has no stored value lends that line its legacy per-tool value when that value names a design of
 * the line, and the line value is written then.
 *
 * This module is internal: `src/index.ts` re-exports `registerToolDesign` and the two public types,
 * never this file's diagnostics or its `reset…ForTests` seam.
 */

import { assertRegistrationId } from "./bus.ts";
import { attributeRegistration } from "./plugin-lines.ts";
import { isRecord } from "./rows.ts";
import { createStore } from "./store.ts";
import type { ToolDesignContext, ToolDesignRegistration } from "./types.ts";

/**
 * The STORED value meaning "no design: the host draws the card", shared by every line. It is
 * identity, so it never changes: a user's saved choice keeps working whatever the line shows.
 */
export const TOOL_DESIGN_NATIVE = "native";

/**
 * What a line SHOWS for the host's own card. Display only: the stored value stays
 * `TOOL_DESIGN_NATIVE`. A design may not take this word (or `native`) as its label.
 */
export const TOOL_DESIGN_DEFAULT_LABEL = "default";

/**
 * The bridge's own plugin id for the selection file. One namespaced file holds every line's value,
 * so a selection never lands in the host's `visual-customization.json`.
 */
export const TOOL_DESIGN_STORE_ID = "bridge-tool-designs";

/** The historical per-tool key: `{ "bash": "loon.bash-heading" }`. Untouched by lines (D3). */
export const TOOL_DESIGN_STORE_KEY = "selections";

/**
 * The reserved key INSIDE the `selections` value that holds the per-line map, so one tool's selection
 * and one line's selection are the same document and one `get` serves both (S9/D6: one store read per
 * card per frame). A tool name can never be `$lines`, so it cannot shadow a line.
 */
export const TOOL_DESIGN_LINE_STORE_KEY = "$lines";

/** Why a registration did not become the live one: it replaced one, or it was refused. */
export type ToolDesignConflictKind = "replaced" | "label" | "line";

/** One registration that replaced another, or was refused, kept for `/bridge-status`. */
export interface ToolDesignConflict {
  /** The tool of an ungrouped design, or the line a grouped one belongs to. */
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

/** One live registration, normalized: its line, the tools it paints, and the plugin's design. */
interface DesignEntry {
  /** `tool` for an ungrouped implicit line, `line` for a grouped one. */
  scope: "tool" | "line";
  /** The selection key within its scope: the tool name or the registered line id. */
  line: string;
  /** The tools THIS design paints, in registration order, deduplicated. */
  tools: string[];
  design: ToolDesignRegistration;
}

/** One customize line, as the resolver, the rows and `/bridge-status` read it. */
export interface ToolDesignLine {
  scope: "tool" | "line";
  /** The store key within its scope: the tool name or the registered line id. */
  line: string;
  /** Every tool this line paints, in first-registration order. */
  tools: string[];
  /** Every design of the line, in registration order. */
  designs: ToolDesignRegistration[];
}

interface IndexedLine {
  scope: "tool" | "line";
  line: string;
  tools: string[];
  entries: DesignEntry[];
}

interface ToolDesignIndex {
  revision: number;
  /** tool → the one line that owns it (S5/D1). */
  owner: Map<string, { scope: "tool" | "line"; line: string }>;
  /** Lines in creation order. */
  lines: IndexedLine[];
  byKey: Map<string, IndexedLine>;
  /** tool → its designs, in registration order: the ONE lookup every render path uses (T1). */
  designsByTool: Map<string, ToolDesignRegistration[]>;
}

interface ToolDesignState {
  /** Every live registration, in registration order; one entry per (`scope`, `line`, `id`). */
  entries: DesignEntry[];
  conflicts: ToolDesignConflict[];
  failures: ToolDesignFailure[];
  /**
   * How many times the persisted selections were READ since the last reset. One read is exactly one
   * logical read of the bridge's store, so this counts the file work a render pass performs.
   */
  selectionReads: number;
  /** Bumped by every registry mutation; the in-memory index is rebuilt only when it changes (D6). */
  revision: number;
  /** The derived maps, valid only for `revision`. Never persisted. */
  index?: ToolDesignIndex;
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
    if (typeof existing.revision !== "number") {
      existing.revision = 0;
      delete existing.index;
    }
    // A slot created before grouped lines has `{ tool, design }` entries: normalize them in place.
    for (const raw of existing.entries as unknown[]) {
      if (!isRecord(raw) || !isRecord(raw.design)) continue;
      if (typeof raw.scope === "string" && typeof raw.line === "string" && Array.isArray(raw.tools)) {
        continue;
      }
      const tool = typeof raw.tool === "string" ? raw.tool : raw.design.tool;
      if (typeof tool !== "string") continue;
      raw.scope = "tool";
      raw.line = tool;
      raw.tools = [tool];
    }
    return existing;
  }
  const created: ToolDesignState = {
    entries: [],
    conflicts: [],
    failures: [],
    selectionReads: 0,
    revision: 0,
  };
  host[DESIGNS_KEY] = created;
  return created;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lineKey(scope: "tool" | "line", line: string): string {
  return `${scope}\u0000${line}`;
}

/** Every registry mutation bumps this and drops the derived maps; the next read rebuilds once. */
function bumpRevision(state: ToolDesignState): void {
  state.revision += 1;
  delete state.index;
}

function toolDesignIndex(state: ToolDesignState): ToolDesignIndex {
  const cached = state.index;
  if (cached !== undefined && cached.revision === state.revision) return cached;
  const owner = new Map<string, { scope: "tool" | "line"; line: string }>();
  const lines: IndexedLine[] = [];
  const byKey = new Map<string, IndexedLine>();
  const designsByTool = new Map<string, ToolDesignRegistration[]>();
  for (const entry of state.entries) {
    const key = lineKey(entry.scope, entry.line);
    let line = byKey.get(key);
    if (line === undefined) {
      line = { scope: entry.scope, line: entry.line, tools: [], entries: [] };
      byKey.set(key, line);
      lines.push(line);
    }
    line.entries.push(entry);
    for (const tool of entry.tools) {
      if (!line.tools.includes(tool)) line.tools.push(tool);
      if (!owner.has(tool)) owner.set(tool, { scope: entry.scope, line: entry.line });
      const designs = designsByTool.get(tool);
      if (designs === undefined) designsByTool.set(tool, [entry.design]);
      else designs.push(entry.design);
    }
  }
  const built: ToolDesignIndex = {
    revision: state.revision,
    owner,
    lines,
    byKey,
    designsByTool,
  };
  state.index = built;
  return built;
}

/** Every design of one tool, or every design when `tool` is omitted, in registration order. */
export function designsOfTool(tool: string): ToolDesignRegistration[] {
  return [...(toolDesignIndex(designState()).designsByTool.get(tool) ?? [])];
}

/**
 * Every design of one tool, or of every tool when `tool` is omitted, in registration order. The array
 * is a fresh copy, so a fan-out that iterates it sees a stable list even if a design registers or
 * disposes mid-iteration. It is the ONE lookup the resolver, adoption, the rows and status share (T1).
 */
export function snapshotToolDesigns(tool?: string): ToolDesignRegistration[] {
  if (tool !== undefined) return designsOfTool(tool);
  return designState().entries.map((entry) => entry.design);
}

/** The live lines, in creation order, each with its tools and designs in registration order. */
export function toolDesignLines(): ToolDesignLine[] {
  return toolDesignIndex(designState()).lines.map((line) => ({
    scope: line.scope,
    line: line.line,
    tools: [...line.tools],
    designs: line.entries.map((entry) => entry.design),
  }));
}

/** The line that owns one tool, or `undefined` when no design covers it. */
export function lineOfTool(tool: string): { scope: "tool" | "line"; line: string } | undefined {
  const owner = toolDesignIndex(designState()).owner.get(tool);
  return owner === undefined ? undefined : { ...owner };
}

/** The tool names that have at least one design, in line-creation and tool-registration order. */
export function toolNamesWithDesigns(): string[] {
  const names: string[] = [];
  for (const line of toolDesignIndex(designState()).lines) {
    for (const tool of line.tools) if (!names.includes(tool)) names.push(tool);
  }
  return names;
}

function assertLabel(subject: string, id: string, label: unknown): void {
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error(
      `gentle-shell-bridge: invalid tool design ${JSON.stringify(id)} for ${subject}: label must be ` +
        "a non-empty string. It is the value the user reads on the customize line, so keep it short.",
    );
  }
  if (label === TOOL_DESIGN_NATIVE || label === TOOL_DESIGN_DEFAULT_LABEL) {
    throw new Error(
      `gentle-shell-bridge: invalid tool design label ${JSON.stringify(label)} for ` +
        `${JSON.stringify(id)}: it is the reserved value meaning "the host's own card", so the line ` +
        `would show ${JSON.stringify(label)} twice. Pick a distinct label.`,
    );
  }
}

function assertApplyFunction(subject: string, id: string, apply: unknown): void {
  if (typeof apply !== "function") {
    throw new Error(
      `gentle-shell-bridge: invalid tool design ${JSON.stringify(id)} for ${subject}: apply must be ` +
        "a function of (lines, ctx) that returns the lines to draw. A design rewrites the rows the " +
        "host's card produced; the bridge hands a copy, isolates its throw and reports it in " +
        "/bridge-status (S5).",
    );
  }
}

/** One registration's normalized line, tools and identity. */
interface NormalizedRegistration {
  scope: "tool" | "line";
  line: string;
  tools: string[];
}

/**
 * Exactly one of `tool` / (`line` + `tools`) is required (S2). Mixing them, an empty tool set, a
 * duplicate tool or an invalid name is refused before anything is stored.
 */
function normalizeRegistration(design: ToolDesignRegistration): NormalizedRegistration {
  if (!isRecord(design)) {
    throw new Error(
      "gentle-shell-bridge: invalid tool design: a registration must be an object with exactly one " +
        "of `tool` / (`line` + `tools`), plus `id`, `label` and `apply`.",
    );
  }
  const hasTool = design.tool !== undefined;
  const hasLine = design.line !== undefined;
  const hasTools = design.tools !== undefined;
  const tool = design.tool;
  if (hasTool && (hasLine || hasTools)) {
    throw new Error(
      "gentle-shell-bridge: invalid tool design: `tool` cannot be combined with `line` or `tools`. " +
        "Use `{ tool, id, label, apply }` for one tool, or `{ line, tools, id, label, apply }` for " +
        "one line over several tools.",
    );
  }
  if (!hasTool && !(hasLine && hasTools)) {
    throw new Error(
      "gentle-shell-bridge: invalid tool design: exactly one of `tool` / (`line` + `tools`) is " +
        "required. `{ tool, … }` gives the tool its own line; `{ line, tools, … }` paints several " +
        "tools from one line.",
    );
  }
  if (hasTool) {
    assertRegistrationId("tool name", tool);
    if (typeof tool !== "string") {
      // `assertRegistrationId` narrows by throwing; this keeps the compiler honest.
      throw new Error("gentle-shell-bridge: invalid tool name");
    }
    return { scope: "tool", line: tool, tools: [tool] };
  }
  const line = design.line;
  assertRegistrationId("tool design line", line);
  if (typeof line !== "string") {
    throw new Error("gentle-shell-bridge: invalid tool design line");
  }
  if (!Array.isArray(design.tools) || design.tools.length === 0) {
    throw new Error(
      `gentle-shell-bridge: invalid tool design for line ${JSON.stringify(line)}: tools must be a ` +
        "non-empty array of tool names.",
    );
  }
  const tools: string[] = [];
  for (const value of design.tools) {
    assertRegistrationId("tool name", value);
    if (typeof value === "string") tools.push(value);
  }
  if (new Set(tools).size !== tools.length) {
    throw new Error(
      `gentle-shell-bridge: invalid tool design for line ${JSON.stringify(line)}: tools must be ` +
        "deduplicated. List each tool once; the line's tool set is the union of its designs.",
    );
  }
  return { scope: "line", line, tools };
}

function subjectOf(registration: NormalizedRegistration): string {
  return registration.scope === "tool"
    ? `tool ${JSON.stringify(registration.line)}`
    : `line ${JSON.stringify(registration.line)}`;
}

/**
 * The label is what the user sees, so two designs of one line showing the same text cannot be told
 * apart (the same rule the card-style line applies). Rejected BEFORE anything is stored, with the
 * clash recorded so `/bridge-status` explains why the second design is not in the menu.
 */
function assertLabelIsDistinct(registration: NormalizedRegistration, design: ToolDesignRegistration): void {
  const line = toolDesignIndex(designState()).byKey.get(lineKey(registration.scope, registration.line));
  const clash = line?.entries.find(
    (candidate) => candidate.design.id !== design.id && candidate.design.label === design.label,
  );
  if (clash === undefined) return;
  const subject = subjectOf(registration);
  const message =
    `gentle-shell-bridge: invalid tool design label ${JSON.stringify(design.label)} for ` +
    `${JSON.stringify(design.id)}: it is already used by ${JSON.stringify(clash.design.id)} on ` +
    `${subject}. Two values reading the same cannot be told apart on the line. Pick a distinct label.`;
  recordConflict({
    tool: registration.line,
    id: design.id,
    kind: "label",
    message,
  });
  throw new Error(message);
}

/**
 * A tool belongs to at most ONE line (S5/D1). Joining the same line again is fine (S3: union); any
 * other owner — a different grouped line, or its own legacy `Card <tool>` line — refuses the WHOLE
 * registration and is recorded under the `line` kind.
 */
function assertToolsAreFree(registration: NormalizedRegistration, design: ToolDesignRegistration): void {
  const index = toolDesignIndex(designState());
  for (const tool of registration.tools) {
    const owner = index.owner.get(tool);
    if (owner === undefined) continue;
    if (owner.scope === registration.scope && owner.line === registration.line) continue;
    const current = owner.scope === "tool" ? `its own Card ${JSON.stringify(tool)} line` : `the line ${JSON.stringify(owner.line)}`;
    const message =
      `gentle-shell-bridge: tool ${JSON.stringify(tool)} already belongs to ${current}, so design ` +
      `${JSON.stringify(design.id)} for ${subjectOf(registration)} was refused whole (S5/D1). A tool ` +
      "belongs to at most one line; register it on that line or remove the other registration.";
    recordConflict({ tool, id: design.id, kind: "line", message });
    throw new Error(message);
  }
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
 * Register a design for one tool (ungrouped), for one line over several tools (grouped), or an array
 * of registrations of either shape, and return a disposer that removes exactly what this call
 * registered. Two designs of one line from one call are the same as two calls: they join that line.
 *
 * Same entry discipline as every other bridge surface, because a plugin author should not have to
 * learn two:
 *
 * - a second registration with the same (`line`, `id`) replaces the previous one IN PLACE, so the
 *   value keeps the position its registration earned — and the replacement is RECORDED, because a
 *   silent takeover is exactly what two plugins must never experience (`getToolDesignConflicts`);
 * - the returned disposer removes only the registration it created: after a replacement the replaced
 *   design's disposer is a no-op instead of removing the replacement, and calling it twice does
 *   nothing the second time;
 * - validation happens BEFORE anything is stored (shape, tool, line, id, label, distinctness,
 *   `apply`, tool ownership), so a refused design never half-registers and never reaches a menu;
 * - the registration is ATTRIBUTED like every other surface (`./plugin-lines.ts`): a plugin that
 *   contributes only designs still gets its one INTEGRATIONS line, its `name` is honoured once for
 *   the identity, and a refused design shows up as a rejection instead of disappearing.
 */
export function registerToolDesign(
  design: ToolDesignRegistration | readonly ToolDesignRegistration[],
): () => void {
  if (!Array.isArray(design)) return registerOneToolDesign(design as ToolDesignRegistration);
  // A batch is all-or-nothing, like `registerCommands`: a refused design never leaves the ones before
  // it registered, and the single disposer removes exactly the designs this call stored.
  const state = designState();
  const before = [...state.entries];
  const disposers: Array<() => void> = [];
  try {
    for (const one of design as readonly ToolDesignRegistration[]) {
      disposers.push(registerOneToolDesign(one));
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    // A batch that failed also RESTORES a grouped design it replaced on its way, so "all or nothing"
    // covers the entries it overwrote and not only the ones it appended.
    state.entries.length = 0;
    state.entries.push(...before);
    bumpRevision(state);
    throw error;
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}

function registerOneToolDesign(design: ToolDesignRegistration): () => void {
  return attributeRegistration("tool design", design, undefined, () =>
    registerToolDesignStored(design),
  );
}

/** The store half: validate, then replace in place or append. Called through attribution above. */
function registerToolDesignStored(design: ToolDesignRegistration): () => void {
  const registration = normalizeRegistration(design);
  // Reused from the bus: identity is a plain-object key and the store's key set. The message reads
  // "invalid tool name" / "invalid tool design id", both of which name the field that was wrong.
  assertRegistrationId("tool design", design.id);
  assertLabel(subjectOf(registration), design.id, design.label);
  assertApplyFunction(subjectOf(registration), design.id, design.apply);
  assertToolsAreFree(registration, design);
  assertLabelIsDistinct(registration, design);

  const state = designState();
  const entry: DesignEntry = {
    scope: registration.scope,
    line: registration.line,
    tools: [...registration.tools],
    design,
  };
  const index = state.entries.findIndex(
    (candidate) =>
      candidate.scope === registration.scope &&
      candidate.line === registration.line &&
      candidate.design.id === design.id,
  );
  if (index === -1) {
    state.entries.push(entry);
  } else {
    const previous = state.entries[index].design;
    if (previous !== design) {
      const ownership = registration.scope === "tool" ? "tool" : "line";
      recordConflict({
        tool: registration.line,
        id: design.id,
        kind: "replaced",
        message:
          `gentle-shell-bridge: design ${JSON.stringify(design.id)} for ${ownership} ` +
          `${JSON.stringify(registration.line)} was registered again and the later registration is ` +
          `the live one. Only one design can own a (${ownership}, id); the replacement is reported ` +
          "here instead of happening silently.",
      });
    }
    state.entries[index] = entry;
  }
  bumpRevision(state);
  // Best-effort and never fatal: the registration is already live, so a store that cannot be read or
  // written must not leave a live design with no disposer (the legacy value is simply not migrated).
  try {
    migrateLegacySelection(registration);
  } catch (error) {
    recordToolDesignFailure(
      registration.line,
      design.id,
      `the legacy per-tool selection could not be migrated to ` +
        `${JSON.stringify(registration.line)} (${errorMessage(error)}); the line keeps its own value.`,
    );
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = state.entries.indexOf(entry);
    if (current !== -1) {
      state.entries.splice(current, 1);
      bumpRevision(state);
    }
  };
}

/**
 * D3: a tool joining a line that has NO stored value lends that line its legacy per-tool value when
 * that value names a design of the line, and the line value is written then. Registration time only —
 * never the render path. A line that already has a value is never migrated again, and the legacy
 * `selections` map is left exactly as it was.
 */
function migrateLegacySelection(registration: NormalizedRegistration): void {
  if (registration.scope !== "line") return;
  const selections = readSelections();
  if (Object.hasOwn(selections.lines, registration.line)) return;
  const line = toolDesignIndex(designState()).byKey.get(
    lineKey(registration.scope, registration.line),
  );
  if (line === undefined) return;
  for (const tool of registration.tools) {
    const legacy = storedId(selections.tools, tool);
    if (legacy === TOOL_DESIGN_NATIVE) continue;
    if (!line.entries.some((candidate) => candidate.design.id === legacy)) continue;
    writeSelections({
      tools: selections.tools,
      lines: { ...selections.lines, [registration.line]: legacy },
    });
    return;
  }
}

/** Conflicts recorded by registration, newest per (tool/line, id, kind, message), for `/bridge-status`. */
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
    recordToolDesignFailure(ctx.tool, design.id, errorMessage(error));
    return undefined;
  }
  if (!Array.isArray(applied) || !applied.every((line) => typeof line === "string")) {
    recordToolDesignFailure(
      ctx.tool,
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
// The selection: one persisted value per line
// ---------------------------------------------------------------------------------------------

interface SelectionState {
  /** The unchanged per-tool map (`selections`). */
  tools: Record<string, unknown>;
  /** The per-line map (`lines`), beside it in the same file. */
  lines: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * The persisted selections, read live. An unreadable or malformed file reads as empty, so a
 * hand-edited file can never select a design the user did not choose. ONE logical read of the
 * bridge's store per call, which is what the cost bound counts (S9/D6).
 */
function readSelections(): SelectionState {
  designState().selectionReads += 1;
  // ONE `get`, therefore one file read: the line map travels inside the same value under a reserved
  // key (S9/D6). A file written before grouped lines is a flat `{ <tool>: <id> }` and reads as-is.
  const stored = asRecord(createStore(TOOL_DESIGN_STORE_ID).get<unknown>(TOOL_DESIGN_STORE_KEY, {}));
  const { [TOOL_DESIGN_LINE_STORE_KEY]: lines, ...tools } = stored;
  return { tools, lines: asRecord(lines) };
}

/**
 * The one value to persist: the tool selections flat, the line selections under the reserved key — and
 * the reserved key is written ONLY when a line has a value, so a session with no grouped line keeps the
 * document it has always had, byte for byte.
 */
function writeSelections(state: SelectionState): void {
  const document: Record<string, unknown> = { ...state.tools };
  if (Object.keys(state.lines).length > 0) {
    document[TOOL_DESIGN_LINE_STORE_KEY] = state.lines;
  }
  createStore(TOOL_DESIGN_STORE_ID).set(TOOL_DESIGN_STORE_KEY, document);
}

function storedId(map: Record<string, unknown>, key: string): string {
  if (!Object.hasOwn(map, key)) return TOOL_DESIGN_NATIVE;
  const stored = map[key];
  return typeof stored === "string" && stored.trim() !== "" ? stored : TOOL_DESIGN_NATIVE;
}

/**
 * How many persisted-selection reads happened since the last reset. Each one is a single logical read
 * of the bridge's tool-design store, so a caller can bound the file work a switch or a frame performs
 * instead of timing it (S13/T23). Read by the cost test; not part of the public API.
 */
export function getToolDesignSelectionReads(): number {
  return designState().selectionReads;
}

/** Test-only seam for the read counter; deliberately not re-exported from `src/index.ts`. */
export function resetToolDesignSelectionReads(): void {
  designState().selectionReads = 0;
}

/** The design id stored for one LEGACY per-tool value, or `native` when it has none. */
export function getToolDesignSelection(tool: string): string {
  return storedId(readSelections().tools, tool);
}

/** The design id stored for one line, or `native` when it has none. */
export function getToolDesignLineSelection(scope: "tool" | "line", line: string): string {
  const selections = readSelections();
  return storedId(scope === "tool" ? selections.tools : selections.lines, line);
}

/**
 * Persist one line's selection, FIRST and synchronously: the repaint reads the stored value, so the
 * bullet cannot land on a value that was never written. Ungrouped lines write the historical
 * `selections` map; grouped ones write `lines` beside it (D3).
 */
export function setToolDesignLineSelection(
  scope: "tool" | "line",
  line: string,
  id: string,
): void {
  const selections = readSelections();
  if (scope === "tool") writeSelections({ tools: { ...selections.tools, [line]: id }, lines: selections.lines });
  else writeSelections({ tools: selections.tools, lines: { ...selections.lines, [line]: id } });
}

/** Persist one tool's (ungrouped) selection. Kept as the historical name. */
export function setToolDesignSelection(tool: string, id: string): void {
  setToolDesignLineSelection("tool", tool, id);
}

/**
 * What the stored value means right now for one tool: `native` (the host's own card), the live
 * `design`, `missing` when the design it names left the line, or `not-covered` when the selected
 * value is a design of the line that does not name this tool (S6/D4). Both degrade to the host's
 * card; the difference is what `/bridge-status` reports.
 */
export type ToolDesignSelection =
  | { kind: "native" }
  | { kind: "design"; design: ToolDesignRegistration }
  | { kind: "missing"; id: string }
  | { kind: "not-covered"; id: string };

/** Resolve one tool's persisted line selection against the live registry. Never throws. */
export function resolveToolDesignSelection(tool: string): ToolDesignSelection {
  const state = designState();
  const index = toolDesignIndex(state);
  const owner = index.owner.get(tool);
  // A tool with no group still owns its own (implicit) line, whose value is the historical per-tool
  // one — so a design that was disposed still resolves to `missing` instead of silently to `default`.
  const id =
    owner === undefined ? getToolDesignSelection(tool) : getToolDesignLineSelection(owner.scope, owner.line);
  if (id === TOOL_DESIGN_NATIVE) return { kind: "native" };
  if (owner === undefined) return { kind: "missing", id };
  const line = index.byKey.get(lineKey(owner.scope, owner.line));
  const entry = line?.entries.find((candidate) => candidate.design.id === id);
  if (entry === undefined) return { kind: "missing", id };
  return entry.tools.includes(tool)
    ? { kind: "design", design: entry.design }
    : { kind: "not-covered", id };
}

/** Test-only seam: empties the registry, the conflict records and the failure records in place. */
export function resetToolDesignsForTests(): void {
  const state = designState();
  state.entries.length = 0;
  state.conflicts.length = 0;
  state.failures.length = 0;
  state.selectionReads = 0;
  state.revision += 1;
  delete state.index;
}
