/**
 * The process-global bus: providers (docs/architecture.md §7, docs/contract.md §1, §5), sidebar
 * sections (the sidebar spec's S1, S2) and transcript transforms (this feature's S1).
 *
 * Pi loads every extension through its own jiti loader with `moduleCache: false`, so module
 * scope is per-copy and cannot hold shared state. The registration lists therefore live on
 * `globalThis` behind a stable `Symbol.for` key, exactly as gentle-shell does for its card
 * style (`lib/shell-card.ts:40-41`). Three providers loaded from three copies of this package
 * see one bus.
 *
 * Sections share this slot rather than taking one of their own: both surfaces are registrations
 * that must be process-global for the same reason, and one slot means one place to read (and to
 * reset) what this process has contributed. `bus()` grows the `sections` list on a slot created
 * by a copy that predates it, so a provider list already in flight is kept. The same holds for
 * `cardStyles` and `transforms`.
 *
 * The key is the bridge's own; it is NOT the hook registry key
 * `Symbol.for("gentle-pi.customize-row-providers")`, which belongs to the host (S4/T5), and it
 * is not the host's rail key `Symbol.for("gentle-pi.experimental-sidebar.state")`.
 *
 * This module is internal. `src/index.ts` re-exports `registerRows` and `snapshotProviders`
 * but never `resetBusForTests`; the section equivalents stay internal until the public surface is
 * decided.
 */

import { HOST_CARD_STYLE_VALUES, RESERVED_CARD_STYLE_IDS } from "./card-style-line.ts";
import type {
  CardStyleRegistration,
  RowProvider,
  SidebarSection,
  TranscriptTransform,
} from "./types.ts";

/** Stable process-global slot for the bridge's registration lists. */
const BUS_KEY = Symbol.for("gentle-shell-bridge.providers");

interface BusEntry {
  provider: RowProvider;
}

interface SectionEntry {
  section: SidebarSection;
}

interface CardStyleEntry {
  style: CardStyleRegistration;
}

interface TransformEntry {
  transform: TranscriptTransform;
}

interface BusState {
  /** Providers in subscription order; one entry per live `id`. */
  entries: BusEntry[];
  /** Sections in registration order; one entry per live `id`. Ordering happens in the snapshot. */
  sections: SectionEntry[];
  /** Card styles in registration order; one entry per live `id`. Ordering: `snapshotCardStyles`. */
  cardStyles: CardStyleEntry[];
  /** Transcript transforms in registration order; ordering happens in `snapshotTransforms`. */
  transforms: TransformEntry[];
}

/** The slot shape on `globalThis`; keeps the cast in one place. */
function busHost(): Record<symbol, BusState | undefined> {
  // SAFETY: the only writes to this key are the `bus()` creation below, so IF this key holds
  // anything it holds a BusState. A foreign or partial value is not trusted anyway: `bus()`
  // re-checks `entries` and replaces an unusable slot before returning it.
  return globalThis as unknown as Record<symbol, BusState | undefined>;
}

/**
 * Return the process-global bus, creating it on first use. A pre-existing value that is not a
 * usable bus (another library's slot, a partial object across reloads) is replaced rather than
 * trusted.
 */
function bus(): BusState {
  const host = busHost();
  const existing = host[BUS_KEY];
  if (existing !== undefined && Array.isArray(existing.entries)) {
    // A slot created by a copy of this package (or an earlier load) that predates sections keeps
    // its live providers and gains the section list in place, so two copies always agree.
    if (!Array.isArray(existing.sections)) existing.sections = [];
    // Same for card styles: an older copy's bus gains the list instead of being replaced, so a
    // style registered through one copy is visible to every other (S12, determinism).
    if (!Array.isArray(existing.cardStyles)) existing.cardStyles = [];
    // And for transforms: a copy that predates the pipeline keeps its live registrations and gains
    // the list, so the wrapper another copy installed sees what this copy registered.
    if (!Array.isArray(existing.transforms)) existing.transforms = [];
    return existing;
  }
  const created: BusState = { entries: [], sections: [], cardStyles: [], transforms: [] };
  host[BUS_KEY] = created;
  return created;
}

