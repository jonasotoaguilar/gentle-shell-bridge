/**
 * The process-global bus: providers (docs/architecture.md §7, docs/contract.md §1, §5) and
 * sidebar sections (the sidebar spec's S1, S2).
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
 * by a copy that predates it, so a provider list already in flight is kept.
 *
 * The key is the bridge's own; it is NOT the hook registry key
 * `Symbol.for("gentle-pi.customize-row-providers")`, which belongs to the host (S4/T5), and it
 * is not the host's rail key `Symbol.for("gentle-pi.experimental-sidebar.state")`.
 *
 * This module is internal. `src/index.ts` re-exports `registerRows` and `snapshotProviders`
 * but never `resetBusForTests`; the section equivalents stay internal until the public surface is
 * decided.
 */

import type { RowProvider, SidebarSection } from "./types.ts";

/** Stable process-global slot for the bridge's registration lists. */
const BUS_KEY = Symbol.for("gentle-shell-bridge.providers");

interface BusEntry {
  provider: RowProvider;
}

interface SectionEntry {
  section: SidebarSection;
}

interface BusState {
  /** Providers in subscription order; one entry per live `id`. */
  entries: BusEntry[];
  /** Sections in registration order; one entry per live `id`. Ordering happens in the snapshot. */
  sections: SectionEntry[];
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
    return existing;
  }
  const created: BusState = { entries: [], sections: [] };
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
const RESERVED_SECTION_IDS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A section id is identity: it keys the ordering, the replacement and the persisted toggle. A bad id
 * is a plugin bug and is rejected with a clear error BEFORE anything is stored, so a rejected
 * section can never half-register (B2).
 */
function sectionIdProblem(id: unknown): string | undefined {
  if (typeof id !== "string") return "it must be a non-empty string";
  if (id.trim() === "") return "it must be a non-empty string";
  if (RESERVED_SECTION_IDS.has(id)) return "it collides with Object.prototype";
  if (id.includes("\0")) return "it contains a NUL byte";
  return undefined;
}

function assertSectionId(id: unknown): asserts id is string {
  const problem = sectionIdProblem(id);
  if (problem === undefined) return;
  throw new Error(
    `gentle-shell-bridge: invalid section id ${JSON.stringify(id)}: ${problem}. ` +
      "A section id must be a non-empty string that can be used as a plain object key.",
  );
}

export function registerSection(section: SidebarSection): () => void {
  assertSectionId(section.id);
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
