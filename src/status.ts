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

import { snapshotCardStyles, snapshotProviders, snapshotSections, snapshotTransforms } from "./bus.ts";
import {
  CARD_STYLE_ROWS_PROVIDER_ID,
  cardStyleRowMode,
  type CardStyleRowMode,
} from "./card-style-rows.ts";
import {
  getCardStyleLastOutcome,
  getCardStyleTransformFailures,
  type CardStyleFrameOutcome,
  type CardStyleTransformFailure,
} from "./card-style-transform.ts";
import { getCardStyleWiringDiagnostics, type CardStyleWiringDiagnostics } from "./card-style-wiring.ts";
import { resolveCardStyleSelection } from "./card-styles.ts";
import { getCaptureDiagnostics, type CaptureOutcome } from "./capture.ts";
import { getHookDiagnostics } from "./hook.ts";
import { snapshotNotices, type NoticeLevel } from "./notices.ts";
import {
  PAINT_SURFACES,
  getRepaintDiagnostics,
  getSurfaceReach,
  type PaintSurface,
  type RepaintTrigger,
} from "./repaint.ts";
import { getTransformFrameOutcomes } from "./transform-pipeline.ts";
import { getPluginLineReport, type PluginLineReport } from "./plugin-lines.ts";
import { getLastRowBuild, type RowBuildRecord } from "./rows.ts";
import {
  getSidebarDiagnostics,
  type SidebarDiagnostics,
  type SidebarFailure,
} from "./sidebar.ts";
import { getSectionFailures, type SectionRenderFailure } from "./sidebar-render.ts";
import { SECTION_ROWS_PROVIDER_ID } from "./sections-rows.ts";
import { sectionRowLabels } from "./row-labels.ts";
import { getRowNameRejections, type RowNameRejection } from "./row-names.ts";
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
  /** The label the section's `Sections` row reads (N2). The id stays in `id`, never in a row. */
  rowLabel: string;
  /** Present when two sections wanted the same label: the label this one had to move away from. */
  rowLabelCollision?: string;
}

/** One rejected row name, as `/bridge-status` lists it: the string verbatim and the rule it broke. */
export type StatusRowNameRejection = RowNameRejection;