/**
 * Register a provider and return a disposer that removes exactly that provider.
 *
 * - Providers keep subscription order.
 * - Registering an existing `id` replaces the previous registration *in place*, so the order
 *   is stable and there is still exactly one entry (and one diagnostics entry) for that id.
 * - The disposer removes only the registration it created: after a same-id replacement, the
 *   replaced provider's disposer is a no-op instead of removing the replacement, and calling a
 *   disposer twice does nothing the second time.
 */
export function registerRows(provider: RowProvider): () => void {
  const state = bus();
  const entry: BusEntry = { provider };
  const index = state.entries.findIndex((candidate) => candidate.provider.id === provider.id);
  if (index === -1) state.entries.push(entry);
  else state.entries[index] = entry;

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = state.entries.indexOf(entry);
    if (current !== -1) state.entries.splice(current, 1);
  };
}

/**
 * An ordered snapshot of the registered providers. The array is a fresh copy, so a fan-out
 * that iterates it sees a stable list even if a provider registers or disposes mid-iteration.
 */
export function snapshotProviders(): RowProvider[] {
  return bus().entries.map((entry) => entry.provider);
}

/**
 * Test-only seam: empties the process-global bus in place. Deliberately not re-exported from
 * `src/index.ts`, so it is unreachable from the package's public entry.
 */
export function resetBusForTests(): void {
  bus().entries.length = 0;
}

/**
 * Register a sidebar section and return a disposer that removes exactly that section.
 *
 * Same entry discipline as `registerRows`, because a plugin author should not have to learn two:
 *
 * - A second registration with an existing `id` replaces the previous one *in place*, so the
 *   section keeps the position its registration earned (ordering is computed in
 *   `snapshotSections`, so a replacement that changes `order` moves the section on the next read).
 * - The returned disposer removes only the registration it created: after a same-id replacement the
 *   replaced section's disposer is a no-op instead of removing the replacement, and calling a
 *   disposer twice does nothing the second time.
 *
 * The disposer removes the section from the rail and from `Sections` together, because both surfaces
 * are built from this one registration.
 */
/** Ids that collide with `Object.prototype` and therefore cannot be used as a plain-object key. */
const RESERVED_REGISTRATION_IDS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * An id is identity: it keys the ordering, the replacement and the persisted value. A bad id is a
 * plugin bug and is rejected with a clear error BEFORE anything is stored, so a rejected
 * registration can never half-register (B2). One rule for every surface, so a plugin author does
 * not have to learn two.
 */
function registrationIdProblem(id: unknown): string | undefined {
  if (typeof id !== "string") return "it must be a non-empty string";
  if (id.trim() === "") return "it must be a non-empty string";
  if (RESERVED_REGISTRATION_IDS.has(id)) return "it collides with Object.prototype";
  if (id.includes("\0")) return "it contains a NUL byte";
  return undefined;
}

/** Throws the surface-specific message; `kind` names the thing in both the message and the rule. */
export function assertRegistrationId(kind: string, id: unknown): asserts id is string {
  const problem = registrationIdProblem(id);
  if (problem === undefined) return;
  throw new Error(
    `gentle-shell-bridge: invalid ${kind} id ${JSON.stringify(id)}: ${problem}. ` +
      `A ${kind} id must be a non-empty string that can be used as a plain object key.`,
  );
}

function assertSectionId(id: unknown): asserts id is string {
  assertRegistrationId("section", id);
}

/**
 * `rowLabel`, when present, is text a human reads in the menu, so an empty one is a plugin bug and
 * is rejected before anything is stored — the same discipline as the id.
 */
