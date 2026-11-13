/**
 * Worked consumer of `gentle-shell-bridge`: ONE Pi extension that demonstrates both surfaces the
 * package sits between.
 *
 * A. Its own bash rendering — pure Pi, no bridge. `pi.registerToolRenderer` offers this extension
 *    the chance to draw `bash` calls itself. It only takes the offer while the toggle below
 *    selects `tool`; on `default` it returns `next()` untouched, so gentle-shell's or Pi's own
 *    rendering applies and no second frame is drawn around it.
 *
 * B. The toggle row — through the bridge. `registerRows` contributes two consecutive `Cards` rows
 *    sharing one `choice.setting`, and `createStore("bash-card-example")` persists the choice, so
 *    the row and the renderer read the same value.
 *
 * C. The sidebar section — through the bridge too. `registerSection` adds a `BASH CARD` card to
 *    gentle-shell's fullscreen sidebar, drawn by the host's own frame, whose body reports the mode
 *    and whether this load actually wired the bash renderer. The same registration gives it a
 *    `Sections` toggle in `/gentle:customize`, so the card can be hidden without the plugin writing
 *    a row, a setting or a store for it. An older package without `registerSection` still gets A and
 *    B: the section is skipped with one warning.
 *
 * Loading: copy this file into `~/.pi/agent/extensions/` (or point Pi's `packages` entry at this
 * repository) and `/reload`. The toggle defaults to `default`, so installing the example changes
 * no rendering until the user asks for it.
 *
 * Stale rows: the choice is read when a bash row is BUILT, not per frame, so switching it applies
 * to the next bash call. Rows already on screen keep the rendering they were built with; `Esc` or
 * scrolling does not re-render history. Pi exposes no extension API that repaints already-drawn
 * tool rows — `tui.requestRender()` is injected into a component created through `ctx.ui.custom`,
 * not into a customize-row `action()` — so the example documents this instead of inventing one.
 *
 * Nothing here imports `@earendil-works/pi-coding-agent` or `@earendil-works/pi-tui`: this
 * repository depends on neither, so every host shape this file touches is declared structurally
 * below, the way `src/extension.ts` declares the extension API it uses. The renderer returns plain
 * strings, which is all a `Component` is required to do.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------------------------
// The one value both surfaces agree on
// ---------------------------------------------------------------------------------------------

/** Store file: `<gentle config home>/gentle-shell-bridge/bash-card-example.json`. */
const PLUGIN_ID = "bash-card-example";
/** The single setting key, read by the renderer resolver and by the row's `current()`. */
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

/** Command rows a collapsed card may spend, so a huge heredoc cannot fill the transcript. */
const COMMAND_LINE_LIMIT = 6;
/** Columns of indent on a command row that continues below the `bash $ ` head. */
const CONTINUATION_INDENT = 2;
/** Result rows a collapsed card keeps. */
const RESULT_LINE_LIMIT = 8;
/** Result rows an expanded card keeps; still capped, only less tightly. */
const RESULT_EXPANDED_LINE_LIMIT = 40;

// ---------------------------------------------------------------------------------------------
// Host shapes, declared structurally
// ---------------------------------------------------------------------------------------------

/** `docs/extensions.md`: a renderer slot returns a Component. */
interface ComponentLike {
  render(width: number): string[];
  invalidate(): void;
}

/** The part of Pi's theme this file paints with. */
interface ThemeLike {
  fg?(color: string, text: string): string;
  bold?(text: string): string;
}

/** The part of the render context this file reads (`docs/extensions.md`, "Custom Rendering"). */
interface RenderContextLike {
  /** The component this slot returned last frame, so one instance can own one frame cache. */
  lastComponent?: unknown;
  /** Current call arguments; read them here instead of copying them into `context.state`. */
  args?: unknown;
  expanded?: boolean;
  isPartial?: boolean;
  isError?: boolean;
}

/** The second argument of a `renderResult` slot. */
interface RenderOptionsLike {
  expanded?: boolean;
  isPartial?: boolean;
}

