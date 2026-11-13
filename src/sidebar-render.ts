/**
 * Section rendering (S3, S7, S8): the bridge's half of the sidebar surface, contributed through the
 * rail backend's `setRailContributor` extension point (`./sidebar.ts`).
 *
 * ## The host draws the frame, we supply the rows
 *
 * A section must look like `AGENTS` / `CHANGES` / `STATS`, and those are drawn by the host's own
 * card frame — so the bridge never draws a box. It contributes two things per frame: the part's
 * rows, and the card groups over them. The group shape mirrors
 * `lib/shell-sidebar-layout.ts:392-410`: a group's `start` is the row that carries the card heading
 * (`▾ TITLE`, plus the count right-aligned after a two-space gap) and `end` is one past the last
 * body row, both indices into the part's `render(width)` output, which is also what the group shape
 * in `test/fake-sidebar.ts` models. That is the contract T3 offsets and this module fills; the
 * host calls `sectionCardRows(headerParts(lines[start]), lines.slice(start + 1, end))` on it.
 *
 * ## What a section costs
 *
 * `lines(ctx)` and `meta(ctx)` run per frame, so a plugin's content is honest without a redraw API.
 * A hidden section is not built at all (S7): no rows, and neither function is called. A throwing
 * function, or a return that is not the documented shape, drops that section's body, records the
 * failure for `/bridge-status` and leaves every other section and every native card rendering (S8).
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { snapshotSections } from "./bus.ts";
import { createRowContext } from "./rows.ts";
import type { RailContribution, RailContributor } from "./sidebar.ts";
import { setRailContributor } from "./sidebar.ts";
import type { SectionContext, SidebarSection } from "./types.ts";
import { getSectionVisibility, isSectionVisible } from "./visibility.ts";

/** Rows a section body may occupy before the rest is elided. */
export const MAX_SECTION_BODY_ROWS = 8;

/** The row that marks an elided body; it always fits a sane rail width. */
const ELISION = (hidden: number): string => `… +${hidden} more`;

/** A section whose `lines()` or `meta()` misbehaved in the most recent frame. */
export interface SectionRenderFailure {
  sectionId: string;
  phase: "meta" | "lines";
  message: string;
}

const SECTION_RENDER_STATE = Symbol.for("gentle-shell-bridge.sections.render.v1");

interface SectionRenderState {
  /** What the most recent frame failed on, so `/bridge-status` reports the latest frame. */
  lastFailures: SectionRenderFailure[];
}

function renderStateHost(): Record<symbol, SectionRenderState | undefined> {
  // SAFETY: only `sectionRenderState()` writes this slot, and it validates the shape before use, so
  // a foreign or partial value is replaced rather than trusted.
  return globalThis as unknown as Record<symbol, SectionRenderState | undefined>;
}

function sectionRenderState(): SectionRenderState {
  const host = renderStateHost();
  const existing = host[SECTION_RENDER_STATE];
  if (existing !== undefined && Array.isArray(existing.lastFailures)) return existing;
  const created: SectionRenderState = { lastFailures: [] };
  host[SECTION_RENDER_STATE] = created;
  return created;
}

