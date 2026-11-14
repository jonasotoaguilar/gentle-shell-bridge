/**
 * The customize rows for tool designs (S6, T9): one line per tool that HAS designs, in `Cards`.
 *
 * ## One line per tool, one value per design
 *
 * The values of a tool's line are the tool's own card — `native`, the reserved value — followed by
 * every design registered for that tool, in registration order. The host coalesces consecutive rows
 * that share a `choice.setting` into one rendered line (`lib/visual-customize-view.ts:395-402,583-595`),
 * so all of one tool's values share that tool's setting and two tools can never share a line.
 *
 * ## The names: `Card <tool>`, like `Card style` and `Card content`
 *
 * A row name is what a human reads (`./row-names.ts`), and the `Cards` category already names its
 * lines `Card <what>`: `Card style`, `Card content`. A design line follows that vocabulary, so the
 * bash tool's line reads `Card bash` — never the bare tool name, which reads like a category of its
 * own. The readable words come from the TOOL (`deriveRowLabel`), never from the plugin or the id, and
 * the bridge's name rule is one to three plain words (`MAX_ROW_NAME_WORDS`), so `Card` plus at most
 * two tool words:
 *
 * - `bash` → `Card bash`;
 * - `lsp_navigation` → `Card lsp navigation`;
 * - `mcp__engram__mem_save` → the TAIL is the specific part, so the leading words go:
 *   `Card mem save` (not `Card mcp engram`, which says nothing about the tool);
 * - a tool name with no words at all keeps the fallback word: `Card tool`;
 * - two tools that read the same after that clamp are told apart deterministically with an ordinal —
 *   `Card mem save`, `Card mem 2` — replacing the last word so the result still passes the shape
 *   rule, exactly the way sections and card styles are told apart (`sectionRowLabels`).
 *
 * The id is never shown: a design's `label` is its value, and the persisted value is the design's id,
 * so renaming a label never loses a user's choice. The line's NAME is not persisted anywhere either —
 * the store is keyed by the tool name (`bridge-tool-designs` → `selections` → `{ "bash": … }`), so
 * renaming the line moves nothing but the text the user reads.
 *
 * ## No design, no line
 *
 * The provider is registered when the bridge arms and its rows are rebuilt per menu build, never
 * cached. With no design registered it contributes NOTHING: a session that never installed a design
 * plugin must not gain an empty line. The first design to register appears on the next build with no
 * re-registration.
 *
 * ## A change repaints the cards already drawn (S2)
 *
 * The action persists FIRST (the host re-reads `current()` when it repaints) and then asks for a
 * frame through `requestRepaint()` (`./repaint.ts`): one differential `requestRender()`, because the
 * wrapper re-reads the live selection on every render pass, so the cards already on screen change too
 * — not only the next one (S13/T23 measured the cache-dropping version as the freeze). A press that
 * changes nothing costs no frame.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { registerRows } from "./bus.ts";
import { HOST_CARD_STYLE_CATEGORY } from "./card-style-line.ts";
import { requestRepaint } from "./repaint.ts";
import { deriveRowLabel } from "./row-labels.ts";
import { MAX_ROW_NAME_WORDS } from "./row-names.ts";
import { isRecord } from "./rows.ts";
import {
  TOOL_DESIGN_NATIVE,
  getToolDesignSelection,
  setToolDesignSelection,
  snapshotToolDesigns,
  toolNamesWithDesigns,
} from "./tool-designs.ts";
import type { CustomizeRow, RowPreview, ToolDesignRegistration } from "./types.ts";

/** The rows provider's id; it is the bridge's own registration, never a plugin's. */
export const TOOL_DESIGN_ROWS_PROVIDER_ID = "bridge.tool-designs";

/** The word every per-tool design line starts with: the `Cards` category's own vocabulary. */
const TOOL_LINE_PREFIX = "Card";

/** The word a tool name that derives to nothing still reads as (`deriveRowLabel` returned ""). */
const TOOL_NAME_FALLBACK = "tool";

/**
 * The tool's readable words, clamped so `Card` plus them fits the row-name word limit. A long name
 * keeps its TAIL: `mcp__engram__mem_save` reads `mem save`, because the last words are the specific
 * part and the leading ones (`mcp`, `engram`) are the same for every tool of that server.
 */
function toolWords(tool: string): string[] {
  const derived = deriveRowLabel(tool);
  const words = derived === "" ? [TOOL_NAME_FALLBACK] : derived.split(" ").filter((word) => word !== "");
  const budget = Math.max(1, MAX_ROW_NAME_WORDS - 1);
  return words.length > budget ? words.slice(words.length - budget) : words;
}

/**
 * The line name of every tool that has designs, in registration order: `Card <tool words>`, made
 * unique the way sections are — the readable name, then the lowest free ordinal (replacing the last
 * word when the base already uses the full word limit, so the result still passes the shape rule).
 */
