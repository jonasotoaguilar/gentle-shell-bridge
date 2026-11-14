/**
 * Section rendering (S3, S7, S8; N10–N14): the bridge's half of the sidebar surface, contributed
 * through the rail backend's `setRailContributor` extension point (`./sidebar.ts`).
 *
 * ## The host draws the frame, we supply the header and the rows
 *
 * A section must look like `AGENTS` / `CHANGES` / `STATS`, and those are drawn by the host's own
 * card frame — so the bridge never draws a box. It contributes two things per frame: the part's
 * rows, and the card groups over them. The group shape mirrors
 * `lib/shell-sidebar-layout.ts:392-410`: a group's `start` is the row that carries the card heading
 * (`▾ TITLE`, plus the count right-aligned) and `end` is one past the last body row, both indices
 * into the part's `render(width)` output, which is also what the group shape in
 * `test/fake-sidebar.ts` models. That is the contract T3 offsets and this module fills; the host
 * calls `sectionCardRows(headerParts(lines[start]), lines.slice(start + 1, end))` on it.
 *
 * ## The header and the rows are the host's own drawing (N11)
 *
 * The header comes from `./section-panel.ts`'s `renderSectionHeader` — caret from the section's own
 * collapse state, uppercase title, the right-aligned `meta`, the host's hover role — and a
 * structured row from `renderSectionRow`, composed the way `lib/agents-widget.ts:400-407` composes an
 * `AGENTS` row. Both use the host's builders when a host publishes them and the byte-identical local
 * port otherwise; `/bridge-status` reports which.
 *
 * ## A plain string row is untouched (N10)
 *
 * `lines()` may return a string or a `SectionRow`. A string keeps the exact bytes the author wrote —
 * no indent, no padding, no styling — so no existing plugin's card changes appearance. Only a
 * structured row gets the panel treatment, because only a structured row asked for it.
 *
 * ## Interaction (N12, N13)
 *
 * The host's own click model is POSITIONAL: it maps a pointer event into the part's frame and calls
 * the part's `handleMouse` (`lib/shell-sidebar-layout.ts:245-259`), so this module records which of
 * its own rows is the header and which are clickable, and answers only those events. A row without
 * `onClick` is inert: it never highlights and never answers. The header toggles the section; the
 * collapse flag lives in the bridge's store, like visibility (`./visibility.ts`), and the frame is
 * requested synchronously (`./repaint.ts`).
 *
 * ## What a section costs
 *
 * `lines(ctx)` and `meta(ctx)` run per frame, so a plugin's content is honest without a redraw API.
 * A hidden section is not built at all (S7), a COLLAPSED one is not built either (N13): no rows, and
 * neither function is called for the body. A throwing function, or a return that is not the
 * documented shape, drops that section's body, records the failure for `/bridge-status` and leaves
 * every other section and every native card rendering (S8).
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { snapshotSections } from "./bus.ts";
import { requestSurfaceRepaint } from "./repaint.ts";
import { createRowContext } from "./rows.ts";
import {
  checkSectionRows,
  getSectionTheme,
  getPanelReport,
  renderSectionHeader,
  renderSectionRow,
  type AcceptedRow,
  type PanelTheme,
} from "./section-panel.ts";
import { claimSectionHover, releaseSectionHover } from "./section-pointer.ts";
import type {
  RailContribution,
  RailContributor,
  RailContributionPosition,
  RailMouseResult,
} from "./sidebar.ts";
import { setRailContributor } from "./sidebar.ts";
import type { SectionContext, SidebarSection } from "./types.ts";
import {
  getSectionCollapsed,
  getSectionVisibility,
  isSectionCollapsed,
  isSectionVisible,
  setSectionCollapsed,
} from "./visibility.ts";

/** Rows a section body may occupy before the rest is elided. */
export const MAX_SECTION_BODY_ROWS = 8;

/** The row that marks an elided body; it always fits a sane rail width. */
const ELISION = (hidden: number): string => `… +${hidden} more`;

/** A section whose `lines()` or `meta()` misbehaved in the most recent frame. */
export interface SectionRenderFailure {
  sectionId: string;
  phase: "meta" | "lines" | "onClick";
  message: string;
}