/** Sections that failed in the most recent frame, for `/bridge-status` (T6). */
export function getSectionFailures(): SectionRenderFailure[] {
  return sectionRenderState().lastFailures.map((failure) => ({ ...failure }));
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetSectionFailuresForTests(): void {
  sectionRenderState().lastFailures = [];
}

/**
 * Build one frame's contribution: a card group per visible section, in the registry's order, after
 * whatever the host's own part already rendered.
 */
export function buildSectionContribution(
  width: number,
  ctx: SectionContext,
): RailContribution | undefined {
  // A part rendered at zero width has no room for a heading or a body row. Contributing nothing
  // keeps the host's own shape untouched instead of returning a row wider than the width.
  if (!Number.isFinite(width) || width < 1) return undefined;

  const state = sectionRenderState();
  // Failures describe the frame, not history: a section that stops throwing stops being reported.
  state.lastFailures = [];

  const visibility = getSectionVisibility();
  const lines: string[] = [];
  const groups: Array<{ start: number; end: number }> = [];

  for (const section of snapshotSections()) {
    // Hidden means NOT BUILT (S7): no rows, no `lines()`, no `meta()`. Hiding is a user choice, not
    // a request to compute something nobody will see.
    if (!isSectionVisible(visibility, section)) continue;

    const meta = readMeta(section, ctx);
    // A meta failure drops the body too (S8's rule is about the section's BODY), while a body
    // failure keeps the heading so the user can still see that the section exists.
    const body = meta.ok ? readBody(section, ctx) : [];
    const start = lines.length;
    lines.push(headingRow(section.title, meta.text, width));
    for (const row of body) lines.push(clipRow(row, width));
    groups.push({ start, end: lines.length });
  }

  return lines.length === 0 ? undefined : { lines, groups };
}

/**
 * The contributor T3 calls once per frame. It resolves the same context a row provider gets — the
 * host's theme where available (the rail render call carries none, so `undefined`) and the resolved
 * gentle-shell config home — so a section never re-derives a path.
 */
export const sectionRailContributor: RailContributor = {
  render: (width) => buildSectionContribution(width, createRowContext(undefined)),
};

/**
 * Contribute the registered sections to the wrapped rail. Idempotent by construction: it stores one
 * function in the backend's state, so a second arm or a second package copy never doubles a card.
 */
export function installSectionRail(): void {
  setRailContributor(sectionRailContributor);
}

interface MetaResult {
  /** False when `meta()` threw or returned the wrong type: the whole body is dropped. */
  ok: boolean;
  /** Trimmed, non-empty text; absent when the section has no meta or it is blank. */
  text?: string;
}

function readMeta(section: SidebarSection, ctx: SectionContext): MetaResult {
  if (section.meta === undefined) return { ok: true };
  let value: unknown;
  try {
    value = section.meta(ctx);
  } catch (error) {
    recordFailure(section.id, "meta", error);
    return { ok: false };
  }
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") {
    recordFailure(section.id, "meta", new Error("meta() must return a string or undefined"));
    return { ok: false };
  }
  const text = value.trim();
  return text === "" ? { ok: true } : { ok: true, text };
}

function readBody(section: SidebarSection, ctx: SectionContext): string[] {
  let value: unknown;
  try {
    value = section.lines(ctx);
  } catch (error) {
    recordFailure(section.id, "lines", error);
    return [];
  }
  // A non-array or a non-string row is a failure, never coerced: a coerced row would show garbage
  // as if the plugin had meant it.
  if (!Array.isArray(value)) {
    recordFailure(section.id, "lines", new Error("lines() must return an array of strings"));
    return [];
  }
  const rows: unknown[] = value;
  if (!rows.every((row): row is string => typeof row === "string")) {
    recordFailure(section.id, "lines", new Error("lines() must return an array of strings"));
    return [];
  }
  return capBody(rows);
}

/** Keep the body inside the row budget, marking the elision visibly. */
function capBody(rows: readonly string[]): string[] {
  if (rows.length <= MAX_SECTION_BODY_ROWS) return [...rows];
  const kept = rows.slice(0, MAX_SECTION_BODY_ROWS - 1);
  // The marker occupies one of the budgeted rows and says how many are not shown.
  return [...kept, ELISION(rows.length - kept.length)];
}

/**
 * The heading row the host splits into glyph, title and count (`headerParts`,
 * `lib/shell-sidebar-layout.ts:57-66`): the count follows a two-space gap so a title with single
 * spaces stays intact, and a count that does not fit is dropped — like `cardTop` drops a hint —
 * rather than widening the part.
 */
function headingRow(title: string, meta: string | undefined, width: number): string {
  const head = `▾ ${title}`;
  if (meta === undefined) return clipRow(head, width);
  const count = `  ${meta}`;
  return head.length + count.length <= width ? head + count : clipRow(head, width);
}

/**
 * Clamp one row to the width the host passes, with a visible marker instead of a silent cut.
 *
 * Measured in code units, not display cells: the bridge carries a section's text through untouched
 * and does no styling of its own, so a plugin that emits ANSI itself is responsible for its own
 * width (the same caveat as a customize row's `label`).
 */
function clipRow(row: string, width: number): string {
  if (row.length <= width) return row;
  if (width <= 1) return "…".slice(0, width);
  return `${row.slice(0, width - 1)}…`;
}

function recordFailure(
  sectionId: string,
  phase: SectionRenderFailure["phase"],
  error: unknown,
): void {
  const state = sectionRenderState();
  state.lastFailures.push({ sectionId, phase, message: errorMessage(error) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
