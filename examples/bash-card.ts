/**
 * Worked consumer of `gentle-shell-bridge`: ONE Pi extension that demonstrates every surface the
 * package publishes — a row toggle, a sidebar section, a card style and a transcript transform.
 *
 * A. The bash rendering — through the bridge, as a TRANSFORM. `registerTransform` receives the
 *    conversation's rows on EVERY frame and returns the rows to draw, so the toggle below restyles
 *    the bash cards that are already on screen, not only the ones built after the switch. That is
 *    the whole point: `pi.registerToolRenderer` resolves once, when a tool row is BUILT, so a
 *    rendering choice made there can never reach history — the defect this file used to document
 *    instead of fixing. The transform recognises a bash card by what the host already produced (a
 *    `float` card whose heading is `bash`) and rewrites it with this file's chrome:
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
 * D. The card style — through the bridge as well. `registerCardStyle` adds one value, `plain`, to
 *    the `Card style` line `/gentle:customize` already draws: `○ neon ○ float ○ plain`. Choosing it
 *    makes the bridge repaint every conversation card the host drew with this file's frame — a
 *    single gutter character per row, the heading as plain text, no box — and choosing `neon` or
 *    `float` puts the host's own rendering back. It is a style for TOOL cards in general: a `read`
 *    card is repainted exactly like a `bash` one. Nothing here parses a card: the bridge measures,
 *    extracts the heading and the hint, and hands them over.
 *
 * A bridge that publishes an incompatible API is treated as absent: B, C, D and A register nothing
 * and the example says so once through `ctx.ui.notify`. A bridge that publishes the row and section
 * surfaces but not `registerCardStyle` (an older object) keeps B and C on the line and skips D
 * silently: the member is optional, and this file must not warn about a surface the bridge never
 * promised. The same rule applies to `registerTransform`: absent means "keep the other surfaces and
 * stay quiet", and the section says `transform  absent` instead.
 *
 * Loading: copy this file into `~/.pi/agent/extensions/` (or point Pi's `packages` entry at this
 * repository) and `/reload`. The toggle defaults to `default`, so installing the example changes
 * no rendering until the user asks for it.
 *
 * Reaching the bridge needs no path, no environment variable and no import: the file and the
 * bridge meet on `globalThis` behind one `Symbol.for` key (see "Reaching gentle-shell-bridge"
 * below). The example registers inside its own `pi.on("session_start", ...)` handler, which is the
 * moment the symbol's presence is the complete answer: Pi finishes loading every module before it
 * fires that event, so the bridge either published already or is not installed.
 *
 * Diagnostics stay inside Pi: nothing here writes to stdout/stderr. A message (no bridge) is
 * buffered and delivered through `ctx.ui.notify` on `session_start`, which is the only channel Pi
 * renders in its own report.
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
 * Row text. A toggle's bullets show the raw `value`s, and the setting name is namespaced with the
 * plugin name, which makes a collision with another provider's row impossible by construction
 * (`docs/contract.md` §4 and §6).
 */
const ROW_LABEL = "Bash card: rendering";
const SETTING_NAME = "Bash card → Bash rendering";
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
  rows(ctx: { theme: unknown; configHome: string }): CustomizeRowLike[];
}

/**
 * The section contract (`docs/contract.md` §11), structural like every host shape here. A section
 * writes content only: no `choice`, no `action`, no `preview` — the bridge contributes the toggle.
 */
interface SidebarSectionLike {
  id: string;
  title: string;
  meta?(ctx: { theme: unknown; configHome: string }): string | undefined;
  lines(ctx: { theme: unknown; configHome: string }): string[];
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
  order?: number;
  frame: {
    top(ctx: CardFrameTopContextLike): string;
    line(ctx: CardFrameLineContextLike): string;
    bottom(ctx: CardFrameBottomContextLike): string;
  };
  preview?(): { title: string; sample: string };
}

/**
 * What a transform receives on every frame (`src/types.ts`, `TransformContext`): the width the host
 * rendered the conversation at, which is also the widest row it may return — the bridge clips
 * anything wider before the frame reaches the screen.
 */
