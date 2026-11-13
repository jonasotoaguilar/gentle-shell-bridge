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

import { snapshotProviders, snapshotSections } from "./bus.ts";
import { getCaptureDiagnostics, type CaptureOutcome } from "./capture.ts";
import { getHookDiagnostics } from "./hook.ts";
import { getLastRowBuild, type RowBuildRecord } from "./rows.ts";
import {
  getSidebarDiagnostics,
  type SidebarDiagnostics,
  type SidebarFailure,
} from "./sidebar.ts";
import { getSectionFailures, type SectionRenderFailure } from "./sidebar-render.ts";
import { SECTION_ROWS_PROVIDER_ID } from "./sections-rows.ts";
import { getStoreDiagnostics, type StoreProblem } from "./store.ts";
import type { CustomizeRow, RowContext, RowProvider } from "./types.ts";
import { getSectionVisibility, isSectionVisible } from "./visibility.ts";

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

/** One registered sidebar section, as `/bridge-status` lists it. */
export interface StatusSectionEntry {
  id: string;
  title: string;
  /** The persisted (or default) visibility right now. */
  visible: boolean;
  /** The render position's source: an explicit integer, or registration order when absent. */
  order: number | "registration";
}

/** Where the sidebar interception stands, so a missing section has an answer. */
export type StatusSidebarState = "intercepted" | "no-sidebar-state" | "unarmed";

export interface StatusSidebarEntry {
  state: StatusSidebarState;
  /** Only for `no-sidebar-state`: why nothing could be intercepted. */
  reason?: string;
  /** Only when intercepted: whether the part we append to is in the host's map already. */
  rail?: "wrapped" | "pending";
}

export interface StatusSnapshot {
  providers: StatusProviderEntry[];
  backend: StatusBackend;
  lastCapture?: CaptureOutcome;
  failures: StatusFailure[];
  storeProblems: StoreProblem[];
  /** Absent until a menu build has happened: duplicates cannot be computed without rows. */
  duplicates?: StatusDuplicate[];
  /** Absent when no section is registered, so a row-only run keeps its historical output. */
  sections?: StatusSectionEntry[];
  /** Absent when the most recent sidebar frame had no section failure. */
  sectionFailures?: SectionRenderFailure[];
  /**
   * Failures the RAIL BACKEND recorded in the most recent frame (a throwing host `render`, a
   * throwing contributor, a failed card-group call). Absent when there were none.
   */
  sidebarFailures?: SidebarFailure[];
  /** Absent when the sidebar backend was never installed (reported as "not armed"). */
  sidebar?: StatusSidebarEntry;
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

  // Diagnostics never run providers: duplicate detection comes from the rows the LAST menu build
  // actually received, and is unknown until such a build exists.
  const snapshot: StatusSnapshot = {
    // The bridge's own `Sections` provider is plumbing, not a plugin provider: its effect is the
    // sections table below, and listing it would make a row-only session report a provider it never
    // registered (B3).
    providers: providers
      .filter((provider) => provider.id !== SECTION_ROWS_PROVIDER_ID)
      .map((provider) => ({ id: provider.id, category: provider.category })),
    backend,
    // Report the failures and the capture outcome of the backend that is actually in use.
    failures:
      backend === "hook"
        ? hook.lastFailures.map(toStatusFailure)
        : capture.lastFailures.map(toStatusFailure),
    storeProblems: getStoreDiagnostics(),
  };
  const duplicates = findDuplicatesInBuilds(getLastRowBuild());
  if (duplicates !== undefined) snapshot.duplicates = duplicates;
  const lastCapture = backend === "hook" ? hook.lastCapture : capture.lastOutcome;
  if (lastCapture !== undefined) snapshot.lastCapture = lastCapture;

  // The sidebar surface. Nothing here runs a section: the table reports registrations and the
  // persisted visibility, and the failures are the ones the last frame already recorded — `lines()`
  // and `meta()` are never called by a diagnostics report.
  const sections = snapshotSections();
  if (sections.length > 0) {
    const visibility = getSectionVisibility();
    snapshot.sections = sections.map((section) => ({
      id: section.id,
      title: section.title,
      visible: isSectionVisible(visibility, section),
      order:
        typeof section.order === "number" && Number.isFinite(section.order)
          ? section.order
          : "registration",
    }));
  }
  const sectionFailures = getSectionFailures();
  if (sectionFailures.length > 0) snapshot.sectionFailures = sectionFailures;
  const sidebarDiagnostics = getSidebarDiagnostics();
  if (sidebarDiagnostics.lastFailures.length > 0) {
    // The rail backend's own failures are a separate class: a throwing host render, a throwing
    // contributor. Without them, a frame that lost every section would report nothing (B1).
    snapshot.sidebarFailures = sidebarDiagnostics.lastFailures;
  }
  const sidebarEntry = describeSidebar(sidebarDiagnostics);
  // The sidebar line is worth a line only when it explains something: a registered section that may
  // not be appearing, or a rail that IS intercepted. A row-only session with no rail keeps the
  // pre-feature output exactly (B3).
  if (
    sidebarEntry !== undefined &&
    (snapshot.sections !== undefined || sidebarEntry.state === "intercepted")
  ) {
    snapshot.sidebar = sidebarEntry;
  }