function assertRowLabel(kind: string, id: string, rowLabel: unknown): void {
  if (rowLabel === undefined) return;
  if (typeof rowLabel !== "string" || rowLabel.trim() === "") {
    throw new Error(
      `gentle-shell-bridge: invalid ${kind} rowLabel for ${JSON.stringify(id)}: it must be a ` +
        "non-empty string. It is the text a user reads in the menu; the id stays internal. Omit it " +
        "to let the bridge derive a label from the visible text instead.",
    );
  }
}

export function registerSection(section: SidebarSection): () => void {
  assertSectionId(section.id);
  assertRowLabel("section", section.id, section.rowLabel);
  const state = bus();
  const entry: SectionEntry = { section };
  const index = state.sections.findIndex((candidate) => candidate.section.id === section.id);
  if (index === -1) state.sections.push(entry);
  else state.sections[index] = entry;

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = state.sections.indexOf(entry);
    if (current !== -1) state.sections.splice(current, 1);
  };
}

/** A section whose `order` is a usable sort key; `NaN`, `Infinity` and a missing value are not. */
function sortableOrder(section: SidebarSection): number | undefined {
  return typeof section.order === "number" && Number.isFinite(section.order)
    ? section.order
    : undefined;
}

/**
 * The rendering order: sections with an `order` first, ascending, then those without, in
 * registration order.
 *
 * Both halves are computed from the registration list, never from `Map` iteration: the sort is on
 * explicit keys with the registration index as the tiebreak, so equal `order`s and unordered
 * sections are deterministic. The array is a fresh copy, so a fan-out that iterates it sees a
 * stable list even if a section registers or disposes mid-iteration.
 */
export function snapshotSections(): SidebarSection[] {
  const ordered: Array<{ section: SidebarSection; order: number; index: number }> = [];
  const rest: SidebarSection[] = [];

  bus().sections.forEach((entry, index) => {
    const order = sortableOrder(entry.section);
    if (order === undefined) rest.push(entry.section);
    else ordered.push({ section: entry.section, order, index });
  });

  ordered.sort((a, b) => a.order - b.order || a.index - b.index);
  return [...ordered.map((entry) => entry.section), ...rest];
}

/**
 * Test-only seam for the section list only, so a provider test and a section test do not clear
 * each other's registrations. Like `resetBusForTests`, it is deliberately not re-exported from
 * `src/index.ts`.
 */
export function resetSectionsForTests(): void {
  bus().sections.length = 0;
}

/**
 * A card style's `order`, when it has one that can be sorted on. `NaN`, `Infinity` and a missing
 * value are not sort keys: a style with one of those keeps its registration position.
 */
function sortableCardStyleOrder(style: CardStyleRegistration): number | undefined {
  return typeof style.order === "number" && Number.isFinite(style.order) ? style.order : undefined;
}

/** A style's `frame` must be exactly what the transformer calls, or the first render would throw. */
function assertCardFrame(id: string, frame: unknown): void {
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
    throw new Error(
      `gentle-shell-bridge: invalid card style ${JSON.stringify(id)}: frame must be an object ` +
        "with top, line and bottom functions.",
    );
  }
  for (const member of ["top", "line", "bottom"] as const) {
    if (typeof (frame as Record<string, unknown>)[member] !== "function") {
      throw new Error(
        `gentle-shell-bridge: invalid card style ${JSON.stringify(id)}: frame.${member} must be a ` +
          "function. A style draws chrome and nothing else (S2).",
      );
    }
  }
}

function assertCardStyleLabel(id: string, label: unknown): void {
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error(
      `gentle-shell-bridge: invalid card style ${JSON.stringify(id)}: label must be a non-empty ` +
        "string. It is the text the user reads on the Card style line, so keep it short.",
    );
  }
}

/**
 * The label is what the user sees, so two styles showing the same text cannot be told apart (S13).
 *
 * Rejected before anything is stored: an equal label of another REGISTERED style (the same id
 * re-registering keeps its own label, because it replaces itself) and any of the host's own values,
 * which the host renders verbatim on the same line. The comparison is exact — case-sensitive, the
 * way the host displays the string — so `cute` and `Cute` are two different visible values.
 */
