/**
 * Width discipline on the host's rail (N17–N19), measured the way the host measures it.
 *
 * ## What decides the width of the main column
 *
 * The rail is the SECOND entry of the host's fullscreen `hstack`, with a FIXED basis:
 *
 * ```ts
 * { component: scroll, basis: RAIL_WIDTH, grow: 0, shrink: 0, minSize: RAIL_WIDTH }
 * ```
 * (`lib/shell-sidebar-layout.ts:493-496`; `RAIL_WIDTH = 50`, `GAP = 3` at `:9,:12`), so a part's
 * rows can never widen the rail column: pi-tui allocates a numeric `basis` without measuring the
 * child (`pi-tui/dist/layout.js:124`, `allocateStackSizes` in `dist/components/stack.js`). What a
 * part CAN change is whether the rail is painted at all:
 *
 * ```ts
 * const active = railLines.length > 0 && railLines.every((line) => visibleWidth(line) <= contentWidth);
 * ```
 * (`lib/shell-sidebar-layout.ts:410`). When a single rail row is wider than the content width the
 * host drops the whole rail and the main column gets every column back — the layout's widths DID
 * change, from the part's output alone.
 *
 * ## How the host measures a row
 *
 * `visibleWidth` (`pi-tui/dist/utils.js:212-268`) strips ANSI, expands a tab to THREE columns
 * (`graphemeWidth`, `:148-155`), segments the rest into grapheme clusters and charges an emoji
 * cluster two columns (`:164-179`). This package's own `visibleColumns` counts a tab as one column
 * and every code point separately, so a row this package believes is 48 columns wide can measure
 * 51 to the host. The port below is the host's model, kept here independently of `src/` so the
 * assertions do not test the implementation against itself.
 *
 * ## The rail path, as the host paints it
 *
 * On the tinted panel surface a part's row becomes `" " + row + " "` (`:414`), and the width a part
 * is handed is `contentWidth - RAIL_PADDING * 2` (`:355`): 48 columns at `RAIL_WIDTH` 50. On a
 * transparent rail the host re-frames the rows itself through the same `< contentWidth` budget
 * (`sectionCardRows` → `cardLine`, `:36-47`), so the budget is the same number.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerSection, resetBusForTests, resetSectionsForTests } from "../src/bus.ts";
import { resetSectionPanelForTests, setSectionTheme } from "../src/section-panel.ts";
import { buildSectionContribution, installSectionRail, resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { installSidebarBackend, resetSidebarStateForTests } from "../src/sidebar.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { SectionContext, SidebarSection } from "../src/types.ts";
import { resetSidebar } from "./fake-sidebar.ts";

// ---------------------------------------------------------------------------------------------
// The host's numbers, quoted from `lib/shell-sidebar-layout.ts`
// ---------------------------------------------------------------------------------------------

/** The rail column's basis (`:9`). */
const RAIL_WIDTH = 50;
/** One column of rail padding on each side of a panel row (`:10`). */
const RAIL_PADDING = 1;
/** The gap between the conversation and the rail (`:12`). */
const GAP = 3;
/** What the rail takes from the editor column (`:15`). */
const RAIL_COLUMNS = RAIL_WIDTH + GAP;
const TERMINAL_COLUMNS = 200;

/** The width the host hands a part on the tinted panel surface (`:355`). */
const GIVEN = RAIL_WIDTH - RAIL_PADDING * 2;

/** The main column the host allocates when the rail paints: no basis of ours is measured. */
const MAIN_WITH_RAIL = TERMINAL_COLUMNS - RAIL_COLUMNS;
/** The main column when the rail does not paint at all. */
const MAIN_WITHOUT_RAIL = TERMINAL_COLUMNS;

const ANSI = /\u001b\[[0-9;]*m/gu;
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\u1160-\u11ff\u200b-\u200f\u202a-\u202e\ufe00-\ufe0f\ufeff]+$/u;
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1f64f}]|[\u{1f900}-\u{1f9ff}]|[\u{20000}-\u{3fffd}]/u;

/**
 * pi-tui's `visibleWidth`: ANSI stripped, a tab is three columns, and each grapheme cluster is
 * charged as a whole (an emoji cluster two columns, a zero-width cluster none).
 */
function hostWidth(line: string): number {
  const clean = line.replace(ANSI, "").replace(/\t/gu, "   ");
  let total = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(clean)) {
    total += clusterWidth(segment);
  }
  return total;
}

function clusterWidth(segment: string): number {
  if (ZERO_WIDTH.test(segment)) return 0;
  if (EMOJI.test(segment)) return 2;
  const base = Array.from(segment).find((char) => !ZERO_WIDTH.test(char)) ?? "";
  return WIDE.test(base) ? 2 : 1;
}

/**
 * The width the layout gives the main column, given what a part returned: the host pads each row by
 * one column on both sides (`:414`) and keeps the rail only while every rail row fits the content
 * width (`:410`). Otherwise the rail is dropped and the conversation gets the full terminal.
 */