type RenderCallLike = (args: unknown, theme: ThemeLike, context?: RenderContextLike) => ComponentLike;
type RenderResultLike = (result: unknown, options: RenderOptionsLike, theme: ThemeLike, context?: RenderContextLike) => ComponentLike;

/**
 * The renderer set Pi resolves for one tool. `next()` returns this, and this example passes it
 * straight back untouched when it is not drawing the card itself.
 */
interface RendererSetLike {
  renderShell?: "self" | "default";
  renderCall?: RenderCallLike;
  renderResult?: RenderResultLike;
}

type ToolRendererResolverLike = (toolName: string, next: () => RendererSetLike | undefined) => RendererSetLike | undefined;

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
 * The section contract (`docs/contract.md` §10), structural like every host shape here. A section
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

/** The exports of `gentle-shell-bridge` this example uses (`docs/contract.md`, Limits). */
interface BridgeModuleLike {
  registerRows(provider: RowProviderLike): () => void;
  createStore(pluginId: string): BridgeStoreLike;
  /**
   * Added with the sidebar surface (0.1.0), so it is OPTIONAL here: an installed package may
   * predate it, and the example must keep the row side working on such an install.
   */
  registerSection?(section: SidebarSectionLike): () => void;
}

/** The part of `ExtensionAPI` this extension uses. */
interface ExtensionApiLike {
  registerToolRenderer?(resolver: ToolRendererResolverLike): void;
}

// ---------------------------------------------------------------------------------------------
// Text layout: width is the only budget a Component gets
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

/**
 * Breaks text into rows, preferring spaces. The first row gets `firstRoom`, every later row
 * `restRoom`. Clipping a command would lose it in a narrow terminal, so the command wraps instead
 * and every column stays readable.
 */
function flowRows(text: string, firstRoom: number, restRoom: number): string[] {
  const rooms = [Math.max(1, firstRoom), Math.max(1, restRoom)];
  const rows: string[] = [];
  let atFirstRow = true;
  for (const paragraph of text.split("\n")) {
    let rest = paragraph;
    if (rest === "") {
      rows.push("");
      atFirstRow = false;
      continue;
    }
    while (visibleWidth(rest) > rooms[atFirstRow ? 0 : 1]) {
      const room = rooms[atFirstRow ? 0 : 1];
      const characters = Array.from(rest);
      const slice = characters.slice(0, room).join("");
      const space = slice.lastIndexOf(" ");
      const cut = space > 0 ? space : room;
      rows.push(characters.slice(0, cut).join("").replace(/\s+$/, ""));
      rest = characters.slice(cut).join("").replace(/^\s+/, "");
      atFirstRow = false;
    }
    rows.push(rest);
    atFirstRow = false;
  }
  return rows;
}

/** Paint one line; a theme without the colour, or one that throws, leaves the text as it is. */
function paint(theme: ThemeLike, color: string, text: string): string {
  try {
    const fg = theme?.fg;
    return typeof fg === "function" ? fg.call(theme, color, text) : text;
  } catch {
    return text;
  }
}