/** One buffered notice, as `/bridge-status` lists it: still pending, or already delivered. */
export interface StatusNoticeEntry {
  level: NoticeLevel;
  message: string;
  delivered: boolean;
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

/** One registered card style, as `/bridge-status` lists it: in the order its values appear. */
export interface StatusCardStyleEntry {
  id: string;
  label: string;
  /** The value's position source: an explicit integer, or registration order when absent. */
  order: number | "registration";
}

/** The persisted selection, resolved against the live registry. `missing` is a disposed style. */
export type StatusCardStyleSelection =
  | { kind: "native" }
  | { kind: "style"; id: string; label: string }
  | { kind: "missing"; id: string };

/** One surface the card style paints, with what it last did there (R4). */
export interface StatusSurfaceEntry {
  surface: PaintSurface;
  /** Whether the transform was attached to this surface. */
  reached: boolean;
  /** Only when it was not: the attach outcome (`no-layout-root`, `no-sidebar`, `no-rail`, ...). */
  reason?: string;
  /** The last frame this surface painted through the transform; `none` before it ran once. */
  frame: CardStyleFrameOutcome | { kind: "none" };
}

/** The card-style surface, reported only when there is something to say (see `collectStatus`). */
export interface StatusCardStyles {
  /** `extended`: the host's own `Card style` line was found and grown. `separate`: the fallback. */
  mode: CardStyleRowMode;
  styles: StatusCardStyleEntry[];
  selection: StatusCardStyleSelection;
  /** The most recent CONVERSATION frame's outcome; `none` before the transform ever ran. */
  frame: CardStyleFrameOutcome | { kind: "none" };
  /**
   * Per-surface reach and last frame (R4): the conversation and the rail are separate surfaces that
   * share one transform, so "the style is selected but the sidebar looks untouched" is answerable.
   */
  surfaces: StatusSurfaceEntry[];
  wiring: CardStyleWiringDiagnostics;
  failures: CardStyleTransformFailure[];
}

/** One registered transform, as `/bridge-status` lists it: in pipeline order. */
export interface StatusTransformEntry {
  id: string;
  /** The position's source: an explicit integer, or registration order when absent. */
  order: number | "registration";
  /** What the LAST frame did with it; `not run` when no frame has reached it yet. */
  outcome: "applied" | "skipped" | "failed" | "not run";
  /** Only when `outcome` is `failed`: the transform's own message, verbatim. */
  message?: string;
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
  /**
   * The last repaint a bridge-owned write requested (R3/R4): the surfaces, the cause and whether the
   * host was actually asked for a frame. Absent until such a write happens, so a session that never
   * toggled anything keeps its historical output byte for byte.
   */
  lastRepaint?: RepaintTrigger;
  /**
   * Every buffered bridge notice, delivered or still pending. Absent when there is none, so the
   * report for a clean session keeps its historical output exactly.
   */
  notices?: StatusNoticeEntry[];
  /** Messages the bounded buffer evicted before they could be shown. Absent when none were. */
  noticesDropped?: number;
  /**
   * The card-style surface. Absent when nothing card-related exists — no style registered, the
   * selection native, no transform attempt and no frame — so a row-only session keeps its output.
   */
  cardStyles?: StatusCardStyles;
  /**
   * Plugin row names the bridge rejected for breaking the row-name shape (N8): the offending
   * string, verbatim, and the rule it broke. Absent when nothing was rejected, so a clean session
   * keeps its historical output exactly.
   */
  rowNames?: StatusRowNameRejection[];
  /**
   * Every registered transcript transform in pipeline order, with the last frame's outcome. Absent
   * when none is registered, so a session that never used the pipeline keeps its historical output
   * byte for byte.
   */
  transforms?: StatusTransformEntry[];
  /**
   * The INTEGRATIONS rows this bridge paints on the plugins' behalf (I1–I7): one entry per plugin,
   * the name and whether it was derived or explicit, the registrations accepted and rejected, and
   * whether the host's `setStatus` was available at all. Absent when no plugin has registered, so a
   * session without one keeps its historical output byte for byte.
   */
  pluginLines?: PluginLineReport;
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
    // The bridge's own `Sections` and card-style fallback providers are plumbing, not plugin
    // providers: their effect is the tables below, and listing one would make a session report a
    // provider its user never registered (B3).
    providers: providers
      .filter(
        (provider) =>
          provider.id !== SECTION_ROWS_PROVIDER_ID && provider.id !== CARD_STYLE_ROWS_PROVIDER_ID,
      )
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
  // The row-name rejections (N8). Nothing here runs a provider: the records are the ones the last
  // registration or build already made, so the report matches what the menu shows.
  const rowNames = getRowNameRejections();
  if (rowNames.length > 0) snapshot.rowNames = rowNames;
  const lastCapture = backend === "hook" ? hook.lastCapture : capture.lastOutcome;
  if (lastCapture !== undefined) snapshot.lastCapture = lastCapture;

