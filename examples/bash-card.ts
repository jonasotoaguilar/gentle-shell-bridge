/**
 * Worked consumer of `gentle-shell-bridge`: ONE Pi extension that demonstrates every surface the
 * package publishes — a row toggle, a sidebar section, a card style and a transcript transform.
 *
 * A. The bash rendering — through the bridge, as a TRANSFORM. `registerTransform` receives the
 *    conversation's rows on EVERY frame and returns the rows to draw, so the toggle below restyles
 *    the bash cards that are already on screen, not only the ones built after the switch. That is
 *    the whole point: `pi.registerToolRenderer` resolves once, when a tool row is BUILT, so a
 *    rendering choice made there can never reach history — the defect this file used to document
 *    instead of fixing. The transform recognises a bash card by what the host already produced (the
 *    host's `float` frame, the host's `neon` outline, or this file's own `plain` frame, whose heading
 *    is `bash`) and rewrites it with this file's chrome:
 *
 *    ```text
 *    ▸ bash
 *    ▸ ls -1
 *    ▸
 *    ```
 *
 *    `default` returns the lines untouched, so the host's card is exactly the host's card;
 *    `tool` rewrites every bash card in the frame. One owner, one look: this file registers no
 *    tool renderer at all.
 *
 *    Both modes report frame telemetry through `ctx.report(...)`: how many rows the grammar examined
 *    as a possible card head, how many it recognised, how many it rewrote, and which shape matched
 *    (`float` for the host's frame, `plain` for this file's own). `/bridge-status` prints it on the
 *    transform's line, which is how "the toggle does nothing in this TUI" becomes a measurement: the
 *    counts are taken whether or not the setting rewrites anything. They are counts only — no line
 *    of the conversation is ever handed over — and the report is optional, so this file still works
 *    against a published bridge older than the telemetry.
 *
 * B. The toggle row — through the bridge. `registerRows` contributes two consecutive `Cards` rows
 *    sharing one `choice.setting`, and `createStore("bash-card-example")` persists the choice, so
 *    the row and the transform read the same value. It is the only control: `default` and `tool`
 *    are the two looks, and no second setting is needed to reach them.
 *
 * C. The sidebar section — through the bridge too. `registerSection` adds a `BASH CARD` card to
 *    gentle-shell's fullscreen sidebar, drawn by the host's own frame, whose body reports the mode
 *    and whether this load actually registered its transform. The same registration gives it a
 *    `Sections` toggle in `/gentle:customize`, so the card can be hidden without the plugin writing
 *    a row, a setting or a store for it.
 *
 *    The card behaves like a host card (N10–N14), which is the whole point of the row model: clicking
 *    the HEADER folds the section (the bridge owns that, and persists it), the header's right-aligned
 *    count is the live rendering mode, and the `rendering` row is CLICKABLE — pressing it switches
 *    `default` ↔ `tool` through the same store the `Cards` toggle writes, so the card, the toggle's
 *    bullet and the next conversation frame all agree. The `transform` row carries no `onClick`, so
 *    it is inert and never highlights: a row acts only when the plugin says it does.
 *
 * D. The card style — through the bridge as well. `registerCardStyle` adds one value, `plain`, to
 *    the `Card style` line `/gentle:customize` already draws: `○ neon ○ float ○ plain`. Choosing it
 *    makes the bridge repaint every conversation card the host drew with this file's frame — a
 *    single gutter character per row, the heading as plain text, no box — and choosing `neon` or
 *    `float` puts the host's own rendering back. It is a style for TOOL cards in general: a `read`
 *    card is repainted exactly like a `bash` one. Nothing here parses a card: the bridge measures,
 *    extracts the heading and the hint, and hands them over.
 *
 * A bridge that publishes an incompatible API is treated as absent, and the example registers
 * nothing; it says so once through `ctx.ui.notify` — with the announcement channel named when this
 * Pi has one, because then a later publication is still possible. A bridge that publishes the row
 * and section
 * surfaces but not `registerCardStyle` (an older object) keeps the rows and the section on the line
 * and skips the style silently: the member is optional, and this file must not warn about a surface
 * the bridge never promised. The same rule applies to `registerTransform`: absent means "keep the
 * other surfaces and stay quiet", and the section says `transform  absent` instead.
 *
 * Loading: copy this file into `~/.pi/agent/extensions/` (or point Pi's `packages` entry at this
 * repository) and `/reload`. The toggle defaults to `default`, so installing the example changes
 * no rendering until the user asks for it.
 *
 * Reaching the bridge needs no path, no environment variable and no import: the file and the
 * bridge meet on `globalThis` behind one `Symbol.for` key (see "Reaching gentle-shell-bridge"
 * below). Two load orders therefore have to work, and Pi really produces both: global extensions
 * (`~/.pi/agent/extensions`) load — and receive `session_start` — BEFORE a configured package's
 * module publishes. So the example tries the symbol in its own `pi.on("session_start", ...)`
 * handler, and additionally listens on Pi's cross-extension bus for
 * `"gentle-shell-bridge:ready"`. Whichever happens first registers the surfaces; the guard below
 * makes the second one a no-op.
 *
 * When no bridge is published at `session_start` the notice reports which state this is: waiting
 * for the announcement on a Pi that has an event bus (`pi.events`), or nothing to wait for on one
 * that does not — never "the bridge is not installed" while it may simply not have loaded yet.
 *
 * Diagnostics stay inside Pi: nothing here writes to stdout/stderr. A message is buffered and
 * delivered through `ctx.ui.notify` on `session_start`, which is the only channel Pi renders in its
 * own report.
 *
 * Nothing here imports `@earendil-works/pi-coding-agent` or `@earendil-works/pi-tui`: this
 * repository depends on neither, so every host shape this file touches is declared structurally
 * below, the way `src/extension.ts` declares the extension API it uses.
 */

// ---------------------------------------------------------------------------------------------
// The one value both surfaces agree on
// ---------------------------------------------------------------------------------------------

/** Store file: `<gentle config home>/gentle-shell-bridge/bash-card-example.json`. */
const PLUGIN_ID = "bash-card-example";
/** The single setting key, read by the transform and by the row's `current()`. */
const SETTING_KEY = "bashRendering";
const MODE_DEFAULT = "default";
const MODE_TOOL = "tool";
type BashRenderingMode = typeof MODE_DEFAULT | typeof MODE_TOOL;

