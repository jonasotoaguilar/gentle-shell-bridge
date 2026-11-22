/**
 * The row build shared by both backends (S3 capture, S4 hook), so `registerRows` behaves
 * identically whichever interception is active.
 *
 * The builder is pure with respect to the bus: it takes an ordered provider snapshot, calls each
 * provider's `rows(ctx)` once, and isolates failures. It caches nothing — the bridge never holds
 * row values (docs/state.md).
 */

import {
  resolveRowPlacements,
  snapshotProviders,
  type RowPlacementResolution,
} from "./bus.ts";
import { getConfigHome } from "./config.ts";
import { recordNotice } from "./notices.ts";
import { clearRowNameRejections, rejectReservedCategory, rejectRowName } from "./row-names.ts";
import type { CustomizeRow, InlineHelpers, RowContext, RowProvider } from "./types.ts";

/** A provider that threw while its rows were built; all of that provider's rows were dropped. */
export interface RowBuildFailure {
  providerId: string;
  message: string;
  rowsDropped: true;
}

export interface RowBuildResult {
  rows: CustomizeRow[];
  failures: RowBuildFailure[];
  /** The providers this build fanned out to, in the same snapshot order. */
  providers: RowProvider[];
  /**
   * One record per provider that did not throw, in snapshot order. Each `rows` array is that
   * provider's staged block; capture and hook place these instead of re-deriving the fan-out.
   */
  blocks: RowBuildRecord[];
}

/** One provider's contribution to the most recent fan-out, kept for duplicate diagnostics. */
export interface RowBuildRecord {
  providerId: string;
  category: string;
  rows: CustomizeRow[];
}

const ROWS_STATE = Symbol.for("gentle-shell-bridge.rows.state.v1");

/** The host's category for a row that names none (`lib/visual-customize-view.ts:387`). */
const HOST_DEFAULT_CATEGORY = "Settings";

interface RowsState {
  /** Rows produced by the last menu build, per provider; `undefined` before any build. */
  lastBuild?: RowBuildRecord[];
}

function rowsHost(): Record<symbol, unknown> {
  // SAFETY: `globalThis` accepts symbol keys and only `rowsState()` writes this slot; a foreign
  // value is rejected there before use.
  return globalThis as unknown as Record<symbol, unknown>;
}

function rowsState(): RowsState {
  const host = rowsHost();
  const existing = host[ROWS_STATE];
  if (isRowsState(existing)) return existing;
  const created: RowsState = {};
  host[ROWS_STATE] = created;
  return created;
}

function isRowsState(value: unknown): value is RowsState {
  return isRecord(value) && (value.lastBuild === undefined || Array.isArray(value.lastBuild));
}

