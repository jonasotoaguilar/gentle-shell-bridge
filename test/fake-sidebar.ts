/**
 * A fake sidebar host (S9), modelling `lib/shell-sidebar.ts` and `lib/shell-sidebar-layout.ts`.
 *
 * The real host cannot be imported: Pi loads every extension through its own jiti loader with
 * `moduleCache: false`, so gentle-shell's modules are not reachable from this package, and the
 * host is not a dependency we may patch. This file models only the seams the bridge touches:
 *
 * 1. **The state slot.** The host keeps its rail state on the *terminal* object behind
 *    `Symbol.for("gentle-pi.experimental-sidebar.state")` (`lib/shell-sidebar.ts:6,78-80`), not in
 *    module scope, so separately loaded copies see one rail map. The fake hangs the same slot on
 *    the same kind of object, which is why a test can assert the bridge reached the host's map
 *    rather than a module-level singleton of its own.
 * 2. **The rail map.** `state.parts` is a real `Map<string, Rail>`, written through `set` exactly
 *    like `sidebarPart` does (`:88-89`). Registration is therefore observable at any time —
 *    including after the bridge armed, which is the ordering S4 has to survive. The only rail
 *    keys the layout paints are `["todo", "jobs", "agents", "footer"]`
 *    (`lib/shell-sidebar-layout.ts:344`), so an unknown key never renders and a new rail key is
 *    not a way to add a section.
 * 3. **The frame.** A transparent rail's part is drawn as one card per `cardGroups` entry, its
 *    first row split into glyph/title/count and its remaining rows given the card frame
 *    (`sectionCardRows`, `lib/shell-sidebar-layout.ts:35-44,392-410`). `renderSidebar` reproduces
 *    that shape without ANSI styling, so tests assert framed output (`cardTitles`, the `│ rows`)
 *    instead of the raw lines a rail returned.
 *
 * This is a scaffold: it holds no tests. Every test that uses it lives next to the behaviour it
 * proves.
 */

/** The host's own state key: shared across copies, and the seam the bridge intercepts. */
export const SIDEBAR_STATE_KEY: symbol = Symbol.for("gentle-pi.experimental-sidebar.state");

/** The rail keys the layout actually paints, in paint order (`shell-sidebar-layout.ts:344`). */
const RAIL_KEYS = ["todo", "jobs", "agents", "footer"] as const;

const DEFAULT_WIDTH = 40;

/**
 * A rail slot (`SidebarRail`, `lib/shell-sidebar.ts:17-66`). A real rail is a TUI `Component`; the
 * fields below are the ones the bridge reads, passthroughs and test readers depend on.
 */
export interface Rail {
  render(width: number): string[];
  /**
   * The `Component`'s normalized mouse handler (`@earendil-works/pi-tui` `Component.handleMouse`).
   * The host dispatches a hit on this part here, so the bridge must delegate to it, never replace it.
   */
  handleMouse?(event: unknown): unknown;
  /** Row ranges of the section cards this part draws; absent means "one card for the whole part". */
  cardGroups?(
    width: number,
  ): { groups: Array<{ start: number; end: number }>; loose?: number[] } | undefined;
  /** Cheap digest of the live state the part paints; the layout memo skips re-renders while it holds. */
  digest?(): string;
  /** "panel" parts share one painted surface instead of drawing their own card chrome. */
  surface?: "panel";
  /** A one-row digest for the mobile work row. */
  summary?(): unknown;
  /** Opens the section's own view on a tap. */
  open?(): void;
  /** "Needs you" rows drawn above the panel editor's rule. */
  alert?(width: number): string[];
  /** What this section's work spent (started subagents), read by the Stats section. */
  spend?(): { runs: number; tokens: number; cost: number } | undefined;
  /** `Component` housekeeping the host calls on a disposed part. */
  invalidate?(): void;
  dispose?(): void;
}

/** The host's state as it sits on the terminal (`SidebarState`, `lib/shell-sidebar.ts:8-36`). */
export interface FakeSidebarState {
  active: boolean;
  visibility?: { todo?: boolean };
  parts: Map<string, Rail>;
}