function mainColumnFor(partLines: readonly string[]): number {
  const railLines = partLines.map((line) => " ".repeat(RAIL_PADDING) + line + " ".repeat(RAIL_PADDING));
  const active = railLines.length > 0 && railLines.every((line) => hostWidth(line) <= RAIL_WIDTH);
  return active ? MAIN_WITH_RAIL : MAIN_WITHOUT_RAIL;
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-rail-width-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  resetBusForTests();
  resetSectionsForTests();
  resetSidebar();
  resetSidebarStateForTests();
  resetSectionPanelForTests();
  resetSectionFailuresForTests();
  resetStoreStateForTests();
  setSectionTheme(undefined);
  installSectionRail();
  installSidebarBackend(() => ({ terminal: { columns: TERMINAL_COLUMNS, rows: 40 } }));
});

const ctx: SectionContext = { theme: undefined, configHome: "" };

function contribute(section: SidebarSection, width = GIVEN): string[] {
  registerSection(section);
  return buildSectionContribution(width, ctx)?.lines ?? [];
}

/** The widest row, as the host reads it, with the row itself for the failure message. */
function widest(lines: readonly string[]): { width: number; text: string } {
  return lines.reduce(
    (worst, line) => (hostWidth(line) > worst.width ? { width: hostWidth(line), text: line } : worst),
    { width: 0, text: "" },
  );
}

// ---------------------------------------------------------------------------------------------
// N17/N19 — a contributed part never asks for more room than it was given
// ---------------------------------------------------------------------------------------------

test("a section's rows never exceed the width the host handed it, measured the host's way", () => {
  const rows: Array<[string, SidebarSection]> = [
    ["plain ASCII", {
      id: "width.ascii",
      title: "ASCII",
      lines: () => ["transform  registered", "second row"],
    }],
    // `clipRow` measures with `String#length`, so a row of wide characters is left untouched while
    // the host measures twice as many columns.
    ["a wide-character body row", {
      id: "width.wide",
      title: "WIDE",
      lines: () => ["日本語のテキストをここに書いて、幅を超えさせる行です。もっと長くします。"],
    }],
    // A tab is ONE column to this package and THREE to the host (`utils.js:153-155`), so a padded
    // row measures two columns wider than the width it was fitted to.
    ["a tab in a structured row", {
      id: "width.tab",
      title: "TAB",
      lines: () => [{ glyph: "○", label: "rendering\tmode", meta: "default", tone: "muted" }],
    }],
    ["an emoji cluster", {
      id: "width.emoji",
      title: "EMOJI",
      lines: () => [{ glyph: "🎵", label: "now playing 👨‍👩‍👧‍👦", meta: "▶", tone: "accent" }],
    }],
  ];

  // Every case is measured before the first failure, so one RED run names each violation and its
  // numbers instead of only the first.
  const violations: string[] = [];
  for (const [label, section] of rows) {
    resetSectionsForTests();
    const lines = contribute(section);
    assert.ok(lines.length > 0, `${label}: the section contributed no rows`);
    const worst = widest(lines);
    if (worst.width > GIVEN) {
      violations.push(
        `${label}: the host measures ${worst.width} columns for a row fitted to ${GIVEN} (over by ${worst.width - GIVEN}): ${JSON.stringify(worst.text)}`,
      );
    }
  }
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("a contributed section leaves the main column exactly where the host put it", () => {
  // The host's own footer part, as the host paints it: one column of padding on both sides (`:414`).
  const hostFooter = ["▾ STATUS 2", "  model  claude", "  cost   $0.12"];
  assert.equal(mainColumnFor(hostFooter), MAIN_WITH_RAIL);

  const sections: SidebarSection[] = [
    { id: "width.plain", title: "ASCII", lines: () => ["transform  registered"] },
    { id: "width.cjk", title: "WIDE", lines: () => ["日本語のテキストをここに書いて、幅を超えさせる行です。もっと長くします。"] },
    { id: "width.tabbed", title: "TAB", lines: () => [{ glyph: "○", label: "rendering\tmode", meta: "default" }] },
  ];

  for (const section of sections) {
    resetSectionsForTests();
    const lines = contribute(section);
    const rail = [...hostFooter, ...lines];
    assert.equal(
      mainColumnFor(rail),
      MAIN_WITH_RAIL,
      `section ${section.id}: the main column moved to ${mainColumnFor(rail)} (rail columns ${RAIL_COLUMNS}, terminal ${TERMINAL_COLUMNS}); ` +
        `the widest contributed row is ${widest(lines).width} columns for a ${GIVEN}-column budget`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// N20 — the report carries the last render's budget and what the bridge did with it
// ---------------------------------------------------------------------------------------------

test("/bridge-status reports the last render's given width and the widest row the bridge produced", () => {
  contribute({
    id: "width.report",
    title: "REPORT",
    // A row fitted to the budget, and one that has to give way to it.
    lines: () => [{ glyph: "○", label: "rendering", meta: "default" }],
  });
  const report = formatStatus(collectStatus());
  const line = report.find((entry) => entry.startsWith("section width:"));
  assert.equal(line, `section width: ${GIVEN} columns given, widest row ${GIVEN}`);
});

test("a session whose rail never rendered a section keeps its report unchanged", () => {
  registerSection({ id: "width.noframe", title: "NOFRAME", lines: () => ["never rendered"] });
  const report = formatStatus(collectStatus());
  assert.deepEqual(
    report.filter((entry) => entry.startsWith("section width:")),
    [],
  );
});