function toolLineNames(tools: readonly string[]): Array<{ tool: string; name: string }> {
  const taken = new Set<string>();
  return tools.map((tool) => {
    const base = [TOOL_LINE_PREFIX, ...toolWords(tool)].join(" ");
    let name = base;
    let suffix = 2;
    while (taken.has(name)) {
      const words = base.split(" ");
      const kept = words.slice(0, MAX_ROW_NAME_WORDS - 1);
      name = `${kept.join(" ")} ${suffix++}`;
    }
    taken.add(name);
    return { tool, name };
  });
}

/**
 * Persist one tool's value and repaint the cards already drawn (S2).
 *
 * Nothing at all happens when the stored value is already the one picked: a press that changes
 * nothing must not cost a frame.
 */
function selectDesign(tool: string, id: string): void {
  if (getToolDesignSelection(tool) === id) return;
  setToolDesignSelection(tool, id);
  requestRepaint();
}

/**
 * A design's own preview when it has one, otherwise a literal depiction of the value. A preview runs
 * while the menu is rendered, so it must not be able to break it: a throwing (or malformed) plugin
 * preview loses its own picture and nothing else.
 */
function previewFor(design: ToolDesignRegistration): RowPreview {
  if (design.preview !== undefined) {
    try {
      const shown: unknown = design.preview();
      if (isRecord(shown) && typeof shown.title === "string" && typeof shown.sample === "string") {
        return { title: shown.title, sample: shown.sample };
      }
    } catch {
      // Fall through to the literal sample below.
    }
  }
  return {
    title: `Cards · ${design.label}`,
    sample:
      design.description ??
      `${design.label}: this design rewrites the rows ${design.tool}'s own card produced`,
  };
}

/** The `native` value: the host's own card, untouched. */
function nativeRow(tool: string, setting: string): CustomizeRow {
  return {
    category: HOST_CARD_STYLE_CATEGORY,
    choice: {
      setting,
      value: TOOL_DESIGN_NATIVE,
      // Identity, never the displayed text: a renamed label cannot lose the user's choice.
      current: () => getToolDesignSelection(tool) === TOOL_DESIGN_NATIVE,
    },
    preview: () => ({
      title: `Cards · ${setting}`,
      sample: `${setting}: the host's own card for ${tool}, untouched`,
    }),
    action: () => selectDesign(tool, TOOL_DESIGN_NATIVE),
  };
}

/** One registered design of one tool. The visible value is its label; the stored value is its id. */
function designRow(tool: string, setting: string, design: ToolDesignRegistration): CustomizeRow {
  return {
    category: HOST_CARD_STYLE_CATEGORY,
    choice: {
      setting,
      value: design.label,
      current: () => getToolDesignSelection(tool) === design.id,
    },
    preview: () => previewFor(design),
    action: () => selectDesign(tool, design.id),
  };
}

/** The rows of one menu build: nothing without a design, one line per tool that has one. */
function designRows(): CustomizeRow[] {
  const tools = toolNamesWithDesigns();
  if (tools.length === 0) return [];
  const rows: CustomizeRow[] = [];
  for (const { tool, name } of toolLineNames(tools)) {
    rows.push(nativeRow(tool, name));
    for (const design of snapshotToolDesigns(tool)) rows.push(designRow(tool, name, design));
  }
  return rows;
}

interface ToolDesignRowsState {
  /** The live provider's disposer, while the bridge has it registered. */
  dispose?: () => void;
}

/** Process-global, like every other piece of bridge state: two copies must agree. */
const ROWS_KEY = Symbol.for("gentle-shell-bridge.tool-designs.rows.v1");

function rowsHost(): Record<symbol, ToolDesignRowsState | undefined> {
  // SAFETY: only `rowsState()` writes this key, and it re-checks the shape before trusting a value
  // left by another copy or an older load.
  return globalThis as unknown as Record<symbol, ToolDesignRowsState | undefined>;
}

function rowsState(): ToolDesignRowsState {
  const host = rowsHost();
  const existing = host[ROWS_KEY];
  if (existing !== undefined && (existing.dispose === undefined || typeof existing.dispose === "function")) {
    return existing;
  }
  const created: ToolDesignRowsState = {};
  host[ROWS_KEY] = created;
  return created;
}

/**
 * Register the design line for this process and return a disposer that withdraws it.
 *
 * Call it when the bridge arms; it needs no `tui` and no capture. Installing twice is a no-op, so a
 * second arm or a second loaded copy of this package cannot contribute the line twice.
 */
export function installToolDesignRows(): () => void {
  const state = rowsState();
  if (state.dispose === undefined) {
    state.dispose = registerRows({
      id: TOOL_DESIGN_ROWS_PROVIDER_ID,
      category: HOST_CARD_STYLE_CATEGORY,
      // Rebuilt per build, never cached: a design registered later shows up with no re-registration.
      rows: () => designRows(),
    });
  }
  let withdrawn = false;
  return () => {
    if (withdrawn) return;
    withdrawn = true;
    const dispose = state.dispose;
    state.dispose = undefined;
    dispose?.();
  };
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetToolDesignRowStateForTests(): void {
  const state = rowsState();
  const dispose = state.dispose;
  state.dispose = undefined;
  dispose?.();
}