function assertCardStyleLabelIsDistinct(style: CardStyleRegistration): void {
  if ((HOST_CARD_STYLE_VALUES as readonly string[]).includes(style.label)) {
    throw new Error(
      `gentle-shell-bridge: invalid card style label ${JSON.stringify(style.label)} for ` +
        `${JSON.stringify(style.id)}: it is one of the host's own values ` +
        `(${HOST_CARD_STYLE_VALUES.join(", ")}), so the Card style line would show it twice. ` +
        "Pick a distinct label.",
    );
  }
  const clash = snapshotCardStyles().find(
    (candidate) => candidate.id !== style.id && candidate.label === style.label,
  );
  if (clash !== undefined) {
    throw new Error(
      `gentle-shell-bridge: invalid card style label ${JSON.stringify(style.label)} for ` +
        `${JSON.stringify(style.id)}: it is already used by ${JSON.stringify(clash.id)}. Two values ` +
        "reading the same cannot be told apart on the Card style line. Pick a distinct label.",
    );
  }
}

/**
 * Register a card style and return a disposer that removes exactly that style (S1, S12).
 *
 * Same entry discipline as providers and sections, because a plugin author should not have to learn
 * two:
 *
 * - A second registration with an existing `id` replaces the previous one IN PLACE, so the style
 *   keeps the position its registration earned and there is still exactly one value on the line.
 *   Two plugins cannot both own `loon.cute`: the later registration wins.
 * - The returned disposer removes only the registration it created: after a same-id replacement the
 *   replaced style's disposer is a no-op instead of removing the replacement, and calling a
 *   disposer twice does nothing the second time.
 * - Validation happens BEFORE anything is stored (id, label, both frames), so a rejected style
 *   never half-registers and never reaches a menu build.
 */
export function registerCardStyle(style: CardStyleRegistration): () => void {
  assertRegistrationId("card style", style.id);
  if (RESERVED_CARD_STYLE_IDS.has(style.id)) {
    throw new Error(
      `gentle-shell-bridge: invalid card style id ${JSON.stringify(style.id)}: it is already a ` +
        "value of the Card style line (the host's own neon/float, or the bridge's native), so the " +
        "line would show the same value twice. Pick an id of your own, e.g. \"loon.cute\".",
    );
  }
  assertCardStyleLabel(style.id, style.label);
  assertCardStyleLabelIsDistinct(style);
  assertRowLabel("card style", style.id, style.rowLabel);
  assertCardFrame(style.id, style.frame);

  const state = bus();
  const entry: CardStyleEntry = { style };
  const index = state.cardStyles.findIndex((candidate) => candidate.style.id === style.id);
  if (index === -1) state.cardStyles.push(entry);
  else state.cardStyles[index] = entry;

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = state.cardStyles.indexOf(entry);
    if (current !== -1) state.cardStyles.splice(current, 1);
  };
}

/**
 * Every registered style, in the order its values appear on the line (S12): styles with an `order`
 * first, ascending, then those without, in registration order.
 *
 * Both halves are computed from the registration list, never from `Map` iteration: the sort is on
 * explicit keys with the registration index as the tiebreak, so equal `order`s and unordered styles
 * are deterministic across sessions and across package copies. The array is a fresh copy, so a
 * caller cannot mutate the registry and a fan-out iterating it sees a stable list even if a style
 * registers or disposes mid-iteration.
 */
export function snapshotCardStyles(): CardStyleRegistration[] {
  const ordered: Array<{ style: CardStyleRegistration; order: number; index: number }> = [];
  const rest: CardStyleRegistration[] = [];

  bus().cardStyles.forEach((entry, index) => {
    const order = sortableCardStyleOrder(entry.style);
    if (order === undefined) rest.push(entry.style);
    else ordered.push({ style: entry.style, order, index });
  });

  ordered.sort((a, b) => a.order - b.order || a.index - b.index);
  return [...ordered.map((entry) => entry.style), ...rest];
}

