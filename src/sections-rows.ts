/**
 * The automatic `Sections` toggle rows (S5, S6): the half of the sidebar feature a user actually
 * clicks.
 *
 * A plugin that calls `registerSection` never writes a `setting`, a `value`, a `current()`, an
 * `action()` or a `preview()`, and never names the `Sections` category — this module derives all of
 * it. That is S1's promise: adding the section is the whole integration.
 *
 * ## The toggle
 *
 * Two consecutive rows share one `choice.setting` (the section's identity), with values `shown` and
 * `hidden`, so the host's renderer draws one line: `MUSIC  ● shown  ○ hidden`. `current()` reads the
 * persisted value live, `action()` writes it before returning (the host repaints afterwards, and its
 * repaint re-reads `current()`), and `preview()` depicts the card literally instead of leaving the
 * host's "Preview unavailable" default.
 *
 * ## Where the value lives
 *
 * In the bridge's own store, keyed by section id — see `./visibility.ts` for the document and for why
 * the host's `visual-customization.json` cannot hold it. Visibility is bridge-owned state, not plugin
 * state: the bridge added the toggle, so the plugin needs no store, no file and no setting name.
 *
 * Rows are built per menu build from the live registry, so a section registered later appears (and a
 * disposed section's rows disappear) without re-registering this provider. Rows must not be cached
 * anywhere: a cached list would freeze the sections that existed at the first build.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { registerRows, snapshotSections } from "./bus.ts";
import type { CustomizeRow, RowPreview, SidebarSection } from "./types.ts";
import { getSectionVisibility, isSectionVisible, setSectionVisible } from "./visibility.ts";

/** The internal provider's id; it is the bridge's own registration, never a plugin's. */
export const SECTION_ROWS_PROVIDER_ID = "bridge.sections";

/** The host category the rows join; it already exists and the bridge cannot create one. */
export const SECTIONS_CATEGORY = "Sections";

export const SECTION_SHOWN = "shown";
export const SECTION_HIDDEN = "hidden";

/** One of a toggle's two values. */
export type SectionValue = typeof SECTION_SHOWN | typeof SECTION_HIDDEN;

/**
 * The setting name that makes one section's two rows share a line. Derived from the id, so a
 * replacement registration reuses the same line instead of adding a second one.
 */
export function sectionSetting(id: string): string {
  return `Section: ${id}`;
}

function previewFor(section: SidebarSection, shown: boolean): RowPreview {
  return shown
    ? {
        title: `${section.title} — ${SECTION_SHOWN}`,
        sample: `▾ ${section.title}\n(the card is drawn in the sidebar)`,
      }
    : {
        title: `${section.title} — ${SECTION_HIDDEN}`,
        sample: `▾ ${section.title}  (not drawn)\n(the card does not render and its content is not built)`,
      };
}

function toggleRow(section: SidebarSection, value: SectionValue): CustomizeRow {
  const shown = value === SECTION_SHOWN;
  return {
    category: SECTIONS_CATEGORY,
    // The label names the section, so a user can tell which line controls what. A function, so a
    // replacement registration's title shows without rebuilding the provider.
    label: () => section.title,
    choice: {
      setting: sectionSetting(section.id),
      value,
      // Live read: the bullet reflects what is on disk right now, not what was true at build time.
      current: () => isSectionVisible(getSectionVisibility(), section) === shown,
    },
    preview: () => previewFor(section, shown),
    // Persist FIRST and synchronously; the host's repaint runs after this returns and re-reads
    // `current()`, so the bullet cannot land on a value that was never written.
    action: () => setSectionVisible(section.id, shown),
  };
}

/**
 * Register the bridge's own rows provider and return its disposer. Safe to call more than once: the
 * bus replaces a provider with the same `id` in place, so one entry (and one `Sections` line per
 * section) always exists.
 */
export function installSectionRows(): () => void {
  return registerRows({
    id: SECTION_ROWS_PROVIDER_ID,
    category: SECTIONS_CATEGORY,
    rows: () => {
      const rows: CustomizeRow[] = [];
      for (const section of snapshotSections()) {
        // Both values are emitted even while the section is hidden: that toggle is how a user
        // brings it back.
        rows.push(toggleRow(section, SECTION_SHOWN), toggleRow(section, SECTION_HIDDEN));
      }
      return rows;
    },
  });
}
