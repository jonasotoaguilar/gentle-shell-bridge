/**
 * The row build shared by both backends (S3 capture, S4 hook), so `registerRows` behaves
 * identically whichever interception is active.
 *
 * The builder is pure with respect to the bus: it takes an ordered provider snapshot, calls each
 * provider's `rows(ctx)` once, and isolates failures. It caches nothing — the bridge never holds
 * row values (docs/state.md).
 */

import { snapshotProviders } from "./bus.ts";
import { getConfigHome } from "./config.ts";
import type { CustomizeRow, RowContext } from "./types.ts";

/** A provider that threw while its rows were built; all of that provider's rows were dropped. */
export interface RowBuildFailure {
  providerId: string;
  message: string;
  rowsDropped: true;
}

export interface RowBuildResult {
  rows: CustomizeRow[];
  failures: RowBuildFailure[];
}

/** One provider's contribution to the most recent fan-out, kept for duplicate diagnostics. */
export interface RowBuildRecord {
  providerId: string;
  category: string;
  rows: CustomizeRow[];
}

const ROWS_STATE = Symbol.for("gentle-shell-bridge.rows.state.v1");

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
 * Fan out to the providers in subscription order, isolating failures: a provider that throws
 * while building its rows loses exactly those rows, and every other provider still applies.
 *
 * Rows from one provider are staged first, so a mid-build throw drops all of them rather than
 * half. A row without a category is shallow-cloned with its provider's category; a row the
 * provider returned is never mutated.
 */
export function buildRows(ctx: RowContext): RowBuildResult {
  const providers = snapshotProviders();
  const rows: CustomizeRow[] = [];
  const failures: RowBuildFailure[] = [];
  const buildRecords: RowBuildRecord[] = [];

  for (const provider of providers) {
    const staged: CustomizeRow[] = [];
    try {
      for (const row of provider.rows(ctx)) {
        staged.push(row.category === undefined ? { ...row, category: provider.category } : row);
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
  return { rows, failures };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