/**
 * Test-only seam for the card style list only, so a style test and a section test do not clear each
 * other's registrations. Like `resetBusForTests`, it is deliberately not re-exported from
 * `src/index.ts`.
 */
export function resetCardStylesForTests(): void {
  bus().cardStyles.length = 0;
}

/**
 * A transform's `order`, when it has one that can be sorted on. `NaN`, `Infinity` and a missing
 * value are not sort keys: a transform with one of those keeps its registration position.
 */
function sortableTransformOrder(transform: TranscriptTransform): number | undefined {
  return typeof transform.order === "number" && Number.isFinite(transform.order)
    ? transform.order
    : undefined;
}

/**
 * The transform member must be exactly what the pipeline calls, checked before anything is stored:
 * a registration the first frame would throw on is a plugin bug, not a frame's problem.
 */
function assertTransformFunction(id: string, transform: unknown): void {
  if (typeof transform !== "function") {
    throw new Error(
      `gentle-shell-bridge: invalid transform ${JSON.stringify(id)}: transform must be a function `
        + `of (lines, ctx) that returns the lines to draw. A transform rewrites rows; the bridge `
        + `clips them, isolates its throw and reports it in /bridge-status (S1).`,
    );
  }
}

/**
 * Register a transcript transform and return a disposer that removes exactly that transform (S1).
 *
 * Same entry discipline as providers, sections and card styles, because a plugin author should not
 * have to learn two:
 *
 * - A second registration with an existing `id` replaces the previous one IN PLACE, so the
 *   transform keeps the position its registration earned (ordering is computed in
 *   `snapshotTransforms`, so a replacement that changes `order` moves the transform on the next
 *   read). Two plugins cannot both own `loon.restyle`: the later registration wins.
 * - The returned disposer removes only the registration it created: after a same-id replacement the
 *   replaced transform's disposer is a no-op instead of removing the replacement, and calling a
 *   disposer twice does nothing the second time.
 * - Validation happens BEFORE anything is stored (id, `transform`), so a rejected transform never
 *   half-registers and never reaches a frame.
 */
export function registerTransform(transform: TranscriptTransform): () => void {
  assertRegistrationId("transform", transform.id);
  assertTransformFunction(transform.id, transform.transform);

  const state = bus();
  const entry: TransformEntry = { transform };
  const index = state.transforms.findIndex((candidate) => candidate.transform.id === transform.id);
  if (index === -1) state.transforms.push(entry);
  else state.transforms[index] = entry;

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = state.transforms.indexOf(entry);
    if (current !== -1) state.transforms.splice(current, 1);
  };
}

/**
 * Every registered transform, in pipeline order (S2): transforms with an `order` first, ascending,
 * then those without, in registration order.
 *
 * Both halves are computed from the registration list, never from `Map` iteration: the sort is on
 * explicit keys with the registration index as the tiebreak, so equal `order`s and unordered
 * transforms are deterministic across sessions and across package copies. The array is a fresh
 * copy, so a frame iterating it sees a stable list even if a transform registers or disposes
 * mid-frame.
 */
export function snapshotTransforms(): TranscriptTransform[] {
  const ordered: Array<{ transform: TranscriptTransform; order: number; index: number }> = [];
  const rest: TranscriptTransform[] = [];

  bus().transforms.forEach((entry, index) => {
    const order = sortableTransformOrder(entry.transform);
    if (order === undefined) rest.push(entry.transform);
    else ordered.push({ transform: entry.transform, order, index });
  });

  ordered.sort((a, b) => a.order - b.order || a.index - b.index);
  return [...ordered.map((entry) => entry.transform), ...rest];
}

/**
 * Test-only seam for the transform list only, so a transform test and a section test do not clear
 * each other's registrations. Like `resetBusForTests`, it is deliberately not re-exported from
 * `src/index.ts`.
 */
export function resetTransformsForTests(): void {
  bus().transforms.length = 0;
}