/**
 * Row text: a row NAME, in the same vocabulary the host uses for its own rows (`Card style`,
 * `Card content`, `stats`).
 *
 * One to three plain words, no arrow, no colon, no dot, no pipe, no slash, no bracket, no trailing
 * qualifier — the bridge REJECTS a name that breaks that shape before it is stored, records the
 * offending string with the rule it broke, and lists it in `/bridge-status` (N7, N8). The name this
 * file used to send, `Bash card → Bash rendering`, read as a breadcrumb in the menu: the category
 * already says `Cards`, and the two bullets below already say `default` and `tool`, so
 * `Bash rendering` is the whole name.
 *
 * The line's name and its row label are the SAME string, which is what makes the host draw one line
 * (`docs/contract.md` §4 and §6). A collision with another provider's line is avoided by picking a
 * distinct plain-word name, not by namespacing the setting with punctuation.
 */
const ROW_LABEL = "Bash rendering";
const SETTING_NAME = "Bash rendering";
/** A category the host already renders; the bridge cannot create new ones (`docs/contract.md`, Limits). */
const ROW_CATEGORY = "Cards";

// ---------------------------------------------------------------------------------------------
// Host shapes, declared structurally
// ---------------------------------------------------------------------------------------------

interface BridgeStoreLike {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

interface RowChoiceLike {
  setting: string;
  value: string;
  current(): boolean;
  hint?: string;
  applyOnMove?: boolean;
}

interface CustomizeRowLike {
  category?: string;
  label?: string | (() => string);
  choice?: RowChoiceLike;
  /** Read-only depiction of the highlighted choice, drawn under the row. */
  preview?: () => { title: string; sample: string };
  visible?: () => boolean;
  action?: () => void | Promise<void>;
}

interface RowProviderLike {
  id: string;
  category: string;
  /**
   * The plugin's INTEGRATIONS row name. Optional in the bridge (a package is attributed from its
   * module), but this file is meant to be COPIED into `~/.pi/agent/extensions/`, where it has no
   * owning package — and the bridge refuses to invent a name, so it would get no row. Naming it
   * here is the documented way for a single-file extension to get its one line.
   */
  name?: string;
  rows(ctx: { theme: unknown; configHome: string }): CustomizeRowLike[];
}

/**
 * One structured section row (`SectionRow` in `src/types.ts`): the shape that makes a row a row of
 * a native card — an icon, a semantic tone, a right-aligned live `meta` and an optional `onClick`.
 * `tone` names one of the host's own roles (`text`, `muted`, `dim`, `accent`, `success`, `error`,
 * `warning`), never a colour.
 */
interface SectionRowLike {
  label: string;
  meta?: string;
  glyph?: string;
  tone?: "text" | "muted" | "dim" | "accent" | "success" | "error" | "warning";
  onClick?: () => void;
}

/**
 * The section contract (`docs/contract.md` §11), structural like every host shape here. A section
 * writes content only: no `choice`, no `action`, no `preview` — the bridge contributes the toggle,
 * the header, the collapse control and the pointer handling.
 */
interface SidebarSectionLike {
  id: string;
  title: string;
  /**
   * What the `Sections` row reads. Optional: the bridge derives one from `title` when it is absent.
   * The example passes it explicitly so a reader copies the right shape — a label, never the id.
   */
  rowLabel?: string;
  meta?(ctx: { theme: unknown; configHome: string }): string | undefined;
  /** A plain string is drawn byte for byte; a structured row is drawn like a native one. */
  lines(ctx: { theme: unknown; configHome: string }): Array<string | SectionRowLike>;
  defaultVisible?: boolean;
  order?: number;
}

/** The pieces of the host's card a style's frame is handed (`src/types.ts`, `CardFrame*Context`). */
interface CardFrameTopContextLike {
  width: number;
  title?: string;
  hint?: string;
}
interface CardFrameLineContextLike {
  text: string;
  width: number;
  first: boolean;
}
interface CardFrameBottomContextLike {
  width: number;
}

/**
 * A card style as the bridge accepts it (`src/types.ts`, `CardStyleRegistration`). The three frame
 * functions are the whole contract: measured width in, one row out, never wider than the width.
 */
interface CardStyleLike {
  id: string;
  label: string;
  /** What the style's row reads; optional, derived from `label` when absent. Never the id. */
  rowLabel?: string;
  order?: number;
  frame: {
    top(ctx: CardFrameTopContextLike): string;
    line(ctx: CardFrameLineContextLike): string;
    bottom(ctx: CardFrameBottomContextLike): string;
  };
  preview?(): { title: string; sample: string };
}

/**
 * What a transform may report about its own frame (`src/types.ts`, `TransformCounts`): how many
 * candidate cards it examined, how many it recognised, how many it rewrote, and which of its shapes
 * matched, by name. Counts only — never a line of the frame, which carries the user's output.
 */
interface TransformCountsLike {
  candidates: number;
  recognised: number;
  rewritten: number;
  shapes?: Record<string, number>;
}

/**
 * What a transform receives on every frame (`src/types.ts`, `TransformContext`): the width the host
 * rendered the conversation at, which is also the widest row it may return — the bridge clips
 * anything wider before the frame reaches the screen — and the channel it reports its counts on.
 *
 * `report` is OPTIONAL because a published bridge older than the telemetry has no such member: the
 * transform gates with `typeof ctx.report === "function"` and works with either.
 */
interface TransformContextLike {
  width: number;
  report?(counts: TransformCountsLike): void;
}

/**
 * A transcript transform (`src/types.ts`, `TranscriptTransform`). It receives the rows the host (and
 * any earlier transform) produced and returns the rows to draw; it never touches Pi, and a throw
 * costs only this transform's frame.
 */
interface TransformLike {
  id: string;
  order?: number;
  transform(lines: readonly string[], ctx: TransformContextLike): readonly string[];
}

/**
 * The API object `gentle-shell-bridge` publishes (`src/api.ts`, `BridgeApi`): the members this
 * example calls, structurally. Nothing here imports the package, so the shape has to be declared.
 *
 * `registerCardStyle` and `registerTransform` are OPTIONAL by contract: the published object is
 * first-wins, so a process running an older copy can hand back a v1 object without them. A consumer
 * gates with `typeof api.registerTransform === "function"` and keeps the other surfaces working.
 */
interface BridgeApiLike {
  readonly schema: string;
  readonly version: number;
  registerRows(provider: RowProviderLike): () => void;
  registerSection(section: SidebarSectionLike): () => void;
  registerCardStyle?(style: CardStyleLike): () => void;
  registerTransform?(transform: TransformLike): () => void;
  createStore(pluginId: string): BridgeStoreLike;
}

/** The part of Pi's `session_start` context this file reads. */
interface SessionContextLike {
  hasUI?: boolean;
  ui?: unknown;
}

/** The one channel Pi gives an extension for text that is not a row: the in-TUI notification. */
interface NoticeUiLike {
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

/** The part of `ExtensionAPI` this extension uses. */
interface ExtensionApiLike {
  /** `session_start` carries the UI context, so this is where a buffered notice is delivered. */
  on?(event: "session_start", handler: (event: unknown, ctx: SessionContextLike) => void): void;
  /** Pi's cross-extension bus (`docs/extensions.md:1965-1972`); absent on a bare harness. */
  events?: unknown;
}

/**
 * The one member of `pi.events` this file needs: subscribe, and keep the unsubscribe if the bus
 * hands one back. A bus whose `on` returns nothing simply cannot be detached.
 */
type EventUnsubscribe = () => void;

interface ExtensionEventsLike {
  on(channel: string, handler: (payload: unknown) => void): EventUnsubscribe | void;
}

// ---------------------------------------------------------------------------------------------
// Text layout: width is the only budget a frame gets
// ---------------------------------------------------------------------------------------------

const ANSI_SEQUENCE = /\u001b\[[0-9;]*m/g;

/** Visible columns of plain or already-painted text; one column per code point. */
function visibleWidth(text: string): number {
  return Array.from(text.replace(ANSI_SEQUENCE, "")).length;
}

/** Width-clips one line with a trailing ellipsis, so a row never overflows the frame. */
function clipLine(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (width === 1) return "…";
  return `${Array.from(text).slice(0, width - 1).join("")}…`;
}

/** The row the user sees, without SGR: detection reads text, never paint. */
function plainText(line: string): string {
  return line.replace(ANSI_SEQUENCE, "");
}

// ---------------------------------------------------------------------------------------------
// The card style: one gutter character per row, for tool cards in general
// ---------------------------------------------------------------------------------------------

/** Stable across loads and unique on the line: `/reload` replaces this value, never adds a second. */
const CARD_STYLE_ID = "bash-card.plain";
/**
 * What the user reads on the host's own `Card style` line. Short, and it collides with neither the
 * host's values (`neon`, `float`), the bridge's `native`, nor another style's label — the bridge
 * rejects a duplicate label at registration (`docs/contract.md` §12).
 */
const CARD_STYLE_LABEL = "plain";
/**
 * What the style's row reads in `/gentle:customize`. Its id (`bash-card.plain`) stays internal: it
 * is the replacement and selection key, and it would read as a dotted key in the menu.
 */
const CARD_STYLE_ROW_LABEL = "plain";

/** One character of gutter per row: no box, no border glyphs, cheap to read. */
const CARD_STYLE_GUTTER = "▌";

/**
 * The frame. Three functions, each handed a width and text the BRIDGE already measured and
 * extracted; nothing here looks for a title in a line or strips a frame. Every row goes through
 * `clipLine`, so the style can never emit a line wider than the width it was given.
 *
 * A card in this style at width 40:
 *
 * ```text
 * ▌ read                        ctrl+o
 * ▌ config.ts
 * ▌
 * ```
 */
const PLAIN_CARD_FRAME: CardStyleLike["frame"] = {
  top: (ctx) => {
    const head = `${CARD_STYLE_GUTTER} ${ctx.title ?? ""}`.replace(/\s+$/, "");
    const hint = ctx.hint;
    if (hint === undefined) return clipLine(head, ctx.width);
    // Right-align the hint when there is room for it and at least one space between; otherwise the
    // heading wins and the hint is dropped rather than making the row ambiguous.
    const gap = ctx.width - visibleWidth(head) - visibleWidth(hint) - 2;
    if (gap < 1) return clipLine(head, ctx.width);
    return clipLine(`${head}${" ".repeat(gap)}  ${hint}`, ctx.width);
  },
  line: (ctx) => {
    const row = ctx.text === "" ? CARD_STYLE_GUTTER : `${CARD_STYLE_GUTTER} ${ctx.text}`;
    return clipLine(row, ctx.width);
  },
  // A bare gutter closes the card: the style has no bottom border to draw, and the row costs one
  // column instead of a rule across the frame.
  bottom: (ctx) => (ctx.width > 0 ? CARD_STYLE_GUTTER : ""),
};

/** A literal depiction for `/gentle:customize`'s preview, drawn by the row's `preview()`. */
const CARD_STYLE_PREVIEW = {
  title: "Cards · plain",
  sample: [
    `${CARD_STYLE_GUTTER} read                 ctrl+o`,
    `${CARD_STYLE_GUTTER} config.ts`,
    `${CARD_STYLE_GUTTER}`,
  ].join("\n"),
};

/**
 * The registration this file sends, or nothing. A style draws what it is given: the bridge owns
 * detection, the heading and the width.
 */
function bashCardStyle(): CardStyleLike {
  return {
    id: CARD_STYLE_ID,
    label: CARD_STYLE_LABEL,
    // A label a user reads, passed explicitly so a reader copies the shape; the bridge would derive
    // `plain` from the label anyway, and the id never appears in a row.
    rowLabel: CARD_STYLE_ROW_LABEL,
    // After any style the host or another plugin leaves unordered; the host's own values come
    // first regardless (`docs/contract.md` §12).
    order: 30,
    frame: PLAIN_CARD_FRAME,
    preview: () => ({ ...CARD_STYLE_PREVIEW }),
  };
}

// ---------------------------------------------------------------------------------------------
// The transform: bash cards, recognised by what the host already drew
// ---------------------------------------------------------------------------------------------
//
// A transform cannot ask Pi for a tool result — it is handed rows, nothing else. So it recognises
// its target the way the bridge recognises a card: by the host's own frame. Three shapes are
// accepted, because the pipeline runs AFTER the card-style repaint:
//
// 1. the host's `float` card — one-column margin, the `▎` bar, then padding / header / separator /
//    body / padding (`docs/contract.md` §12, `src/card-styles.ts` §2), with the heading `bash`;
// 2. this file's own `plain` frame — `▌ bash` plus `▌` rows — so `tool` still wins when `plain`
//    is the selected card style, instead of leaving one bash card in two frames at once;
// 3. the host's `neon` outline — `╭─ ✿ bash ────╮` / `│ text │` / `╰────╯`
//    (`OUTLINE_CHROME`, `gentle-shell/lib/shell-card.ts:105`). This is the frame the host draws when
//    ITS OWN `Card style` line is on `neon`: the bridge's repaint is `float`-only on purpose
//    (`src/card-style-transform.ts`, "The float grammar"), so a neon card reaches a transform
//    untouched and only this file can recognise it — which is why `tool` used to do nothing there.

/** The example's own chrome: a gutter no other surface in this file uses. */
const BASH_GUTTER = "▸";
/** The heading the host prints for a bash card. */
const BASH_TITLE = "bash";
/** Stable across loads and unique in `/bridge-status`: `/reload` replaces it in place. */
const BASH_TRANSFORM_ID = "bash-card-example.bash-cards";
/** The accent bar every `float` row starts with, one column in from the margin. */
const FLOAT_BAR = "▎";
/** The `neon` outline's corners and side rail (`OUTLINE_CHROME`, `shell-card.ts:105`). */
const NEON_TOP = "╭";
const NEON_SIDE = "│";
const NEON_BOTTOM = "╰";
const NEON_BOTTOM_RIGHT = "╯";

/**
 * One bash card in the frame: the rows it occupies and the body text it carried. `start` is the
 * host's first row (or the `plain` frame's head) and `end` is one past its last row.
 */
interface BashCardSpan {
  start: number;
  end: number;
  body: string[];
}

/** `margin ▎ space` — the float frame's first three columns on every row it draws. */
function isFloatRow(text: string): boolean {
  return text.length >= 3 && text.startsWith(` ${FLOAT_BAR} `);
}

/** A bar and nothing else: the opener, the separator and the closer all look like this. */
function isFloatPadding(text: string): boolean {
  return isFloatRow(text) && text.slice(3).trim() === "";
}

/**
 * A float card's heading: the first word after the host's glyph. The host prints
 * `${glyph} ${title}` and then, on the SAME row, the right-aligned hint (and a subtitle), so the
 * heading is the first run of text — not the whole remainder.
 */
function headingText(text: string): string {
  const rest = text.slice(3).trim();
  const characters = [...rest];
  const withoutGlyph =
    characters.length > 2 && characters[1] === " " ? characters.slice(2).join("") : rest;
  return withoutGlyph.trim().split(/\s+/u)[0] ?? "";
}

/** The host's `float` bash card at `start`, when one starts there. */
function floatBashCard(stripped: readonly string[], start: number): BashCardSpan | undefined {
  if (!isFloatPadding(stripped[start] ?? "")) return undefined;
  const header = stripped[start + 1] ?? "";
  if (!isFloatRow(header) || isFloatPadding(header)) return undefined;
  if (headingText(header) !== BASH_TITLE) return undefined;

  const third = stripped[start + 2] ?? "";
  let row: number;
  if (isFloatRow(third) && !isFloatPadding(third)) {
    // Header straight into body, with no separator.
    row = start + 2;
  } else if (isFloatPadding(third)) {
    const fourth = stripped[start + 3] ?? "";
    // A padding row after the header is the separator when a body row follows it, and the closer
    // when nothing does — an empty-body card is exactly three rows.
    if (!isFloatRow(fourth) || isFloatPadding(fourth)) return { start, end: start + 3, body: [] };
    row = start + 3;
  } else {
    return undefined;
  }

  const body: string[] = [];
  while (row < stripped.length) {
    const line = stripped[row] ?? "";
    if (isFloatPadding(line)) break;
    if (!isFloatRow(line)) return undefined;
    body.push(line.slice(3).trimEnd());
    row += 1;
  }
  // An unterminated card is not a card: the frame is left exactly as it is.
  if (!isFloatPadding(stripped[row] ?? "")) return undefined;
  return { start, end: row + 1, body };
}

/** This file's `plain` frame's bash heading: the gutter, a space, then `bash`. */
const PLAIN_BASH_HEAD = new RegExp(`^${CARD_STYLE_GUTTER} ${BASH_TITLE}(?:\\s|$)`, "u");

/** Whether a row could start this file's `plain` bash card: where its grammar has to look. */
function isPlainHead(text: string): boolean {
  return PLAIN_BASH_HEAD.test(text);
}

/** This file's `plain` card style's bash card at `start`, when one starts there. */
function plainBashCard(stripped: readonly string[], start: number): BashCardSpan | undefined {
  if (!isPlainHead(stripped[start] ?? "")) return undefined;
  const body: string[] = [];
  let row = start + 1;
  while (row < stripped.length) {
    const line = stripped[row] ?? "";
    if (line === CARD_STYLE_GUTTER) return { start, end: row + 1, body };
    if (!line.startsWith(`${CARD_STYLE_GUTTER} `)) return undefined;
    body.push(line.slice(CARD_STYLE_GUTTER.length + 1).trimEnd());
    row += 1;
  }
  return undefined;
}

/**
 * A `neon` card's top rule: `╭─ <heading> ────╮`. It starts at column 0, which is what tells it
 * apart from every `float` row (one-column margin, then `▎`) and from this file's own gutter.
 */
function isNeonTop(text: string): boolean {
  return text.startsWith(`${NEON_TOP}─ `);
}

/** A `neon` body row: `│ <text> … │` — the side rail on both ends, then the frame's padding. */
function isNeonBody(text: string): boolean {
  return text.startsWith(`${NEON_SIDE} `) && text.endsWith(NEON_SIDE);
}

/** A `neon` closing rule: `╰─── … ╯`, with a duration riding on it or without. */
function isNeonBottom(text: string): boolean {
  return text.startsWith(NEON_BOTTOM) && text.endsWith(NEON_BOTTOM_RIGHT);
}

/** The text a `neon` body row carries: no side rails, no padding. */
function neonBodyText(text: string): string {
  return text.slice(2, -2).trimEnd();
}

/**
 * The host's `neon` bash card at `start`, when one starts there. Positional, like the `float`
 * grammar: a top rule whose heading is `bash`, body rows while they carry the side rail, and a
 * closing rule. Anything else — no closer, a row that is not a body row — is not a card, and the
 * frame is left exactly as it is.
 */
function neonBashCard(stripped: readonly string[], start: number): BashCardSpan | undefined {
  const top = stripped[start] ?? "";
  if (!isNeonTop(top) || headingText(top) !== BASH_TITLE) return undefined;
  const body: string[] = [];
  let row = start + 1;
  while (row < stripped.length) {
    const line = stripped[row] ?? "";
    if (isNeonBottom(line)) return { start, end: row + 1, body };
    if (!isNeonBody(line)) return undefined;
    body.push(neonBodyText(line));
    row += 1;
  }
  return undefined;
}

/**
 * What one frame's scan found (F3): the cards, how many positions the grammar examined as a possible
 * card head, and which shape matched, by name. Counts only — the rows themselves are never reported.
 */
interface BashScan {
  spans: BashCardSpan[];
  candidates: number;
  shapes: Record<string, number>;
}

/**
 * The shape names this file reports (F3), so the next step is data-driven: the host's own `float`
 * frame, this file's `plain` one, or the host's `neon` outline. Lowercase and mark-free, which is
 * what the bridge keeps; a name it would drop is not worth reporting.
 */
const SHAPE_FLOAT = "float";
const SHAPE_PLAIN = "plain";
const SHAPE_NEON = "neon";

/**
 * Every bash card in the frame, in order, plus what the scan saw on the way. Rows a card already
 * claimed are skipped, so a body row can never be read as the head of the next card.
 *
 * A CANDIDATE is a row where this grammar could start a card at all: a float padding row (the only
 * row a host card can begin on), this file's own `plain` heading, or a host `neon` top rule. A
 * candidate the grammar then rejects is the interesting measurement — "the frame has something
 * card-shaped here and no bash card matched" — which is exactly what a real TUI could not tell apart
 * from "the wrapper never ran". That distinction is the whole reason the counts exist.
 */
function scanBashCards(lines: readonly string[]): BashScan {
  const stripped = lines.map((line) => plainText(line));
  const spans: BashCardSpan[] = [];
  const shapes: Record<string, number> = {};
  let candidates = 0;
  let index = 0;
  while (index < stripped.length) {
    const row = stripped[index] ?? "";
    let span: BashCardSpan | undefined;
    let shape: string | undefined;
    if (isFloatPadding(row)) {
      candidates += 1;
      span = floatBashCard(stripped, index);
      shape = SHAPE_FLOAT;
    } else if (isPlainHead(row)) {
      candidates += 1;
      span = plainBashCard(stripped, index);
      shape = SHAPE_PLAIN;
    } else if (isNeonTop(row)) {
      candidates += 1;
      span = neonBashCard(stripped, index);
      shape = SHAPE_NEON;
    }
    if (span === undefined || shape === undefined) {
      index += 1;
      continue;
    }
    spans.push(span);
    shapes[shape] = (shapes[shape] ?? 0) + 1;
    index = span.end;
  }
  return { spans, candidates, shapes };
}

/**
 * Report this frame's counts (F1, F3). Guarded twice, because reporting is diagnostics: a bridge
 * older than the telemetry has no `report` at all, and a report that cannot be recorded must never
 * cost the conversation a frame.
 */
function reportCounts(ctx: TransformContextLike, counts: TransformCountsLike): void {
  if (typeof ctx.report !== "function") return;
  try {
    ctx.report(counts);
  } catch {
    // Counts are an instrument, not output: nothing here can change the frame.
  }
}

/** One bash card, drawn with this file's chrome. Never wider than the width it was given. */
function restyleBashCard(span: BashCardSpan, width: number): string[] {
  const rows = [`${BASH_GUTTER} ${BASH_TITLE}`];
  for (const text of span.body) rows.push(text === "" ? BASH_GUTTER : `${BASH_GUTTER} ${text}`);
  rows.push(BASH_GUTTER);
  return rows.map((row) => clipLine(row, width));
}

/**
 * The registration this file sends to `registerTransform`. The mode is read LIVE, once per frame, so
 * toggling it changes the cards already on screen on the host's next repaint — which is exactly what
 * a tool-renderer slot could never do. `default` returns the SAME array, so the bridge records the
 * frame as a pass-through and the host's card is untouched; a throw is swallowed here as well as in
 * the bridge, because a broken card must never cost the conversation.
 *
 * The frame is scanned in BOTH modes, once, and the counts reported from that same scan (F4):
 * recognition is what makes the toggle's behaviour measurable in a real TUI, and a scan that only
 * happened in `tool` mode would report nothing exactly when the report is needed. Rewriting is
 * counted separately from recognition, so "it saw the card and did not rewrite it" and "it saw
 * nothing" can never read the same.
 */
function bashCardTransform(store: BridgeStoreLike): TransformLike {
  return {
    id: BASH_TRANSFORM_ID,
    // After any transform another plugin leaves unordered; `order` only decides relative position
    // among the plugins that have one (`docs/contract.md` §13).
    order: 10,
    transform: (lines, ctx) => {
      try {
        const scan = scanBashCards(lines);
        const rewriting = readStoredMode(store) === MODE_TOOL;
        reportCounts(ctx, {
          candidates: scan.candidates,
          recognised: scan.spans.length,
          rewritten: rewriting ? scan.spans.length : 0,
          shapes: scan.shapes,
        });
        if (!rewriting || scan.spans.length === 0) return lines;

        const output: string[] = [];
        let cursor = 0;
        for (const span of scan.spans) {
          output.push(...lines.slice(cursor, span.start), ...restyleBashCard(span, ctx.width));
          cursor = span.end;
        }
        output.push(...lines.slice(cursor));
        return output;
      } catch {
        return lines;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the setting: one function, so the row and the transform can never disagree
// ---------------------------------------------------------------------------------------------

/**
 * The stored mode. Read live — by `current()` when the menu paints, and once per frame by the
 * transform — so a toggle takes effect on the next repaint with no reload. Anything unreadable or
 * unexpected reads as `default`, which never changes rendering.
 */
function readStoredMode(store: BridgeStoreLike | undefined): BashRenderingMode {
  if (store === undefined) return MODE_DEFAULT;
  try {
    return store.get<unknown>(SETTING_KEY, MODE_DEFAULT) === MODE_TOOL ? MODE_TOOL : MODE_DEFAULT;
  } catch {
    return MODE_DEFAULT;
  }
}

/**
 * Persist the mode. ONE writer for the `Cards` toggle's `action()` and the sidebar row's `onClick`,
 * so the two surfaces cannot drift: both write the same key, and both write it the same way.
 * A store that refuses the write leaves the mode where it was, which is what every read reports.
 */
function writeStoredMode(store: BridgeStoreLike, value: BashRenderingMode): void {
  try {
    store.set(SETTING_KEY, value);
  } catch {
    // Unwritable state is not a crash: the next read reports the mode that is still stored.
  }
}

/** The other mode: one click moves `default` ↔ `tool`, so a press always changes something. */
function nextMode(store: BridgeStoreLike): BashRenderingMode {
  return readStoredMode(store) === MODE_TOOL ? MODE_DEFAULT : MODE_TOOL;
}

// ---------------------------------------------------------------------------------------------
// Reaching gentle-shell-bridge: a runtime handshake, not a path
// ---------------------------------------------------------------------------------------------
//
// A Pi extension lives outside every package, so it cannot resolve a bare specifier, and an
// absolute path is not a contract between two independent projects: it names one checkout on one
// machine and breaks the day either project moves. So the bridge and the plugin meet on
// `globalThis`, the one channel Pi sanctions (`docs/extensions.md:1965-1972`), behind one stable
// symbol:
//
//   Symbol.for("gentle-shell-bridge/api/v1")  → the frozen, versioned API object
//
// Registration happens in this file's own `session_start` handler, AND on the bridge's
// announcement. Pi does not guarantee that the package loaded first: global extensions load and
// receive `session_start` before a configured package's module publishes, which is exactly the
// order the real TUI reported. So when the symbol is absent the example subscribes to
// `"gentle-shell-bridge:ready"` and registers when it fires; when the symbol is present there is
// nothing to wait for and no listener is taken. Each path calls the same guarded registration, so
// both happening leaves one of each surface.
//
// The constant and the gate MIRROR `src/api.ts` and are inlined on purpose: this file must not
// import the bridge, not even to say hello, and a copy-pasteable handshake is the smallest way to
// keep that promise. Keep them in sync — a breaking change is a new `v2` key, never a mutation of
// this one.

/** The published API object's key. */
const BRIDGE_API_KEY = Symbol.for("gentle-shell-bridge/api/v1");

/**
 * The channel the bridge announces itself on. The string MIRRORS `src/api.ts`
 * (`BRIDGE_READY_EVENT`): this file cannot import it, so the two are kept in sync by hand, the
 * same way the symbol key and the gate are.
 *
 * The announcement is a notification, never a registry: it says "the object is published now", and
 * this file reads the symbol again. That keeps one authority — the symbol and the shape gate — and
 * makes a bridge loaded after this file reachable at all.
 */
const BRIDGE_READY_EVENT = "gentle-shell-bridge:ready";

function bridgeHost(): Record<symbol, unknown> {
  // SAFETY: `globalThis` accepts symbol keys; every value read through this view is gated by
  // `isBridgeApi` before use.
  return globalThis as unknown as Record<symbol, unknown>;
}

/**
 * The shape gate: the schema string, `version === 1` and the three members this example calls.
 * Anything else — another library's object, a future major version, a partial object — is treated
 * as ABSENT, never as an error, exactly as the bridge's own `isBridgeApi` does.
 */
function isBridgeApi(value: unknown): value is BridgeApiLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema === "gentle-shell-bridge/api" &&
    candidate.version === 1 &&
    typeof candidate.registerRows === "function" &&
    typeof candidate.registerSection === "function" &&
    typeof candidate.createStore === "function"
  );
}

/**
 * The two notices for "no published object yet", which are honestly DIFFERENT states:
 *
 * - with a bus, the bridge may still load and announce itself, so the example is waiting and says
 *   what will register when the announcement arrives;
 * - without one, nothing can arrive in this process, so this load adds nothing and says that.
 *
 * Neither claims the bridge is not installed unless nothing can arrive: the old single notice did,
 * and it was the misleading part of the real defect.
 */
const NO_SIGNAL_NOTICE =
  "[bash-card] no compatible gentle-shell-bridge is installed, and this Pi has no cross-extension " +
  "event bus (`pi.events`) for one to announce itself on, so nothing can arrive later: this load " +
  "adds nothing — no Cards toggle, no BASH CARD sidebar section, no `plain` card style and no bash " +
  "transform. A slot that holds another object is treated as absent, never used.";

const WAITING_NOTICE =
  "[bash-card] no compatible gentle-shell-bridge API is published yet, so this load is waiting for " +
  "the \"gentle-shell-bridge:ready\" announcement the bridge emits when it publishes. If a bridge is " +
  "installed it registers the Cards toggle, the BASH CARD sidebar section, the `plain` card style " +
  "and the bash transform when the announcement arrives; if it is not installed, or the published " +
  "object is incompatible, nothing arrives and nothing registers. A slot that holds another object " +
  "is treated as absent, never used.";

// ---------------------------------------------------------------------------------------------
// The host's cross-extension bus: how a later bridge reaches this load
// ---------------------------------------------------------------------------------------------

/**
 * The host's event bus, when this Pi has one and it looks usable. Reading `pi.events` is guarded
 * because it is host state: a getter that throws must cost the announcement, not the load.
 */
function extensionEvents(pi: ExtensionApiLike): ExtensionEventsLike | undefined {
  let events: unknown;
  try {
    events = pi.events;
  } catch {
    return undefined;
  }
  if (typeof events !== "object" || events === null) return undefined;
  const candidate = events as { on?: unknown };
  return typeof candidate.on === "function" ? (candidate as ExtensionEventsLike) : undefined;
}

// ---------------------------------------------------------------------------------------------
// The in-TUI diagnostics channel
// ---------------------------------------------------------------------------------------------

/**
 * A message that must reach Pi's TUI but cannot yet: at module load no context exists. Notices are
 * NEVER printed — Pi renders its own diagnostics inside the TUI, and text written to the terminal
 * at startup lands outside the report the user reads.
 */
interface PendingNotice {
  message: string;
  /** Drop it once the surfaces register: "waiting" stops being true at that moment. */
  untilRegistered: boolean;
}

const pendingNotices: PendingNotice[] = [];
/** How many a session already showed; a delivered message is never delivered twice. */
let deliveredNotices = 0;

function recordNotice(message: string, options: { untilRegistered?: boolean } = {}): void {
  if (pendingNotices.some((entry) => entry.message === message)) return;
  pendingNotices.push({ message, untilRegistered: options.untilRegistered === true });
}

/**
 * Forget a notice a later registration made untrue. Already-delivered messages stay in the buffer
 * (so they are never shown twice); every other pending message keeps its order.
 */
function withdrawWaitingNotice(): void {
  const stillPending = pendingNotices
    .slice(deliveredNotices)
    .filter((entry) => !entry.untilRegistered);
  pendingNotices.length = deliveredNotices;
  pendingNotices.push(...stillPending);
}

/**
 * Deliver every pending notice through `ctx.ui.notify`. A context without a `notify` delivers
 * nothing, and a `notify` that throws leaves the remaining messages pending for the next session.
 * `settled` means the surfaces are registered, so a "waiting" notice must not be shown.
 */
function flushNotices(ui: unknown, settled: boolean): void {
  const surface = typeof ui === "object" && ui !== null ? (ui as NoticeUiLike) : undefined;
  const notify = surface?.notify;
  if (typeof notify !== "function") return;
  if (settled) withdrawWaitingNotice();
  while (deliveredNotices < pendingNotices.length) {
    try {
      notify.call(surface, pendingNotices[deliveredNotices].message, "warning");
    } catch {
      return;
    }
    deliveredNotices += 1;
  }
}

// ---------------------------------------------------------------------------------------------
// The toggle rows
// ---------------------------------------------------------------------------------------------

/** A toggle is two CONSECUTIVE rows sharing `choice.setting`; nothing may sit between them. */
function bashRenderingRows(store: BridgeStoreLike): CustomizeRowLike[] {
  return [renderingRow(store, MODE_DEFAULT), renderingRow(store, MODE_TOOL)];
}

/**
 * One short line per mode. The renderer prints it as `Preview · <title>` above the sample
 * (`lib/visual-customize-view.ts:745`).
 */
const PREVIEW_TITLE: Record<BashRenderingMode, string> = {
  [MODE_DEFAULT]: "Host's own bash rendering",
  [MODE_TOOL]: "Example-drawn bash card",
};

/**
 * A literal depiction of what a bash card looks like in that mode — the card, not prose about it.
 * The renderer splits `sample` on newlines and paints each line under the headline
 * (`lib/visual-customize-view.ts:747-750`), so lines stay well under 40 columns and there are only
 * a handful of them.
 */
const PREVIEW_SAMPLE: Record<BashRenderingMode, string> = {
  [MODE_DEFAULT]: ["$ ls -1", "README.md", "package.json"].join("\n"),
  [MODE_TOOL]: ["▸ bash", "▸ ls -1", "▸"].join("\n"),
};

function previewFor(value: BashRenderingMode): { title: string; sample: string } {
  return { title: PREVIEW_TITLE[value], sample: PREVIEW_SAMPLE[value] };
}

function renderingRow(store: BridgeStoreLike, value: BashRenderingMode): CustomizeRowLike {
  return {
    category: ROW_CATEGORY,
    label: ROW_LABEL,
    choice: {
      setting: SETTING_NAME,
      value,
      // Live read at render time, so the bullet matches the file before the user touches it.
      current: () => readStoredMode(store) === value,
    },
    // Carried by the bridge untouched; the renderer draws it below the focused choice instead of
    // "Preview unavailable".
    preview: () => previewFor(value),
    // Persist first, repaint second: the view repaints after `action` returns and that repaint
    // re-evaluates `current()`, which reads this same value (`docs/state.md`, "The correctness
    // rule"). The transform reads the same value on the next conversation frame, which is how
    // cards already on screen change look instead of keeping the one they were built with.
    action: () => {
      writeStoredMode(store, value);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The sidebar section
// ---------------------------------------------------------------------------------------------

/** Stable across loads, so `/reload` replaces this section instead of stacking it (S1, S2). */
const SECTION_ID = "bash-card.status";
/** The card heading, drawn by the host's own frame like `AGENTS` / `STATS`. */
const SECTION_TITLE = "BASH CARD";
/**
 * What the `Sections` toggle reads. Passed explicitly: the bridge derives `bash card` from the title
 * anyway, but a reader should copy a label, never the dotted id above.
 */
const SECTION_ROW_LABEL = "bash card";

/**
 * Live state for the card: the mode the user chose, and whether this load really registered its
 * transform. A function rather than a boolean, so the line stays honest if registration came later
 * than this section's creation.
 */
function bashCardSection(
  store: BridgeStoreLike,
  transformRegistered: () => boolean,
): SidebarSectionLike {
  return {
    id: SECTION_ID,
    title: SECTION_TITLE,
    // The row label, not the id: the menu reads `bash card  ● shown  ○ hidden`, next to the host's
    // own `stats` / `agents` lines.
    rowLabel: SECTION_ROW_LABEL,
    // The right-aligned count: the same value the `Cards` toggle writes, so the two surfaces
    // cannot disagree. Read per frame, which is what makes it LIVE (N14): clicking the row below
    // changes it and the host repaints without this section re-registering.
    meta: () => readStoredMode(store),
    lines: () => [
      // A structured row (N10–N12): the icon, the label and the value in the dimmer secondary
      // column, and `onClick` — which is the ONLY thing that makes a row clickable. Pressing it
      // flips the mode through the same store the `Cards` toggle writes, so the visible effect is
      // the header's count, this row's meta and the next conversation frame.
      {
        glyph: readStoredMode(store) === MODE_TOOL ? "◉" : "○",
        label: "rendering",
        meta: readStoredMode(store),
        tone: readStoredMode(store) === MODE_TOOL ? "accent" : "muted",
        onClick: () => writeStoredMode(store, nextMode(store)),
      },
      // No `onClick`: inert on purpose. It reports a fact the plugin cannot change at runtime, so a
      // click on it does nothing, exactly as a host row without an action does.
      `transform  ${transformRegistered() ? "registered" : "absent"}`,
    ],
    // Visible on install: a section needs no extra step from the plugin or the user (S1).
    defaultVisible: true,
    // After any section the host or another plugin leaves unordered; the host's own parts come
    // first regardless (S3).
    order: 20,
  };
}

// ---------------------------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------------------------

export default function bashCardExample(pi: ExtensionApiLike): () => void {
  // Holds the store once it exists, and whether the transform surface was there at registration.
  // `undefined`/`false` means the bridge is not (fully) here yet: every read then reports `default`,
  // so bash rendering is untouched.
  const state: { store?: BridgeStoreLike; transformRegistered: boolean } = {
    transformRegistered: false,
  };

  const disposers: Array<() => void> = [];
  let closed = false;
  let bridgeRegistered = false;
  // The bus this Pi offers, when it offers one: the only channel a later-loading bridge can use.
  const events = extensionEvents(pi);
  let unsubscribeReady: EventUnsubscribe | undefined;

  /** Stop listening for the announcement. Anything that throws here cannot cost the load. */
  const stopListening = (): void => {
    const off = unsubscribeReady;
    unsubscribeReady = undefined;
    if (off === undefined) return;
    try {
      off();
    } catch {
      // A disposer that throws cannot resurrect the subscription.
    }
  };

  /** Every surface belongs to one registration lifetime: disposing must not leave half of them. */
  const dispose = (): void => {
    closed = true;
    stopListening();
    for (const registered of disposers.splice(0, disposers.length)) {
      try {
        registered();
      } catch {
        // A disposer that throws must not strand the others.
      }
    }
  };

  /** Register the bridge surfaces once. A stable id each, so a `/reload` replaces, not stacks. */
  const registerWithBridge = (api: BridgeApiLike): void => {
    if (closed || bridgeRegistered) return;

    let store: BridgeStoreLike;
    try {
      store = api.createStore(PLUGIN_ID);
    } catch (error) {
      recordNotice(
        `[bash-card] could not open the bridge store for "${PLUGIN_ID}": ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    state.store = store;

    disposers.push(
      api.registerRows({
        id: "bash-card-example.rendering",
        category: ROW_CATEGORY,
        // The first registration names the plugin, so its one INTEGRATIONS row reads `Bash card`
        // even when this file is a copied single extension with no `package.json` above it. The
        // name is STICKY for this plugin's identity: the section, style and transform below inherit
        // it, and none of them can rename the row (a different name would be reported as a
        // conflict).
        name: "Bash card",
        rows: () => bashRenderingRows(store),
      }),
      api.registerSection(bashCardSection(store, () => state.transformRegistered)),
    );

    // The style and the transform are optional by contract: an object published by an older copy
    // passes the gate without them. Absent means "register the other surfaces and stay quiet" — no
    // queue, no repeated notice, and no invented fallback for a surface the bridge does not have.
    const registerCardStyle = api.registerCardStyle;
    if (typeof registerCardStyle === "function") {
      disposers.push(registerCardStyle.call(api, bashCardStyle()));
    }

    const registerTransform = api.registerTransform;
    if (typeof registerTransform === "function") {
      disposers.push(registerTransform.call(api, bashCardTransform(store)));
      state.transformRegistered = true;
    }

    bridgeRegistered = true;
  };

  /**
   * Register through the published object, if there is one. Three outcomes, because "absent" and
   * "present but unusable" need different notices: the store is the one registration that can fail
   * while the API is right there.
   */
  const tryRegister = (): "registered" | "absent" | "failed" => {
    if (closed || bridgeRegistered) return "registered";
    const published = bridgeHost()[BRIDGE_API_KEY];
    if (!isBridgeApi(published)) return "absent";
    registerWithBridge(published);
    return bridgeRegistered ? "registered" : "failed";
  };

  /**
   * The bridge published after this file loaded: the defect's fix. Registration is the same guarded
   * call `session_start` makes, so an announcement and a later session cannot both register, and a
   * "waiting" notice the user has not seen yet is withdrawn because it is no longer true.
   */
  const onBridgeReady = (): void => {
    // The announcement only says "look again": the symbol is the authority. An emit that is not
    // backed by a usable slot changes nothing, and this load keeps waiting for the real one.
    if (tryRegister() === "absent") return;
    withdrawWaitingNotice();
    stopListening();
  };

  // The symbol first. If the bridge loaded before this file there is nothing to wait for, so no
  // listener is taken at all (no leak on every load, no event that never comes). Otherwise the
  // announcement is the only way a later bridge can be heard.
  if (events !== undefined && !isBridgeApi(bridgeHost()[BRIDGE_API_KEY])) {
    try {
      const off = events.on(BRIDGE_READY_EVENT, onBridgeReady);
      if (typeof off === "function") unsubscribeReady = off;
    } catch {
      // No subscription: the `session_start` attempt below still tries the symbol.
    }
  }

  // Pi renders diagnostics inside the TUI, so every message this example produces is delivered
  // there — never on stdout/stderr — and the handler does nothing when the context has no UI.
  //
  // Registration is attempted here too, because a bridge that loaded before this file is already
  // published and waiting for an announcement that will never come would be pure delay.
  const onSessionStart = (_event: unknown, ctx: SessionContextLike): void => {
    if (closed || ctx.hasUI !== true) return;

    if (tryRegister() === "absent") {
      // Two honest states: with a bus the bridge may still announce itself, without one nothing can
      // arrive in this process. The notice says which, and the waiting one is withdrawn if it
      // happens to register before the next session shows it.
      if (events === undefined) recordNotice(NO_SIGNAL_NOTICE);
      else recordNotice(WAITING_NOTICE, { untilRegistered: true });
    }

    flushNotices(ctx.ui, bridgeRegistered);
  };
  if (typeof pi.on === "function") pi.on("session_start", onSessionStart);

  // Nothing depends on this return value — the stable ids are what make a `/reload` replace rather
  // than stack — it exists so a programmatic caller can tear every surface down together, and it
  // drops the announcement listener with them.
  return dispose;
}
