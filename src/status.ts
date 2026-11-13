/**
 * `status` diagnostics (S6). One command answers "why did no rows appear": providers, backend,
 * last capture, last failures, store problems and conflicting settings.
 *
 * `collectStatus` gathers live process state (bus, capture/hook/store diagnostics) and
 * `formatStatus` is a pure function over that snapshot, so the report is testable without a host
 * and the command prints exactly what the snapshot says. Nothing here mutates bridge state, and
 * nothing here renames or drops a row: a duplicate `category` + `setting` pair is reported, not
 * fixed (docs/contract.md §6).
 */

import { snapshotProviders } from "./bus.ts";
import { getCaptureDiagnostics, type CaptureOutcome } from "./capture.ts";
import { getHookDiagnostics } from "./hook.ts";
import { createRowContext } from "./rows.ts";
import { getStoreDiagnostics, type StoreProblem } from "./store.ts";
import type { CustomizeRow, RowContext, RowProvider } from "./types.ts";

export type StatusBackend = "hook" | "capture" | "none";

export interface StatusProviderEntry {
  id: string;
  category: string;
}

/** Two providers contribute the same `category` + `choice.setting`. */
export interface StatusDuplicate {
  category: string;
  setting: string;
  providerIds: string[];
}

export interface StatusFailure {
  providerId: string;
  message: string;
  rowsDropped: boolean;
}

export interface StatusSnapshot {
  providers: StatusProviderEntry[];
  backend: StatusBackend;
  lastCapture?: CaptureOutcome;
  failures: StatusFailure[];
  storeProblems: StoreProblem[];
  duplicates: StatusDuplicate[];
}

/**
 * One snapshot of everything `status` reports. The backend is derived from real state rather than
 * remembered: a hook registry in use wins, otherwise a wrapped UI target means the capture
 * backend.
 */
export function collectStatus(): StatusSnapshot {
  const providers = snapshotProviders();
  const hook = getHookDiagnostics();
  const capture = getCaptureDiagnostics();
  const backend: StatusBackend =
    hook.installed ? "hook" : capture.armedTargets > 0 ? "capture" : "none";

  const snapshot: StatusSnapshot = {
    providers: providers.map((provider) => ({ id: provider.id, category: provider.category })),
    backend,
    // Report the failures of the backend that is actually in use.
    failures:
      backend === "hook"
        ? hook.lastFailures.map(toStatusFailure)
        : capture.lastFailures.map(toStatusFailure),
    storeProblems: getStoreDiagnostics(),
    duplicates: findDuplicateSettings(providers, createRowContext(undefined)),
  };
  if (capture.lastOutcome !== undefined) snapshot.lastCapture = capture.lastOutcome;
  return snapshot;
}

/**
 * Report every `category` + `choice.setting` pair contributed by more than one provider id.
 *
 * A single provider's own consecutive toggle rows share a setting by design, so they are not a
 * duplicate: only a second provider id makes the pair conflict. Rows are read, never rewritten. A
 * provider that throws is skipped — its failure is already its own diagnostics entry.
 */
export function findDuplicateSettings(providers: RowProvider[], ctx: RowContext): StatusDuplicate[] {
  const groups = new Map<string, StatusDuplicate>();
  const order: string[] = [];

  for (const provider of providers) {
    let rows: CustomizeRow[];
    try {
      rows = provider.rows(ctx);
    } catch {
      continue;
    }
    for (const row of rows) {
      const setting = row.choice?.setting;
      if (setting === undefined) continue;
      const category = row.category ?? provider.category;
      const key = `${category}\u0000${setting}`;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, { category, setting, providerIds: [provider.id] });
        order.push(key);
        continue;
      }
      if (!existing.providerIds.includes(provider.id)) existing.providerIds.push(provider.id);
    }
  }

  const duplicates: StatusDuplicate[] = [];
  for (const key of order) {
    const group = groups.get(key);
    if (group !== undefined && group.providerIds.length >= 2) duplicates.push(group);
  }
  return duplicates;
}

/** The report, as lines, exactly as the `status` command prints it. */
export function formatStatus(snapshot: StatusSnapshot): string[] {
  const lines: string[] = ["gentle-shell-bridge status"];

  if (snapshot.providers.length === 0) {
    lines.push("providers: none");
  } else {
    lines.push(`providers: ${snapshot.providers.length}`);
    for (const provider of snapshot.providers) {
      lines.push(`  - ${provider.id} (${provider.category})`);
    }
  }

  lines.push(`backend: ${snapshot.backend}`);
  lines.push(formatCapture(snapshot.lastCapture));

  if (snapshot.failures.length === 0) {
    lines.push("last failures: none");
  } else {
    lines.push(`last failures: ${snapshot.failures.length}`);
    for (const failure of snapshot.failures) {
      const outcome = failure.rowsDropped ? "rows dropped" : "rows kept";
      lines.push(`  - ${failure.providerId}: ${failure.message} (${outcome})`);
    }
  }

  if (snapshot.storeProblems.length === 0) {
    lines.push("store problems: none");
  } else {
    lines.push(`store problems: ${snapshot.storeProblems.length}`);
    for (const problem of snapshot.storeProblems) {
      lines.push(
        `  - ${problem.pluginId} (${problem.path}): ${problem.kind}: ${problem.message} ` +
          "(reads fall back to defaults; the file is left as is)",
      );
    }
  }

  if (snapshot.duplicates.length === 0) {
    lines.push("duplicate settings: none");
  } else {
    lines.push(`duplicate settings: ${snapshot.duplicates.length}`);
    for (const duplicate of snapshot.duplicates) {
      lines.push(
        `  - ${duplicate.category} / "${duplicate.setting}": ${duplicate.providerIds.join(", ")}`,
      );
    }
  }

  return lines;
}

function formatCapture(outcome: CaptureOutcome | undefined): string {
  if (outcome === undefined) return "last capture: none";
  const rows = outcome.injectedRows === 1 ? "1 row" : `${outcome.injectedRows} rows`;
  switch (outcome.kind) {
    case "injected":
      return `last capture: injected ${rows}`;
    case "already-injected":
      return "last capture: already injected";
    case "uncaptured":
      return outcome.reason === undefined
        ? "last capture: uncaptured"
        : `last capture: uncaptured (${outcome.reason})`;
  }
}

function toStatusFailure(failure: {
  providerId: string;
  message: string;
  rowsDropped: boolean;
}): StatusFailure {
  return {
    providerId: failure.providerId,
    message: failure.message,
    rowsDropped: failure.rowsDropped,
  };
}