  return snapshot;
}

/**
 * Map the backend's diagnostics onto the three states a user needs: intercepted, present-but-nothing
 * to intercept, or previously installed and now off. Never-installed is `undefined` ("not armed").
 */
function describeSidebar(diagnostics: SidebarDiagnostics): StatusSidebarEntry | undefined {
  if (diagnostics.interceptedMaps > 0) {
    return {
      state: "intercepted",
      rail: diagnostics.wrappedRails > 0 ? "wrapped" : "pending",
    };
  }
  if (
    diagnostics.lastOutcome === "no-sidebar-state" ||
    diagnostics.lastOutcome === "resolver-threw"
  ) {
    return {
      state: "no-sidebar-state",
      ...(diagnostics.lastReason === undefined ? {} : { reason: diagnostics.lastReason }),
    };
  }
  if (diagnostics.lastOutcome === "no-widget-surface") {
    return {
      state: "unarmed",
      ...(diagnostics.lastReason === undefined ? {} : { reason: diagnostics.lastReason }),
    };
  }
  if (diagnostics.lastOutcome !== undefined) return { state: "unarmed" };
  return undefined;
}

/**
 * Report every `category` + `choice.setting` pair contributed by more than one provider id.
 *
 * A single provider's own consecutive toggle rows share a setting by design, so they are not a
 * duplicate: only a second provider id makes the pair conflict. Rows are read, never rewritten. A
 * provider that throws is skipped — its failure is already its own diagnostics entry.
 */
export function findDuplicateSettings(providers: RowProvider[], ctx: RowContext): StatusDuplicate[] {
  const builds: RowBuildRecord[] = [];
  for (const provider of providers) {
    try {
      builds.push({ providerId: provider.id, category: provider.category, rows: provider.rows(ctx) });
    } catch {
      continue;
    }
  }
  return findDuplicatesInBuilds(builds) ?? [];
}

/**
 * The same grouping over rows a build already produced, with no provider invocation. `undefined`
 * means no build has happened yet, which is reported as unknown rather than as "no duplicates".
 */
export function findDuplicatesInBuilds(
  builds: RowBuildRecord[] | undefined,
): StatusDuplicate[] | undefined {
  if (builds === undefined) return undefined;

  const groups = new Map<string, StatusDuplicate>();
  const order: string[] = [];

  for (const build of builds) {
    for (const row of build.rows) {
      const setting = row.choice?.setting;
      if (setting === undefined) continue;
      const category = row.category ?? build.category;
      const key = `${category}\u0000${setting}`;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, { category, setting, providerIds: [build.providerId] });
        order.push(key);
        continue;
      }
      if (!existing.providerIds.includes(build.providerId)) {
        existing.providerIds.push(build.providerId);
      }
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

  if (snapshot.duplicates === undefined) {
    lines.push("duplicate settings: no build yet");
  } else if (snapshot.duplicates.length === 0) {
    lines.push("duplicate settings: none");
  } else {
    lines.push(`duplicate settings: ${snapshot.duplicates.length}`);
    for (const duplicate of snapshot.duplicates) {
      lines.push(
        `  - ${duplicate.category} / "${duplicate.setting}": ${duplicate.providerIds.join(", ")}`,
      );
    }
  }

  // These blocks are emitted only when they have something to say. What is guaranteed: a session
  // that registers no section and never intercepts a rail prints exactly the pre-feature output
  // (proved through the real entry, not just this formatter). The sections table appears once a
  // section is registered; the sidebar line appears when a section is registered — so an
  // unreachable rail is an answer — or when a rail is actually intercepted.
  if (snapshot.sections !== undefined) {
    lines.push(`sections: ${snapshot.sections.length}`);
    for (const section of snapshot.sections) {
      const order =
        section.order === "registration" ? "registration order" : `order ${section.order}`;
      const visibility = section.visible ? "visible" : "hidden";
      lines.push(`  - ${section.id} "${section.title}": ${visibility}, ${order}`);
    }
  }

  if (snapshot.sectionFailures !== undefined) {
    lines.push(`section failures: ${snapshot.sectionFailures.length}`);
    for (const failure of snapshot.sectionFailures) {
      lines.push(`  - ${failure.sectionId} (${failure.phase}): ${failure.message}`);
    }
  }

  if (snapshot.sidebarFailures !== undefined) {
    lines.push(`sidebar failures: ${snapshot.sidebarFailures.length}`);
    for (const failure of snapshot.sidebarFailures) {
      lines.push(`  - ${failure.key} (${failure.phase}): ${failure.message}`);
    }
  }

  if (snapshot.sidebar === undefined) {
    if (snapshot.sections !== undefined) lines.push("sidebar: not armed");
  } else if (snapshot.sidebar.state === "intercepted") {
    lines.push(`sidebar: intercepted (rail ${snapshot.sidebar.rail})`);
  } else if (snapshot.sidebar.state === "no-sidebar-state") {
    const reason = snapshot.sidebar.reason === undefined ? "" : ` (${snapshot.sidebar.reason})`;
    lines.push(`sidebar: no-sidebar-state${reason}`);
  } else {
    const reason = snapshot.sidebar.reason === undefined ? "" : ` (${snapshot.sidebar.reason})`;
    lines.push(`sidebar: not armed${reason}`);
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