function emphasise(theme: ThemeLike, text: string): string {
  try {
    const bold = theme?.bold;
    return typeof bold === "function" ? bold.call(theme, text) : text;
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------------------------
// Components. Every `render` is total: a shape it cannot draw degrades to one plain line instead
// of throwing into Pi's frame loop.
// ---------------------------------------------------------------------------------------------

/**
 * One unremarkable line, optionally painted. The degrade path for a shape this example cannot
 * draw, and an empty body for a slot with nothing safe to show.
 */
class PlainLine implements ComponentLike {
  private readonly text: string;
  private readonly theme: ThemeLike;
  private readonly color: string | undefined;

  constructor(text: string, theme: ThemeLike, color?: string) {
    this.text = text;
    this.theme = theme;
    this.color = color;
  }

  render(width: number): string[] {
    try {
      if (width <= 0 || this.text === "") return [];
      const line = clipLine(this.text, width);
      return [this.color === undefined ? line : paint(this.theme, this.color, line)];
    } catch {
      return [];
    }
  }

  invalidate(): void {}
}

/**
 * The call slot: `bash $ <command>` on the first row, the rest of the command indented below it.
 * The frame cache is slot-local and lives on this instance, which is what the docs recommend
 * (`docs/extensions.md`: "Keep slot-local caches on the returned component instance").
 */
class BashCallCard implements ComponentLike {
  private command: string;
  private theme: ThemeLike;
  private frame: { width: number; command: string; theme: ThemeLike; lines: string[] } | undefined;

  constructor(command: string, theme: ThemeLike) {
    this.command = command;
    this.theme = theme;
  }

  /** Update the instance Pi handed back through `context.lastComponent` instead of rebuilding it. */
  update(command: string, theme: ThemeLike): void {
    if (command === this.command && theme === this.theme) return;
    this.command = command;
    this.theme = theme;
    this.frame = undefined;
  }

  invalidate(): void {
    this.frame = undefined;
  }

  render(width: number): string[] {
    try {
      const target = Math.max(0, Math.floor(width));
      if (target === 0) return [];
      const cached = this.frame;
      if (
        cached !== undefined &&
        cached.width === target &&
        cached.command === this.command &&
        cached.theme === this.theme
      ) {
        return cached.lines;
      }
      const lines = this.build(target);
      this.frame = { width: target, command: this.command, theme: this.theme, lines };
      return lines;
    } catch {
      // Never break the frame loop over a card that cannot be drawn.
      return ["bash"];
    }
  }

  private build(width: number): string[] {
    const title = emphasise(this.theme, clipLine("bash", width));
    const command = this.command.replace(/\s+$/, "");
    if (command === "") return [title];

    const head = `${title} ${paint(this.theme, "muted", "$")}`;
    const headWidth = visibleWidth(head) + 1; // the single space before the command
    const restRoom = Math.max(1, width - CONTINUATION_INDENT);
    const headRoom = width - headWidth;
    // The head row keeps the command for as long as one column of it fits there; any narrower
    // and the prompt takes the row alone, because half a command behind it says less.
    const shareHead = headRoom >= 1;

    let rows = shareHead
      ? flowRows(command, headRoom, restRoom)
      : flowRows(command, restRoom, restRoom);
    if (rows.length > COMMAND_LINE_LIMIT) {
      const kept = rows.slice(0, COMMAND_LINE_LIMIT - 1);
      const folded = rows.length - kept.length;
      rows = [...kept, `… +${folded} more line${folded === 1 ? "" : "s"}`];
    }

    // Clipped, not wrapped: a continuation row is already the wrap, and the fold marker can be
    // wider than the room it has.
    const indent = (row: string): string => paint(this.theme, "dim", clipLine(`${" ".repeat(CONTINUATION_INDENT)}${row}`, width));
    if (!shareHead) {
      return [clipLine(head, width), ...rows.map(indent)];
    }
    const [first, ...rest] = rows;
    if (first === "") return [clipLine(head, width), ...rest.map(indent)];
    return [`${head} ${paint(this.theme, "toolOutput", clipLine(first, headRoom))}`, ...rest.map(indent)];
  }
}

/**
 * The result slot: the body follows the call, width-clipped and height-capped. Collapsed keeps the
 * tail, because the end of bash output is the part that answers the command.
 */
class BashResultCard implements ComponentLike {
  private text: string;
  private expanded: boolean;
  private isPartial: boolean;
  private isError: boolean;
  private theme: ThemeLike;
  private frame:
    | { width: number; text: string; expanded: boolean; isPartial: boolean; isError: boolean; theme: ThemeLike; lines: string[] }
    | undefined;

  constructor(text: string, options: RenderOptionsLike, context: RenderContextLike | undefined, theme: ThemeLike) {
    this.text = text;
    this.expanded = options.expanded === true || context?.expanded === true;
    this.isPartial = options.isPartial === true || context?.isPartial === true;
    this.isError = context?.isError === true;
    this.theme = theme;
  }

  update(text: string, options: RenderOptionsLike, context: RenderContextLike | undefined, theme: ThemeLike): void {
    const expanded = options.expanded === true || context?.expanded === true;
    const isPartial = options.isPartial === true || context?.isPartial === true;
    const isError = context?.isError === true;
    if (
      text === this.text &&
      expanded === this.expanded &&
      isPartial === this.isPartial &&
      isError === this.isError &&
      theme === this.theme
    ) {
      return;
    }
    this.text = text;
    this.expanded = expanded;
    this.isPartial = isPartial;
    this.isError = isError;
    this.theme = theme;
    this.frame = undefined;
  }

  invalidate(): void {
    this.frame = undefined;
  }

  render(width: number): string[] {
    try {
      const target = Math.max(0, Math.floor(width));
      if (target === 0) return [];
      const cached = this.frame;
      if (
        cached !== undefined &&
        cached.width === target &&
        cached.text === this.text &&
        cached.expanded === this.expanded &&
        cached.isPartial === this.isPartial &&
        cached.isError === this.isError &&
        cached.theme === this.theme
      ) {
        return cached.lines;
      }
      const lines = this.build(target);
      this.frame = {
        width: target,
        text: this.text,
        expanded: this.expanded,
        isPartial: this.isPartial,
        isError: this.isError,
        theme: this.theme,
        lines,
      };
      return lines;
    } catch {
      // An unreadable result renders as no body at all, never as a broken frame.
      return [];
    }
  }

  private build(width: number): string[] {
    const body = this.text.replace(/\s+$/, "");
    const all = body === "" ? [] : body.split("\n");
    const limit = this.expanded ? RESULT_EXPANDED_LINE_LIMIT : RESULT_LINE_LIMIT;
    const markers = this.isPartial ? 1 : 0;
    let rows = all.slice(-Math.max(1, limit - markers));
    if (all.length > rows.length) rows = all.slice(-Math.max(1, limit - markers - 1));
    const hidden = all.length - rows.length;

    const lines: string[] = [];
    if (this.isPartial) lines.push(paint(this.theme, "warning", clipLine("… bash", width)));
    if (hidden > 0) {
      const noun = hidden === 1 ? "earlier line" : "earlier lines";
      lines.push(paint(this.theme, "dim", clipLine(`… +${hidden} ${noun}`, width)));
    }
    const color = this.isError ? "error" : "toolOutput";
    for (const row of rows) lines.push(paint(this.theme, color, clipLine(row, width)));
    return lines;
  }
}

// ---------------------------------------------------------------------------------------------
// The bash slot renderers
// ---------------------------------------------------------------------------------------------

/** The command a bash call carries, or `undefined` for any shape that is not a bash call. */
function commandOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

/** Text of a tool result, with SGR sequences and control bytes removed (this card paints its own). */
function resultText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") continue;
    parts.push(record.text.replace(ANSI_SEQUENCE, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""));
  }
  return parts.join("\n");
}

