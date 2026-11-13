/**
 * The process-global provider bus (docs/architecture.md §7, docs/contract.md §1, §5).
 *
 * Pi loads every extension through its own jiti loader with `moduleCache: false`, so module
 * scope is per-copy and cannot hold shared state. The registration list therefore lives on
 * `globalThis` behind a stable `Symbol.for` key, exactly as gentle-shell does for its card
 * style (`lib/shell-card.ts:40-41`). Three providers loaded from three copies of this package
 * see one bus.
 *
 * The key is the bridge's own; it is NOT the hook registry key
 * `Symbol.for("gentle-pi.customize-row-providers")`, which belongs to the host (S4/T5).
 *
 * This module is internal. `src/index.ts` re-exports `registerRows` and `snapshotProviders`
 * but never `resetBusForTests`.
 */

import type { RowProvider } from "./types.ts";

/** Stable process-global slot for the bridge's provider list. */
const BUS_KEY = Symbol.for("gentle-shell-bridge.providers");

interface BusEntry {
  provider: RowProvider;
}

interface BusState {
  /** Providers in subscription order; one entry per live `id`. */
  entries: BusEntry[];
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
  if (existing !== undefined && Array.isArray(existing.entries)) return existing;
  const created: BusState = { entries: [] };
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