/** The rows the last menu build actually received, or `undefined` when there has been no build. */
export function getLastRowBuild(): RowBuildRecord[] | undefined {
  const last = rowsState().lastBuild;
  return last === undefined ? undefined : last.map((record) => ({ ...record, rows: [...record.rows] }));
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetRowBuildStateForTests(): void {
  delete rowsState().lastBuild;
}

/**
 * Context for the capture backend, where the theme arrives as the host factory's second argument
 * and the config home is resolved from the process (`./config.ts`).
 */
export function createRowContext(theme: unknown): RowContext {
  return { theme, configHome: getConfigHome() };
}

/**
 * Context for the hook backend, where an unproven host registry may pass its own context. A
 * usable `theme` and a string `configHome` are reused as given; anything missing is derived
 * locally, so a provider always receives both fields.
 */
export function contextFromHost(value: unknown): RowContext {
  if (!isRecord(value)) return createRowContext(undefined);
  return {
    theme: "theme" in value ? value.theme : undefined,
    configHome: typeof value.configHome === "string" ? value.configHome : getConfigHome(),
  };
}

/**
 * The row's visible text, when it can be read without running a plugin's throw into the build.
 * A label function is evaluated exactly as the host would evaluate it when it renders, so a name
 * cannot pass the build and break the menu; a throw leaves the row unvalidated (the host's own
 * failure behaviour, unchanged).
 */
function rowLabelText(row: CustomizeRow): string | undefined {
  const label = row.label;
  if (label === undefined) return undefined;
  if (typeof label === "string") return label;
  try {
    const shown: unknown = label();
    return typeof shown === "string" ? shown : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Apply the row-name shape to one provider row (N7, N8): its line name (`choice.setting`) and its
 * visible label. Returns `false` when the row must not reach the host — the caller drops it, so the
 * rejected name exists nowhere instead of being sanitized into something the author never wrote.
 */
function acceptsRowName(providerId: string, row: CustomizeRow): boolean {
  const setting = row.choice?.setting;
  if (setting !== undefined && rejectRowName("rows", providerId, "line name", setting)) {
    return false;
  }
  const label = rowLabelText(row);
  if (label !== undefined && rejectRowName("rows", providerId, "row label", label)) {
    return false;
  }
  return true;
}

/**
 * Contain a BUTTON row's `action` (S16): a row with `action` and no `choice` is the host's own
 * `Reset`/`Profiles` shape, and the host runs it on Enter/Space. This host catches a throw and
 * reports it (`lib/visual-customize-view.ts:224-234`), but a host that does not — or an action that
 * only returns a rejected promise nobody awaits — would put a plugin's failure in Pi's render loop.
 * So the bridge catches it, reports it ONCE through the notice channel `/bridge-status` lists
 * (`./notices.ts` records an identical message+level once, so pressing the row again does not
 * repeat it) and returns normally: the menu and every other row stay usable.
 *
 * The row is a shallow COPY — the provider's object is never mutated — and every other field is the
 * same reference. A toggle row (one with a `choice`) is returned untouched: its action's failure
 * behaviour is the host's and is not part of this rule.
 */
function containButtonAction(providerId: string, row: CustomizeRow): CustomizeRow {
  const action = row.action;
  if (row.choice !== undefined || typeof action !== "function") return row;
  const name = rowLabelText(row);
  const where = name === undefined ? "a button row" : `the button row ${JSON.stringify(name)}`;
  return {
    ...row,
    action: async (inline: InlineHelpers): Promise<void> => {
      try {
        await action(inline);
      } catch (error) {
        recordNotice(
          `gentle-shell-bridge: ${where} from ${JSON.stringify(providerId)} failed: ` +
            `${errorMessage(error)}. The menu stays open; fix the row's action.`,
          "error",
        );
      }
    },
  };
}

/**
 * Apply the bridge's ONE behaviour to a row that carries a choice (A1–A3): ←/→ moves the cursor,
 * Enter applies. The host decides per row (`lib/visual-customize-view.ts:565` applies on the move only
 * while `choice.applyOnMove !== false`), so a provider row that omits the field — every row before
 * this rule — would change its value the moment the user steps onto it, with no `›` cursor and no
 * "Enter applies". The bridge owns the menu integration, so it normalises rather than trusting the
 * author: one behaviour for every row it contributes, including a provider's explicit `true`.
 *
 * The provider's row and `choice` are never mutated: the change is a shallow copy, every other field
 * is the same reference, and a row that already conforms keeps its identity (the provider's object is
 * what the host receives).
 */
function confirmOnEnter(row: CustomizeRow): CustomizeRow {
  const choice = row.choice;
  if (choice === undefined || choice.applyOnMove === false) return row;
  return { ...row, choice: { ...choice, applyOnMove: false } };
}

/**
 * Fan out to the providers in subscription order, isolating failures: a provider that throws
 * while building its rows loses exactly those rows, and every other provider still applies.
 *
 * Rows from one provider are staged first, so a mid-build throw drops all of them rather than
 * half. A row without a category is shallow-cloned with its provider's category; a row the
 * provider returned is never mutated.
 *
 * A row whose line name or label breaks the row-name shape is dropped as it is staged (N8): it is
 * absent from the array the host receives AND from the build record `/bridge-status` reads, so it is
 * not part of the effective set. The rejection is recorded verbatim for the report; the bridge never
 * rewrites a name it was given.
 *
 * A row that asks for a RESERVED category is dropped the same way (S15): `Keymaps` is the host's own
 * interaction, so the row is refused and reported while its siblings still reach the menu. A
 * provider whose OWN category is reserved loses every row — including one registered by a copy of
 * this package older than the registration check (`./bus.ts`), so one rule holds however the bus was
 * filled.
 *
 * Every row that carries a `choice` is staged with `applyOnMove: false` (A2), on a copy of the row
 * and of its `choice` — see `confirmOnEnter`. A BUTTON row (S16) keeps no choice and gains none; its
 * `action` is contained by `containButtonAction`.
 */
export function buildRows(ctx: RowContext): RowBuildResult {
  const providers = snapshotProviders();
  const rows: CustomizeRow[] = [];
  const failures: RowBuildFailure[] = [];
  const buildRecords: RowBuildRecord[] = [];

  for (const provider of providers) {
    const staged: CustomizeRow[] = [];
    // This build is the new evidence for this provider, so a rejection a previous build recorded
    // does not outlive the name it described.
    clearRowNameRejections("rows", provider.id);
    try {
      // A provider standing in the reserved page loses all of its rows: the refusal is about the
      // page, not about one row of it.
      if (!rejectReservedCategory(provider.id, provider.category)) {
        for (const row of provider.rows(ctx)) {
          if (!acceptsRowName(provider.id, row)) continue;
          const withCategory =
            row.category === undefined ? { ...row, category: provider.category } : row;
          if (rejectReservedCategory(provider.id, withCategory.category)) continue;
          staged.push(containButtonAction(provider.id, confirmOnEnter(withCategory)));
        }
      }
    } catch (error) {
      failures.push({
        providerId: provider.id,
        message: errorMessage(error),
        rowsDropped: true,
      });
      continue;
    }
    buildRecords.push({ providerId: provider.id, category: provider.category, rows: staged });
    rows.push(...staged);
  }

  rowsState().lastBuild = buildRecords;
  return { rows, failures, providers, blocks: buildRecords };
}

/** Where one build's provider blocks go, and the array that results from placing them. */
export interface RowPlacementPlan {
  /** Every provider row the plan inserts, in the order it holds in `planned`. */
  rows: CustomizeRow[];
  /** The complete array: the host rows by identity, with each provider's block at its slot. */
  planned: CustomizeRow[];
  /** The host's own categories in first-appearance order, for `/bridge-status`. */
  hostCategories: string[];
}

/**
 * Place a build's provider blocks into the host array (S4, S5).
 *
 * `resolveRowPlacements` is the ONLY source of the draw order: this function turns its per-category
 * blocks into insertion points, never re-sorting them. The host array is read, never mutated here:
 * the caller applies `planned` in one in-place write, so no index can drift between splices.
 *
 * - a category is a contiguous region; the rows of a category may repeat, so its first and last
 *   index are the block's boundaries;
 * - `start` inserts before the category's first host row; `after X` follows X's block, including
 *   when X is itself at `start`; `end` follows the category's own rows;
 * - a category the host did not build has no boundary, so its blocks are appended after every host
 *   row, and the page appears after the host's pages (`new Set(...)` sees it);
 * - when NO provider names a `placement` or an `order`, every block is appended after the host
 *   array in its registration order — exactly where it landed before this feature (S6). Host rows
 *   are never split: an insertion point is a block boundary, so a consecutive `choice.setting`
 *   pair stays consecutive.
 */
export function planRowPlacement(
  host: readonly CustomizeRow[],
  providers: readonly RowProvider[],
  blocks: readonly RowBuildRecord[],
): RowPlacementPlan {
  const spans = new Map<string, { first: number; last: number }>();
  const hostCategories: string[] = [];
  for (let index = 0; index < host.length; index++) {
    const row = host[index];
    const category = row.category ?? HOST_DEFAULT_CATEGORY;
    const span = spans.get(category);
    if (span === undefined) {
      spans.set(category, { first: index, last: index });
      hostCategories.push(category);
    } else {
      span.last = index;
    }
  }

  const blockOf = new Map(blocks.map((block) => [block.providerId, block]));
  const resolutions = resolveRowPlacements(providers, hostCategories);
  const byCategory = new Map<string, RowPlacementResolution[]>();
  for (const resolution of resolutions) {
    const list = byCategory.get(resolution.category);
    if (list === undefined) byCategory.set(resolution.category, [resolution]);
    else list.push(resolution);
  }

  // Split one category's resolver output into the start side and the end side. The resolver emits
  // every block that hangs off `start` before every block that hangs off `end`, so the first
  // direct `end` anchor is the boundary; a follower keeps the side of its anchor.
  const startByCategory = new Map<string, CustomizeRow[]>();
  const endByCategory = new Map<string, CustomizeRow[]>();
  for (const [category, list] of byCategory) {
    let side: "start" | "end" = "start";
    const startRows: CustomizeRow[] = [];
    const endRows: CustomizeRow[] = [];
    for (const resolution of list) {
      if (resolution.anchor === "end") side = "end";
      const block = blockOf.get(resolution.provider.id);
      if (block === undefined || block.rows.length === 0) continue;
      if (side === "start") startRows.push(...block.rows);
      else endRows.push(...block.rows);
    }
    if (startRows.length > 0) startByCategory.set(category, startRows);
    if (endRows.length > 0) endByCategory.set(category, endRows);
  }

  const placedMode = providers.some(
    (provider) => provider.placement !== undefined || provider.order !== undefined,
  );

  if (!placedMode) {
    // S6: no placement and no order means today's behaviour, verbatim. The resolver still decides
    // the order INSIDE one category (S2); categories keep the order they were registered in.
    const inserted: CustomizeRow[] = [];
    const seen = new Set<string>();
    for (const block of blocks) {
      if (seen.has(block.category)) continue;
      seen.add(block.category);
      inserted.push(...(endByCategory.get(block.category) ?? []));
    }
    for (const category of startByCategory.keys()) {
      if (!seen.has(category)) {
        seen.add(category);
        inserted.push(...(startByCategory.get(category) ?? []));
      }
    }
    return { rows: inserted, planned: [...host, ...inserted], hostCategories };
  }

  const before = new Map<number, CustomizeRow[]>();
  const after = new Map<number, CustomizeRow[]>();
  const append: CustomizeRow[] = [];
  for (const [category, rows] of startByCategory) {
    const span = spans.get(category);
    if (span === undefined) {
      append.push(...rows);
      continue;
    }
    const existing = before.get(span.first) ?? [];
    before.set(span.first, [...existing, ...rows]);
  }
  for (const [category, rows] of endByCategory) {
    const span = spans.get(category);
    if (span === undefined) {
      append.push(...rows);
      continue;
    }
    const existing = after.get(span.last) ?? [];
    after.set(span.last, [...existing, ...rows]);
  }

  const planned: CustomizeRow[] = [];
  const inserted: CustomizeRow[] = [];
  for (let index = 0; index < host.length; index++) {
    const beforeRows = before.get(index);
    if (beforeRows !== undefined) {
      planned.push(...beforeRows);
      inserted.push(...beforeRows);
    }
    planned.push(host[index]);
    const afterRows = after.get(index);
    if (afterRows !== undefined) {
      planned.push(...afterRows);
      inserted.push(...afterRows);
    }
  }
  if (append.length > 0) {
    planned.push(...append);
    inserted.push(...append);
  }
  return { rows: inserted, planned, hostCategories };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