/** A terminal object, the thing the host hangs its state on. */
export type FakeTerminal = Record<string | symbol, unknown>;

const terminal: FakeTerminal = { columns: 160, rows: 40, isTTY: true };

/** The fake terminal, so a test can prove where the state slot lives. */
export function fakeTerminal(): FakeTerminal {
  return terminal;
}

/** The `tui` the host hands `sidebarState(tui)`: it only ever reads `tui.terminal`. */
export function fakeTui(): { terminal: FakeTerminal } {
  return { terminal };
}

/**
 * The host's rail state, created on first access exactly as `sidebarState` does (`??=`). Reading
 * through this accessor is what makes a later `registerNativeFooter()` visible: it always returns
 * the live slot, never a copy.
 */
export function fakeState(): FakeSidebarState {
  const existing = terminal[SIDEBAR_STATE_KEY];
  if (isFakeState(existing)) return existing;
  const created: FakeSidebarState = { active: true, parts: new Map() };
  terminal[SIDEBAR_STATE_KEY] = created;
  return created;
}

function isFakeState(value: unknown): value is FakeSidebarState {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { parts?: unknown }).parts instanceof Map
  );
}

/**
 * The native `STATS`-style part: two body rows under a `▾ TITLE` header, declared as one card
 * group the way the host's own rails do.
 */
function nativeRail(title: string, body: readonly string[] = ["native row 1", "native row 2"]): Rail {
  const lines = [`▾ ${title}`, ...body];
  return {
    render: () => [...lines],
    cardGroups: () => ({ groups: [{ start: 0, end: lines.length }] }),
    digest: () => `${title.toLowerCase()}:native`,
    spend: () => ({ runs: 0, tokens: 0, cost: 0 }),
  };
}

/** Register the host's own `footer` part; callable before or after the bridge armed. */
export function registerNativeFooter(rail: Rail = nativeRail("FOOTER")): Rail {
  return registerNativeRail("footer", rail);
}

/** Register any painted part (`todo`, `jobs`, `agents`, `footer`), replacing its slot in place. */
export function registerNativeRail(key: string, rail: Rail): Rail {
  // Written through the live map, like `sidebarPart` (`lib/shell-sidebar.ts:88`): a bridge that
  // intercepts the map's `set` (or replaces `parts`) sees this registration whenever it happens.
  fakeState().parts.set(key, rail);
  return rail;
}

/** Drop one part, as the host's `dispose()` does (`lib/shell-sidebar.ts:92-95`). */
export function unregisterNativeRail(key: string): void {
  fakeState().parts.delete(key);
}

/**
 * The legacy switch the host honours for the Todos card (`shell-sidebar-layout.ts:344`): a rail
 * whose key is hidden paints nothing, which is what a hidden section must also do.
 */
function hiddenByHost(key: string, state: FakeSidebarState): boolean {
  return key === "todo" && state.visibility?.todo === false;
}

/**
 * Paint the rail the way the layout does: for every painted key, ask the part for its lines, then
 * draw one card per `cardGroups` entry (`sectionCardRows`). A part without `cardGroups` is one
 * card headed by its first row. "Loose" and otherwise unframed rows follow their cards.
 *
 * Deliberately unstyled: no ANSI, so a test can assert the frame itself. The box characters match
 * the card chrome (`╭ ─ ╮ │ ╰ ╯`), which is what makes "framed like the native sections" checkable.
 *
 * One pass yields both the rows (what the terminal shows) and the cards (what a test reads), so
 * no helper has to re-parse the frame it just drew.
 */