  // The sidebar surface. Nothing here runs a section: the table reports registrations and the
  // persisted visibility, and the failures are the ones the last frame already recorded — `lines()`
  // and `meta()` are never called by a diagnostics report.
  //
  // Ids belong in THIS report (N4): it is read by the plugin author diagnosing a registration, not by
  // the user picking a toggle. The rows the user sees show labels only (`./row-labels.ts`), so these
  // ids exist precisely to be found here. The label column is the same assignment the rows use,
  // including collision disambiguation, so the report explains what the menu shows instead of
  // recomputing it differently.
  const sections = snapshotSections();
  if (sections.length > 0) {
    const visibility = getSectionVisibility();
    snapshot.sections = sectionRowLabels(sections).map(({ section, label, collision }) => ({
      id: section.id,
      title: section.title,
      visible: isSectionVisible(visibility, section),
      order:
        typeof section.order === "number" && Number.isFinite(section.order)
          ? section.order
          : "registration",
      rowLabel: label,
      ...(collision === undefined ? {} : { rowLabelCollision: collision }),
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
  // The notices the bridge had to report out of band (an incompatible API object). They are listed
  // here so removing them from the terminal never made them invisible: after the one-time notify,
  // this is where they stay.
  const notices = snapshotNotices();
  if (notices.entries.length > 0) {
    snapshot.notices = notices.entries.map((entry) => ({
      level: entry.level,
      message: entry.message,
      delivered: entry.emitted,
    }));
    if (notices.dropped > 0) snapshot.noticesDropped = notices.dropped;
  }
  const cardStyles = describeCardStyles();
  if (cardStyles !== undefined) snapshot.cardStyles = cardStyles;
  const lastRepaint = describeLastRepaint();
  if (lastRepaint !== undefined) snapshot.lastRepaint = lastRepaint;
  // The transform pipeline, in the order the wrapper runs it. Nothing here calls a transform: the
  // outcomes are the ones the last frame already recorded.
  const transforms = describeTransforms();
  if (transforms !== undefined) snapshot.transforms = transforms;
  // The per-plugin INTEGRATIONS rows. Nothing here calls the host: the records are the ones each
  // registration (and `session_start`'s paint attempt) already made.
  const pluginLines = describePluginLines();
  if (pluginLines !== undefined) snapshot.pluginLines = pluginLines;
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
 * The card-style block, or `undefined` when the process has nothing card-related to say.
 *
 * The guard is what keeps a row-only session's report byte-identical: no style, a `native`
 * selection, no wiring attempt and no frame means the feature was never used here.
 */
function describeCardStyles(): StatusCardStyles | undefined {
  const styles = snapshotCardStyles();
  const selection = resolveCardStyleSelection();
  const wiring = getCardStyleWiringDiagnostics();
  const frame = getCardStyleLastOutcome();
  const failures = getCardStyleTransformFailures();
  if (styles.length === 0 && selection.kind === "native" && wiring.lastOutcome === undefined && frame === undefined) {
    return undefined;
  }
  return {
    mode: cardStyleRowMode(),
    styles: styles.map((style) => ({
      id: style.id,
      label: style.label,
      order:
        typeof style.order === "number" && Number.isFinite(style.order)
          ? style.order
          : "registration",
    })),
    selection:
      selection.kind === "native"
        ? { kind: "native" }
        : selection.kind === "missing"
          ? { kind: "missing", id: selection.id }
          : { kind: "style", id: selection.style.id, label: selection.style.label },
    frame: frame === undefined ? { kind: "none" } : frame,
    surfaces: PAINT_SURFACES.map((surface) => {
      const reach = getSurfaceReach(surface);
      const outcome = getCardStyleLastOutcome(surface);
      return {
        surface,
        reached: reach?.reached === true,
        ...(reach?.reason === undefined ? {} : { reason: reach.reason }),
        frame: outcome === undefined ? { kind: "none" as const } : outcome,
      };
    }),
    wiring,
    failures,
  };
}

/**
 * The transform block, or `undefined` when this process registered no transform at all.
 *
 * The guard is what keeps a session that never used the pipeline byte-identical: the block appears
 * only when a transform exists, and the outcomes are the ones the last frame recorded (a transform
 * registered after that frame reads `not run` rather than borrowing another one's answer).
 */
function describeTransforms(): StatusTransformEntry[] | undefined {
  const registered = snapshotTransforms();
  if (registered.length === 0) return undefined;
  const frame = new Map(getTransformFrameOutcomes().map((outcome) => [outcome.id, outcome]));
  return registered.map((transform) => {
    const outcome = frame.get(transform.id);
    return {
      id: transform.id,
      order:
        typeof transform.order === "number" && Number.isFinite(transform.order)
          ? transform.order
          : "registration",
      outcome: outcome?.status ?? "not run",
      ...(outcome?.message === undefined ? {} : { message: outcome.message }),
    };
  });
}

/**
 * The INTEGRATIONS block, or `undefined` when no plugin has registered with the bridge.
 *
 * The guard is the same discipline as every other block: a session with no plugin keeps its
 * historical report exactly. The line's TEXT is deliberately not recomputed here — it is what the
 * host was handed — but `line`/`reason` say whether a row is currently set, so a missing row is an
 * answer (I6).
 */
function describePluginLines(): PluginLineReport | undefined {
  const report = getPluginLineReport();
  return report.plugins.length === 0 ? undefined : report;
}

/** The last repaint a bridge-owned write requested (R3/R4), or `undefined` before one happened.
 *
 * The guard is the same discipline as every other block: a session that never toggled anything keeps
 * its historical report exactly. A trigger whose outcome is `unavailable` is the interesting case —
 * the write landed and the screen did not move — so its reason is reported verbatim.
 */
function describeLastRepaint(): RepaintTrigger | undefined {
  return getRepaintDiagnostics().lastTrigger;
}

function formatCardSelection(selection: StatusCardStyleSelection): string {
  switch (selection.kind) {
    case "native":
      return "native";
    case "style":
      return `${selection.id} "${selection.label}"`;
    case "missing":
      return `${selection.id} (missing: not registered)`;
  }
}

function formatCardFrame(frame: StatusCardStyles["frame"]): string {
  switch (frame.kind) {
    case "none":
      return "none";
    case "transformed":
      return `transformed ${frame.cards} ${frame.cards === 1 ? "card" : "cards"}`;
    case "pass-through":
      return `pass-through (${
        frame.reason === "missing" ? "missing: a disposed style" : frame.reason === "no-card" ? "no card" : "native"
      })`;
    case "failed":
      return `failed (${frame.styleId}: ${frame.message})`;
  }
}

function formatCardWiring(wiring: CardStyleWiringDiagnostics): string {
  // Which COMPONENTS carry the transform. The rail is named only once it was wrapped — its failures
  // have their own per-surface line below (`formatCardSurface`), so nothing is hidden by keeping this
  // line about the conversation's state, which is what it has always answered.
  const parts: string[] = [];
  if ((wiring.railWrapped ?? 0) > 0) parts.push("rail wrapped");
  if (wiring.wrapped > 0) parts.push("chat wrapped");
  if (parts.length > 0) return parts.join(", ");
  if (wiring.lastOutcome === undefined) return "not armed";
  const reason = wiring.lastReason === undefined ? "" : `: ${wiring.lastReason}`;
  return `not wrapped (${wiring.lastOutcome}${reason})`;
}

/** One surface's line: whether the style reached it, and what its last frame did there (R4). */
function formatCardSurface(entry: StatusSurfaceEntry): string {
  const reached = entry.reached
    ? `reached (${entry.surface === "conversation" ? "chat wrapped" : "rail wrapped"})`
    : `not reached (${entry.reason ?? "not attempted"})`;
  return `card style surface ${entry.surface}: ${reached}, last frame ${formatCardFrame(entry.frame)}`;
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

  if (snapshot.rowNames !== undefined) {
    lines.push(`row name rejections: ${snapshot.rowNames.length}`);
    for (const rejection of snapshot.rowNames) {
      // The offending string is printed EXACTLY as the author wrote it: the report is how they find
      // it, and the bridge never rewrites a name it refused (N8).
      lines.push(
        `  - ${rejection.surface} ${JSON.stringify(rejection.id)} ${rejection.field} ` +
          `${JSON.stringify(rejection.value)}: ${rejection.reason} (rejected, never rewritten)`,
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
      // The id and the title are diagnostics; `row` is what the menu actually reads, and the
      // collision note says why two equal titles did not produce two equal lines (N2, N4).
      const row =
        section.rowLabelCollision === undefined
          ? `, row "${section.rowLabel}"`
          : `, row "${section.rowLabel}" (label collision with "${section.rowLabelCollision}")`;
      lines.push(`  - ${section.id} "${section.title}": ${visibility}, ${order}${row}`);
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

  if (snapshot.cardStyles !== undefined) {
    const card = snapshot.cardStyles;
    lines.push(`card styles: ${card.mode}, ${card.styles.length} registered`);
    for (const entry of card.styles) {
      const order = entry.order === "registration" ? "registration order" : `order ${entry.order}`;
      lines.push(`  - ${entry.id} "${entry.label}" (${order})`);
    }
    lines.push(`card style selection: ${formatCardSelection(card.selection)}`);
    lines.push(`card style frame: ${formatCardFrame(card.frame)}`);
    for (const surface of card.surfaces) lines.push(formatCardSurface(surface));
    lines.push(`card style wiring: ${formatCardWiring(card.wiring)}`);
    if (card.failures.length > 0) {
      lines.push(`card style failures: ${card.failures.length}`);
      for (const failure of card.failures) {
        lines.push(`  - ${failure.styleId}: ${failure.message}`);
      }
    }
    // S7: a later post-processor — a component that rewrites the conversation's rows after this
    // frame is drawn — can erase it. The bridge cannot prevent that, so it says so instead of
    // pretending otherwise.
    lines.push(
      "card style note: a downstream post-processor can strip or override this frame; " +
        "the bridge cannot prevent it.",
    );
  }

  if (snapshot.lastRepaint !== undefined) {
    const trigger = snapshot.lastRepaint;
    const outcome =
      trigger.outcome === "repainted" ? "repainted" : `unavailable: ${trigger.reason ?? "no reason recorded"}`;
    lines.push(`last repaint: ${trigger.surfaces.join(", ")} for ${trigger.cause} (${outcome})`);
  }

  if (snapshot.transforms !== undefined) {
    lines.push(`transforms: ${snapshot.transforms.length} registered`);
    for (const entry of snapshot.transforms) {
      const order = entry.order === "registration" ? "registration order" : `order ${entry.order}`;
      const outcome =
        entry.outcome === "failed"
          ? `failed (${entry.message ?? "no message"})`
          : entry.outcome;
      lines.push(`  - ${entry.id} (${order}): ${outcome}`);
    }
  }

  if (snapshot.pluginLines !== undefined) {
    lines.push(...formatPluginLines(snapshot.pluginLines));
  }

  if (snapshot.notices !== undefined) {
    lines.push(`notices: ${snapshot.notices.length}`);
    for (const notice of snapshot.notices) {
      const state = notice.delivered ? "delivered" : "pending";
      lines.push(`  - ${notice.level} (${state}): ${notice.message}`);
    }
  }
  if (snapshot.noticesDropped !== undefined) {
    lines.push(`notices dropped: ${snapshot.noticesDropped}`);
  }

  return lines;
}

/** The INTEGRATIONS header's availability note: empty when the host surface is installed. */
function formatPluginAvailability(report: PluginLineReport): string {
  if (report.availability === "installed") return "";
  const state = report.availability === "unavailable" ? "unavailable" : "not armed";
  const reason = report.reason === undefined ? "" : `: ${report.reason}`;
  return ` (status ${state}${reason})`;
}

/** The per-plugin INTEGRATIONS list: the name, how it was chosen, and the registration counts. */
function formatPluginLines(report: PluginLineReport): string[] {
  const lines = [`plugin lines: ${report.plugins.length}${formatPluginAvailability(report)}`];
  for (const plugin of report.plugins) {
    const source =
      plugin.nameSource === "explicit"
        ? "explicit name"
        : `derived from package ${JSON.stringify(plugin.packageName ?? "")}`;
    // `(no line)` is a state, not a name: a module path is diagnostics and stays on this line only,
    // never in the footer (I2).
    const label = plugin.name === undefined ? "(no line)" : `${JSON.stringify(plugin.name)} (${source})`;
    const where = plugin.name === undefined ? ` module ${plugin.modulePath}` : "";
    const state =
      plugin.line === "set"
        ? plugin.status
        : `no line set (${plugin.reason ?? "no reason recorded"})`;
    lines.push(
      `  - ${label}${where}: ${state}, ${plugin.accepted} accepted, ${plugin.rejected.length} rejected`,
    );
    for (const rejection of plugin.rejected) {
      lines.push(`    - ${rejection.surface} ${JSON.stringify(rejection.id)}: ${rejection.reason}`);
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