/**
 * One physical row of the last contribution, so a pointer event can be mapped to what the user sees
 * (N12). `y` in a part's mouse event counts the PART's rows; `row` counts this contribution's,
 * which is why the backend hands us the offset (`RailContributionPosition`).
 */
export interface SectionRowHit {
  /** Index within the contribution (not the part's frame). */
  row: number;
  sectionId: string;
  kind: "header" | "body";
  /** The hover identity, for a row that can be highlighted; absent for an inert row. */
  key?: string;
  /** What a click on this row does; absent for an inert row. */
  activate?: () => void;
}

interface SectionFrame {
  width: number;
  hits: SectionRowHit[];
}

const SECTION_RENDER_STATE = Symbol.for("gentle-shell-bridge.sections.render.v1");

interface SectionRenderState {
  /** What the most recent frame failed on, so `/bridge-status` reports the latest frame. */
  lastFailures: SectionRenderFailure[];
  /** The rows of the most recent contribution, for pointer hit-testing. */
  frame?: SectionFrame;
  /** The hovered row's key, or absent when the pointer is not on one of ours. */
  hovered?: string;
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

/** Test-only seam; drops the last frame and the hover too, so one test cannot leak into another. */
export function resetSectionFailuresForTests(): void {
  const state = sectionRenderState();
  state.lastFailures = [];
  delete state.frame;
  delete state.hovered;
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
  const collapsedMap = getSectionCollapsed();
  const theme = getSectionTheme();
  const hovered = state.hovered;
  const lines: string[] = [];
  const hits: SectionRowHit[] = [];
  const groups: Array<{ start: number; end: number }> = [];

  for (const section of snapshotSections()) {
    // Hidden means NOT BUILT (S7): no rows, no `lines()`, no `meta()`. Hiding is a user choice, not
    // a request to compute something nobody will see.
    if (!isSectionVisible(visibility, section)) continue;

    const collapsed = isSectionCollapsed(collapsedMap, section);
    const meta = readMeta(section, ctx);
    // A meta failure drops the body too (S8's rule is about the section's BODY), while a body
    // failure keeps the heading so the user can still see that the section exists. A collapsed
    // section builds no body at all (N13) — folding must not cost the work of drawing.
    const body = meta.ok && !collapsed ? readBody(section, ctx) : [];
    const start = lines.length;
    const headerKey = `${section.id}#header`;
    const headerHovered = hovered === headerKey;
    lines.push(
      renderSectionHeader(theme, width, {
        title: section.title,
        ...(meta.text === undefined ? {} : { count: meta.text }),
        open: !collapsed,
        hovered: headerHovered,
      }),
    );
    hits.push({
      row: start,
      sectionId: section.id,
      kind: "header",
      key: headerKey,
      activate: () => toggleSectionCollapsed(section),
    });
    // Isolation is per SECTION, not per frame (S8): one section must never be able to throw away
    // its siblings' rows or its own heading. The validation in `readBody` catches the cases we know
    // about; this guard covers the ones we do not.
    try {
      appendBody(section, body, { theme, width, hovered, lines, hits });
    } catch (error) {
      recordFailure(section.id, "lines", error);
      lines.length = start + 1; // keep the heading, drop the broken body
      hits.length = start + 1;
    }
    groups.push({ start, end: lines.length });
  }

  if (lines.length === 0) {
    delete state.frame;
    return undefined;
  }
  state.frame = { width, hits };
  return { lines, groups };
}

/** One section's body rows, each recorded for the pointer map as it is drawn. */
function appendBody(
  section: SidebarSection,
  body: readonly AcceptedRow[],
  frame: {
    theme: PanelTheme | undefined;
    width: number;
    hovered: string | undefined;
    lines: string[];
    hits: SectionRowHit[];
  },
): void {
  body.forEach((entry, index) => {
    const row = frame.lines.length;
    if (typeof entry === "string") {
      // Byte-identical (N10): a plain row is the author's text, clipped to the width and nothing
      // else — no indent, no padding, no styling, no hit target.
      frame.lines.push(clipRow(entry, frame.width));
      frame.hits.push({ row, sectionId: section.id, kind: "body" });
      return;
    }
    const key = entry.onClick === undefined ? undefined : `${section.id}#${index}`;
    frame.lines.push(
      renderSectionRow(frame.theme, frame.width, entry, key !== undefined && frame.hovered === key),
    );
    frame.hits.push({
      row,
      sectionId: section.id,
      kind: "body",
      ...(key === undefined ? {} : { key }),
      ...(entry.onClick === undefined ? {} : { activate: entry.onClick }),
    });
  });
}

/**
 * The contributor T3 calls once per frame. It resolves the same context a row provider gets — the
 * theme Pi handed the widget factory (so a section can paint with the host's own roles, N11) and the
 * resolved gentle-shell config home — so a section never re-derives a path.
 */
export const sectionRailContributor: RailContributor = {
  render: (width) => buildSectionContribution(width, createRowContext(getSectionTheme())),
  // N14: the layout re-renders a part only when its digest moves, so the built rows are what the
  // signature is made of. Reading `meta()`/`lines()` here is the same trade the host's own parts
  // make (`extensions/gentle-agents.ts:2255-2260`): a live field has to be read to be noticed.
  digest: () => sectionRailDigest(createRowContext(getSectionTheme())),
  handleMouse: (event, position) => handleSectionMouse(event, position),
};

/**
 * A cheap signature of everything a frame would draw: the sections, their header counts, their
 * collapse flags, their rows and the hover state. Two frames that would draw the same rows have the
 * same signature, so a change anywhere in it — a `meta` that moved (N14), a collapse, a hover —
 * reaches the host's memo as a new digest and repaints.
 */
export function sectionRailDigest(ctx: SectionContext): string {
  const visibility = getSectionVisibility();
  const collapsedMap = getSectionCollapsed();
  const state = sectionRenderState();
  const sections: unknown[] = [];
  for (const section of snapshotSections()) {
    if (!isSectionVisible(visibility, section)) {
      sections.push([section.id, false]);
      continue;
    }
    const collapsed = isSectionCollapsed(collapsedMap, section);
    const meta = readMeta(section, ctx);
    const body = meta.ok && !collapsed ? readBody(section, ctx) : [];
    sections.push([
      section.id,
      section.title,
      meta.text ?? null,
      collapsed,
      body.map(rowSignature),
    ]);
  }
  const panel = getPanelReport();
  return JSON.stringify([sections, state.hovered ?? null, panel.source, themeSignature()]);
}

/** One body row, flattened into a comparable string for the digest (N14). */
function rowSignature(row: AcceptedRow): string {
  if (typeof row === "string") return `s:${row}`;
  const parts = [row.label, row.meta ?? "", row.glyph ?? "", row.tone ?? ""];
  return `r:${JSON.stringify(parts)}:${row.onClick === undefined ? "inert" : "acts"}`;
}

/**
 * What the current theme paints with. Pi hands extensions ONE live theme proxy, so identity never
 * changes on a theme switch; how the roles paint does. The host's memo keys on the same idea
 * (`lib/shell-sidebar-layout.ts:123-124`), which is why a themed row repaints when the theme changes.
 */
function themeSignature(): string {
  const theme = getSectionTheme();
  if (theme === undefined) return "no-theme";
  const roles = ["accent", "dim", "error", "muted", "success", "text", "warning"];
  try {
    return roles.map((role) => theme.fg(role, ".")).join("");
  } catch {
    return "theme-throws";
  }
}

/**
 * Answer a pointer event the host mapped into the part's frame (N12). Only our own rows answer, and
 * only where they act: the header always does (it folds the section), a body row only when it
 * carries `onClick`.
 */
export function handleSectionMouse(
  event: unknown,
  position?: RailContributionPosition,
): RailMouseResult | undefined {
  const state = sectionRenderState();
  const frame = state.frame;
  const startRow = position?.startRow;
  if (frame === undefined || startRow === undefined) return undefined;
  const pointer = readPointer(event);
  if (pointer === undefined) return undefined;
  const hit = frame.hits.find((candidate) => candidate.row === pointer.y - startRow);
  if (hit === undefined) return undefined;

  if (pointer.type === "move") {
    if (hit.key === undefined) {
      // An inert row: never highlight, and let the host's own dispatch continue.
      return state.hovered === undefined ? undefined : clearHover();
    }
    if (state.hovered === hit.key) return { handled: true };
    state.hovered = hit.key;
    claimSectionHover(() => {
      clearHover();
    });
    requestSurfaceRepaint({
      cause: `section ${JSON.stringify(hit.sectionId)} ${hit.kind} hover`,
      surfaces: ["rail"],
    });
    return { handled: true, render: true };
  }

  if (pointer.type === "click") {
    if (pointer.button !== "left") return undefined;
    if (hit.activate === undefined) return undefined;
    // One click, one action (N12): the pointer stops hovering and the row's own work runs once. The
    // drop is silent — the action below asks for the frame, so a click costs one request, not two.
    dropHover();
    runActivate(hit);
    return { handled: true, render: true };
  }

  return undefined;
}

function runActivate(hit: SectionRowHit): void {
  const activate = hit.activate;
  if (activate === undefined) return;
  try {
    activate();
  } catch (error) {
    // A plugin's `onClick` that throws must not escape into the host's pointer dispatch.
    recordFailure(hit.sectionId, "onClick", error);
  }
}

/** Drop the hover state and release the shared pointer, without asking for a frame. */
function dropHover(): void {
  sectionRenderState().hovered = undefined;
  releaseSectionHover();
}

/** Drop the hover and repaint — the path the host's own "pointer left" calls. */
function clearHover(): RailMouseResult {
  const state = sectionRenderState();
  const wasHovered = state.hovered !== undefined;
  dropHover();
  if (wasHovered) requestSurfaceRepaint({ cause: "section hover cleared", surfaces: ["rail"] });
  return { handled: true, render: true };
}

/** Fold or unfold one section (N13): persist first, then ask for the frame in the same call. */
function toggleSectionCollapsed(section: SidebarSection): void {
  const collapsed = isSectionCollapsed(getSectionCollapsed(), section);
  setSectionCollapsed(section.id, !collapsed);
  requestSurfaceRepaint({
    cause: `section ${JSON.stringify(section.id)} → ${collapsed ? "expanded" : "collapsed"}`,
    surfaces: ["rail"],
  });
}

/**
 * The one contributor the backend holds. Idempotent by construction: it stores one function in the
 * backend's state, so a second arm or a second package copy never doubles a card.
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

function readBody(section: SidebarSection, ctx: SectionContext): AcceptedRow[] {
  let value: unknown;
  try {
    value = section.lines(ctx);
  } catch (error) {
    recordFailure(section.id, "lines", error);
    return [];
  }
  // A non-array, a hole or a malformed row is a failure, never coerced: a coerced row would show
  // garbage as if the plugin had meant it. The row rules live in one place (`./section-panel.ts`).
  const checked = checkSectionRows(value);
  if (!checked.ok) {
    recordFailure(section.id, "lines", new Error(checked.message));
    return [];
  }
  return capBody(checked.rows);
}

/** Keep the body inside the row budget, marking the elision visibly. */
function capBody(rows: readonly AcceptedRow[]): AcceptedRow[] {
  if (rows.length <= MAX_SECTION_BODY_ROWS) return [...rows];
  const kept = rows.slice(0, MAX_SECTION_BODY_ROWS - 1);
  // The marker occupies one of the budgeted rows and says how many are not shown. It is a plain
  // string, so it is drawn exactly as the author's own plain rows are.
  return [...kept, ELISION(rows.length - kept.length)];
}

/** The pointer fields of a mouse event, when it has the shape the host dispatches. */
function readPointer(event: unknown): { type: string; button?: string; y: number } | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const candidate = event as { type?: unknown; button?: unknown; y?: unknown };
  if (typeof candidate.type !== "string") return undefined;
  if (typeof candidate.y !== "number" || !Number.isFinite(candidate.y)) return undefined;
  return {
    type: candidate.type,
    ...(typeof candidate.button === "string" ? { button: candidate.button } : {}),
    y: candidate.y,
  };
}

/**
 * Clamp one plain row to the width the host passes, with a visible marker instead of a silent cut.
 *
 * Measured in UTF-16 code units (`.length`), NOT terminal columns: an emoji or a wide CJK glyph
 * therefore costs what a plain character costs here, and a plugin that emits ANSI styling owns its
 * own width — the bridge neither parses escape sequences nor strips them (the same caveat as a
 * customize row's `label`). A STRUCTURED row is drawn by the panel builder instead, which measures
 * columns (`./section-panel.ts`).
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