function paint(width: number): { rows: string[]; cards: PaintedCard[] } {
  const state = fakeState();
  const painted: string[] = [];
  const cards: PaintedCard[] = [];

  for (const key of RAIL_KEYS) {
    if (hiddenByHost(key, state)) continue;
    const rail = state.parts.get(key);
    if (rail === undefined) continue;

    const lines = [...(rail.render(width) ?? [])];
    // The layout drops trailing blank rows before deciding whether a part has content.
    while (lines.length > 0 && String(lines[lines.length - 1]).trim() === "") lines.pop();
    if (lines.length === 0) continue;

    if (painted.length > 0) painted.push(""); // one blank row between two sections
    const layout = rail.cardGroups?.(width);
    const groups = layout?.groups ?? [{ start: 0, end: lines.length }];
    groups.forEach((group, index) => {
      if (index > 0) painted.push("");
      const header = splitHeader(lines[group.start] ?? "");
      const body = lines.slice(group.start + 1, group.end);
      cards.push({ title: header.title, body: [...body] });
      painted.push(...cardFrame(header, body, width));
    });
    for (const row of layout?.loose ?? []) {
      const line = lines[row] ?? "";
      if (line.trim() !== "") painted.push(line);
    }
  }

  return { rows: painted, cards };
}

/** The rows the terminal would show: every registered rail, drawn as framed cards. */
export function renderSidebar(width: number = DEFAULT_WIDTH): string[] {
  return paint(width).rows;
}

/** One painted card: the title the user reads and the body rows inside its frame. */
export interface PaintedCard {
  title: string;
  body: string[];
}

/**
 * Titles of the cards currently painted, in paint order. This is the assertion surface for
 * "our section renders inside the frame, after the native content": a bare string in a rail's
 * output is not a rendered section.
 */
export function cardTitles(width: number = DEFAULT_WIDTH): string[] {
  return paint(width).cards.map((card) => card.title);
}

/** The body rows of the first card with that title, frame removed; empty when it never painted. */
export function cardBody(title: string, width: number = DEFAULT_WIDTH): string[] {
  return paint(width).cards.find((card) => card.title === title)?.body ?? [];
}

/** Empty the host's rail map and forget the state slot, so the next access starts from nothing. */
export function resetSidebar(): void {
  const existing = terminal[SIDEBAR_STATE_KEY];
  if (isFakeState(existing)) existing.parts.clear();
  delete terminal[SIDEBAR_STATE_KEY];
}

/**
 * Split a part's header row into the card's glyph, title and right-aligned count, the way
 * `headerParts` does (`lib/shell-sidebar-layout.ts:57-66`): the count is whatever follows the gap
 * before it, so a single-spaced title keeps its spaces.
 */
function splitHeader(line: string): { glyph?: string; title: string; count?: string } {
  const glyphMatch = /^(\S+)\s+(.*)$/.exec(line.trimEnd());
  const glyph = glyphMatch?.[1];
  const rest = glyphMatch?.[2] ?? line.trimEnd();
  const [title, ...tail] = rest.split(/\s{2,}/);
  const count = tail.join(" ").trim();
  return {
    ...(glyph === undefined ? {} : { glyph }),
    title: title.trim(),
    ...(count === "" ? {} : { count }),
  };
}

/**
 * One card: a top rule carrying the title (and its count, when it fits), a framed row per body
 * line, and a closing rule. Same arithmetic as `cardTop`/`cardLine`/`cardBottom` at a fixed
 * width, minus styling; every row is exactly `width` wide.
 */
function cardFrame(
  header: { glyph?: string; title: string; count?: string },
  body: readonly string[],
  width: number,
): string[] {
  const head = `${header.glyph ?? "▾"} ${header.title}`;
  const hint = header.count === undefined ? "" : ` ${header.count} `;
  // The count rides the rule only while a minimum fill remains (cardTop's `shownHint` rule).
  const showHint = hint !== "" && head.length + 5 + hint.length <= width;
  const hintWidth = showHint ? hint.length : 0;
  const fill = Math.max(0, width - head.length - hintWidth - 4);
  const inner = Math.max(0, width - 4);

  const top = `╭─${head} ${"─".repeat(fill)}${showHint ? hint : ""}╮`;
  const rows = body.map((row) => `│ ${row.slice(0, inner).padEnd(inner, " ")} │`);
  const bottom = `╰${"─".repeat(Math.max(0, width - 2))}╯`;
  return [top, ...rows, bottom];
}
