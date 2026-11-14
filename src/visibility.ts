/**
 * Bridge-owned section visibility (S5, S6).
 *
 * Whether a section is shown is the BRIDGE's state, not the plugin's: the plugin asked for a
 * section, the bridge added the toggle that hides it. Keeping it in the bridge's own store is what
 * makes S1's "one call, zero extra steps" true — a plugin never needs a store, a setting name, a
 * file or a `current()` of its own, and a user's choice survives `/reload` like any native setting.
 *
 * Why not the host's `visual-customization.json`: the host validates that file against a closed
 * `VISUAL_SECTION_KEYS` list (`lib/visual-customization-policy.ts:82`, `keysMatch` ~:112-130) and
 * rejects unknown keys, so a third-party section key cannot live there (S6). The user experience is
 * the native one; the file deliberately is not.
 *
 * One file, one key. `createStore("bridge-sections")` writes
 * `<gentle config home>/gentle-shell-bridge/bridge-sections.json`:
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "values": {
 *     "sections": { "loon.music": false }
 *   }
 * }
 * ```
 *
 * `sections` maps a section id to `true` (shown) / `false` (hidden); a missing id falls back to the
 * section's `defaultVisible` (absent means shown). Values that are not booleans are ignored rather
 * than coerced, so a hand-edited file cannot make a "hidden" section render.
 */

import { isRecord } from "./rows.ts";
import { createStore } from "./store.ts";
import type { SidebarSection } from "./types.ts";

/** The bridge's own plugin id for section visibility: one namespaced file for every section. */
export const SECTIONS_STORE_ID = "bridge-sections";

/** The one key in that file. */
export const SECTIONS_STORE_KEY = "sections";

/** Section id → visible. Only booleans from disk survive the read. */
export type SectionVisibility = Record<string, boolean>;

function toVisibilityMap(value: unknown): SectionVisibility {
  // A NULL-prototype map on purpose: a persisted key such as `__proto__` must be an ordinary entry.
  // On a plain `{}` that write hits the inherited setter, is silently dropped, and the next toggle
  // erases it (B2).
  const map = Object.create(null) as SectionVisibility;
  if (!isRecord(value)) return map;
  for (const [id, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") map[id] = entry;
  }
  return map;
}

/**
 * Read the whole visibility map once. One read per frame (the renderer) and one per menu build (the
 * rows), so a frame never costs a file read per section.
 */
export function getSectionVisibility(): SectionVisibility {
  return toVisibilityMap(createStore(SECTIONS_STORE_ID).get<unknown>(SECTIONS_STORE_KEY, {}));
}

/**
 * Whether one section is visible right now: the persisted value when there is one, otherwise the
 * section's `defaultVisible` (absent means visible).
 */
export function isSectionVisible(
  visibility: SectionVisibility,
  section: Pick<SidebarSection, "id" | "defaultVisible">,
): boolean {
  // Own property only: the map has no prototype, but a caller may hand us an ordinary object, and
  // `visibility["constructor"]` must never resolve to `Object`'s.
  const stored = Object.hasOwn(visibility, section.id) ? visibility[section.id] : undefined;
  return typeof stored === "boolean" ? stored : section.defaultVisible !== false;
}

/**
 * Persist one section's visibility, FIRST and synchronously, so the host's repaint that follows
 * reads the new value. Reads the current map in the same call, so two sections' toggles never
 * overwrite each other.
 */
export function setSectionVisible(id: string, visible: boolean): void {
  const store = createStore(SECTIONS_STORE_ID);
  const current = toVisibilityMap(store.get<unknown>(SECTIONS_STORE_KEY, {}));
  // Build the write map with the same null prototype as the read map, copying entry by entry, so a
  // key like `__proto__` is stored as data rather than routed through a setter.
  const next = Object.create(null) as SectionVisibility;
  for (const [key, value] of Object.entries(current)) next[key] = value;
  next[id] = visible;
  store.set(SECTIONS_STORE_KEY, next);
}