interface TransformContextLike {
  width: number;
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
// its target the way the bridge recognises a card: by the host's own frame. Two shapes are accepted,
// because the pipeline runs AFTER the card-style repaint:
//
// 1. the host's `float` card — one-column margin, the `▎` bar, then padding / header / separator /
//    body / padding (`docs/contract.md` §12, `src/card-styles.ts` §2), with the heading `bash`;
// 2. this file's own `plain` frame — `▌ bash` plus `▌` rows — so `tool` still wins when `plain`
//    is the selected card style, instead of leaving one bash card in two frames at once.

/** The example's own chrome: a gutter no other surface in this file uses. */
const BASH_GUTTER = "▸";
/** The heading the host prints for a bash card. */
const BASH_TITLE = "bash";
/** Stable across loads and unique in `/bridge-status`: `/reload` replaces it in place. */
const BASH_TRANSFORM_ID = "bash-card-example.bash-cards";
/** The accent bar every `float` row starts with, one column in from the margin. */
const FLOAT_BAR = "▎";

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

/** This file's `plain` card style's bash card at `start`, when one starts there. */
function plainBashCard(stripped: readonly string[], start: number): BashCardSpan | undefined {
  if (!new RegExp(`^${CARD_STYLE_GUTTER} ${BASH_TITLE}(?:\\s|$)`, "u").test(stripped[start] ?? "")) {
    return undefined;
  }
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
 * Every bash card in the frame, in order. Rows a card already claimed are skipped, so a body row can
 * never be read as the head of the next card.
 */
function bashCardSpans(lines: readonly string[]): BashCardSpan[] {
  const stripped = lines.map((line) => plainText(line));
  const spans: BashCardSpan[] = [];
  let index = 0;
  while (index < stripped.length) {
    const span = floatBashCard(stripped, index) ?? plainBashCard(stripped, index);
    if (span === undefined) {
      index += 1;
      continue;
    }
    spans.push(span);
    index = span.end;
  }
  return spans;
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
 */
function bashCardTransform(store: BridgeStoreLike): TransformLike {
  return {
    id: BASH_TRANSFORM_ID,
    // After any transform another plugin leaves unordered; `order` only decides relative position
    // among the plugins that have one (`docs/contract.md` §13).
    order: 10,
    transform: (lines, ctx) => {
      try {
        if (readStoredMode(store) !== MODE_TOOL) return lines;
        const spans = bashCardSpans(lines);
        if (spans.length === 0) return lines;

        const output: string[] = [];
        let cursor = 0;
        for (const span of spans) {
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
// Registration happens in this file's own `session_start` handler. Pi completes every extension's
// async initialization before firing that event (`docs/extensions.md:213`), and the bridge
// publishes as its module loads, so the handler either finds the object or knows the bridge is not
// installed. There is nothing to wait for and nowhere to defer a registration.
//
// The constant and the gate MIRROR `src/api.ts` and are inlined on purpose: this file must not
// import the bridge, not even to say hello, and a copy-pasteable handshake is the smallest way to
// keep that promise. Keep them in sync — a breaking change is a new `v2` key, never a mutation of
// this one.

/** The published API object's key. */
const BRIDGE_API_KEY = Symbol.for("gentle-shell-bridge/api/v1");

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

/** The one notice when this load has nowhere to register: the bridge is absent, full stop. */
const NO_BRIDGE_NOTICE =
  "[bash-card] no compatible gentle-shell-bridge is installed, so this load adds nothing: no " +
  "Cards toggle, no BASH CARD sidebar section, no `plain` card style and no bash transform. A " +
  "slot that holds another object is treated as absent, never used.";

// ---------------------------------------------------------------------------------------------
// The in-TUI diagnostics channel
// ---------------------------------------------------------------------------------------------

/**
 * Messages that must reach Pi's TUI but cannot yet: at module load no context exists. They are
 * NEVER printed — Pi renders its own diagnostics inside the TUI, and text written to the terminal
 * at startup lands outside the report the user reads.
 */
const pendingNotices: string[] = [];
/** How many a session already showed; a delivered message is never delivered twice. */
let deliveredNotices = 0;

function recordNotice(message: string): void {
  if (!pendingNotices.includes(message)) pendingNotices.push(message);
}

/**
 * Deliver every pending notice through `ctx.ui.notify`. A context without a `notify` delivers
 * nothing, and a `notify` that throws leaves the remaining messages pending for the next session.
 */
function flushNotices(ui: unknown): void {
  const surface = typeof ui === "object" && ui !== null ? (ui as NoticeUiLike) : undefined;
  const notify = surface?.notify;
  if (typeof notify !== "function") return;
  while (deliveredNotices < pendingNotices.length) {
    try {
      notify.call(surface, pendingNotices[deliveredNotices], "warning");
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
      store.set(SETTING_KEY, value);
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
    // The right-aligned count: the same value the `Cards` toggle writes, so the two surfaces
    // cannot disagree.
    meta: () => readStoredMode(store),
    lines: () => [
      `rendering  ${readStoredMode(store)}`,
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

  /** Every surface belongs to one registration lifetime: disposing must not leave half of them. */
  const dispose = (): void => {
    closed = true;
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

  // Pi renders diagnostics inside the TUI, so every message this example produces is delivered
  // there — never on stdout/stderr — and the handler does nothing when the context has no UI.
  //
  // Registration happens here, not at module load: by `session_start` every extension module has
  // loaded, so the symbol's presence is the complete answer. Absent means "not installed" (or an
  // incompatible version); there is nothing to wait for, so the example says so once and returns.
  const onSessionStart = (_event: unknown, ctx: SessionContextLike): void => {
    if (closed || ctx.hasUI !== true) return;

    if (!bridgeRegistered) {
      const published = bridgeHost()[BRIDGE_API_KEY];
      if (isBridgeApi(published)) registerWithBridge(published);
      else recordNotice(NO_BRIDGE_NOTICE);
    }

    flushNotices(ctx.ui);
  };
  if (typeof pi.on === "function") pi.on("session_start", onSessionStart);

  // Nothing depends on this return value — the stable ids are what make a `/reload` replace rather
  // than stack — it exists so a programmatic caller can tear every surface down together.
  return dispose;
}