function bashRenderCall(
  args: unknown,
  renderTheme: ThemeLike,
  context?: RenderContextLike,
): ComponentLike {
  try {
    const command = commandOf(args);
    // A malformed call degrades to one plain command line instead of a half-drawn card.
    if (command === undefined) return new PlainLine("bash", renderTheme, "toolTitle");
    const previous = context?.lastComponent;
    if (previous instanceof BashCallCard) {
      previous.update(command, renderTheme);
      return previous;
    }
    return new BashCallCard(command, renderTheme);
  } catch {
    return new PlainLine("bash", renderTheme, "toolTitle");
  }
}

function bashRenderResult(
  result: unknown,
  options: RenderOptionsLike,
  renderTheme: ThemeLike,
  context?: RenderContextLike,
): ComponentLike {
  try {
    const text = resultText(result);
    const previous = context?.lastComponent;
    if (previous instanceof BashResultCard) {
      previous.update(text, options, context, renderTheme);
      return previous;
    }
    return new BashResultCard(text, options, context, renderTheme);
  } catch {
    return new PlainLine("", renderTheme);
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the setting: one function, so the row and the renderer can never disagree
// ---------------------------------------------------------------------------------------------

/**
 * The stored mode. Read live — by `current()` when the menu paints, and once per resolver call by
 * the bash resolver — so a toggle takes effect on the next row built with no reload. Anything
 * unreadable or unexpected reads as `default`, which never changes rendering.
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
// Resolving `gentle-shell-bridge`. An extension file lives outside the package, so probe it.
// ---------------------------------------------------------------------------------------------

/**
 * Specifiers to try, most portable first. Proven on this machine: the bare specifier does NOT
 * resolve from `~/.pi/agent/extensions/` (no node_modules on that path), while a checkout's
 * absolute `src/index.ts` does, through jiti and through Node's own loader.
 *
 * The two absolute checkout paths are a LOCAL convention for a package that is not resolvable by
 * name yet — not an install guarantee. The main checkout comes first because merged work lives
 * there; the feature worktree follows because that is where unreleased work is tested. A real
 * install resolves through the bare specifier above, and `GENTLE_SHELL_BRIDGE_MODULE` overrides
 * everything.
 */
function bridgeCandidates(): string[] {
  const candidates: string[] = [];
  const override = process.env.GENTLE_SHELL_BRIDGE_MODULE;
  if (typeof override === "string" && override.trim() !== "") candidates.push(override.trim());
  candidates.push("gentle-shell-bridge");
  candidates.push(resolve(homedir(), "dev/projects/gentle-shell-bridge/src/index.ts"));
  candidates.push(
    resolve(
      homedir(),
      "dev/projects/gentle-shell-bridge-worktrees/sidebar-sections/src/index.ts",
    ),
  );
  candidates.push(resolve(homedir(), ".pi/agent/npm/node_modules/gentle-shell-bridge/src/index.ts"));
  return candidates;
}

function isBridgeModule(value: unknown): value is BridgeModuleLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { registerRows?: unknown; createStore?: unknown };
  return typeof candidate.registerRows === "function" && typeof candidate.createStore === "function";
}

/**
 * Load the package, or report why it could not be loaded and let the extension keep running:
 * without the bridge there is no toggle, so `default` is the only reachable mode and bash keeps
 * its native rendering.
 */
async function loadBridge(): Promise<BridgeModuleLike | undefined> {
  const tried: string[] = [];
  for (const specifier of bridgeCandidates()) {
    try {
      // A non-literal specifier: the host runtime resolves it against the extension's own
      // location, which is exactly the question this example has to answer empirically.
      const loaded: unknown = await import(specifier);
      if (isBridgeModule(loaded)) return loaded;
      tried.push(`${specifier} — loaded, but it exports no registerRows/createStore`);
    } catch (error) {
      tried.push(`${specifier} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.warn(
    "[bash-card] gentle-shell-bridge could not be imported, so this example adds no toggle row, " +
      "no sidebar section, and leaves bash rendering alone. Set GENTLE_SHELL_BRIDGE_MODULE to the " +
      "package's src/index.ts to point it at a checkout; the absolute paths below are a local " +
      `convention for this machine, not an install guarantee. Tried:\n  ${tried.join("\n  ")}`,
  );
  return undefined;
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
  [MODE_TOOL]: ["bash $ ls -1", "README.md", "package.json"].join("\n"),
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
    // rule"). Painting before the write would make the bullet lie for one frame. The repaint is
    // the menu itself: bash rows already drawn keep their old rendering, and the new mode applies
    // to the next bash call.
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
 * Live state for the card: the mode the user chose, and whether this load really wired the bash
 * renderer. Both are cheap on purpose — `lines()` runs once per rail frame, so this is one store
 * read plus one boolean, with no card built and nothing invented.
 */
function bashCardSection(store: BridgeStoreLike, rendererRegistered: boolean): SidebarSectionLike {
  return {
    id: SECTION_ID,
    title: SECTION_TITLE,
    // The right-aligned count: the same value the `Cards` toggle writes, so the two surfaces
    // cannot disagree.
    meta: () => readStoredMode(store),
    lines: () => [
      `rendering  ${readStoredMode(store)}`,
      `renderer   ${rendererRegistered ? "registered" : "absent"}`,
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

/**
 * Registers the bash renderer resolver and reports whether the slot was actually claimed. The
 * setting is read inside the resolver — once per call, never at load time — which is what lets
 * `/gentle:customize` change rendering without a reload. The return value is honest state for the
 * sidebar section, not a decoration: a Pi without `registerToolRenderer` must not claim one.
 */
function registerBashRenderer(pi: ExtensionApiLike, readMode: () => BashRenderingMode): boolean {
  const register = pi.registerToolRenderer;
  if (typeof register !== "function") {
    console.warn("[bash-card] this Pi has no pi.registerToolRenderer; bash keeps its native rendering.");
    return false;
  }

  // `next()` is the renderer chain this resolver did not take; a host whose chain throws
  // still must not see this extension throw.
  const fallback = (next: () => RendererSetLike | undefined): RendererSetLike | undefined => {
    try {
      return next();
    } catch {
      return undefined;
    }
  };

  register.call(pi, (toolName: string, next: () => RendererSetLike | undefined) => {
    try {
      if (toolName !== "bash") return fallback(next);
      // One read per resolver call, not per character and not at load time.
      if (readMode() !== MODE_TOOL) return fallback(next);
      // No `renderShell: "self"`: Pi's default box keeps the padding and background, so this
      // card draws content only and never a second frame.
      return { renderCall: bashRenderCall, renderResult: bashRenderResult };
    } catch {
      return fallback(next);
    }
  });
  return true;
}

/** Nothing registered, nothing to dispose. */
const NO_DISPOSER = (): void => {};

export default async function bashCardExample(pi: ExtensionApiLike): Promise<() => void> {
  // Holds the store once it exists; `undefined` means the bridge has not loaded (or failed), and
  // every read then reports `default`, so bash rendering is untouched.
  const state: { store?: BridgeStoreLike } = {};

  // Claimed before the bridge loads: the section below reports whether this actually happened.
  const rendererRegistered = registerBashRenderer(pi, () => readStoredMode(state.store));

  const bridge = await loadBridge();
  if (bridge === undefined) return NO_DISPOSER;

  let store: BridgeStoreLike;
  try {
    store = bridge.createStore(PLUGIN_ID);
  } catch (error) {
    console.warn(
      `[bash-card] could not open the bridge store for "${PLUGIN_ID}": ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return NO_DISPOSER;
  }
  state.store = store;

  // Same provider id on every load, so a `/reload` replaces these rows instead of stacking them.
  const disposeRows = bridge.registerRows({
    id: "bash-card-example.rendering",
    category: ROW_CATEGORY,
    rows: () => bashRenderingRows(store),
  });

  // The sidebar half. `registerSection` arrived with the sidebar surface (0.1.0), so an installed
  // package may predate it: skip the section, say so ONCE, and keep the row side working.
  let disposeSection = NO_DISPOSER;
  const registerSection = bridge.registerSection;
  if (typeof registerSection !== "function") {
    console.warn(
      "[bash-card] this gentle-shell-bridge has no registerSection (it predates 0.1.0), so this " +
        "example adds no sidebar section. The Cards toggle still works; update the package to get " +
        "the BASH CARD card.",
    );
  } else {
    // Same stable id on every load, so `/reload` replaces the section instead of stacking one.
    disposeSection = registerSection.call(bridge, bashCardSection(store, rendererRegistered));
  }

  // Both surfaces belong to one registration lifetime: disposing the example must not leave half of
  // it behind. Nothing depends on this return value — the stable ids are what make a `/reload`
  // replace rather than stack — it exists so a programmatic caller can tear both down together.
  return () => {
    disposeSection();
    disposeRows();
  };
}
