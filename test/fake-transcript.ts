/**
 * A fake conversation, and a fake `tui` that reaches it the way Pi does (S8, S4).
 *
 * Two things are modelled here, and nothing else:
 *
 * 1. **The component whose `render(width)` produces the conversation rows.** Its output is real
 *    gentle-shell chrome, not an invention: every line below was produced by running
 *    `gentle-shell/lib/shell-card.ts` (read-only) — `floatRows` / `cardTop` / `cardLine` /
 *    `cardBottom` — with a theme whose `fg` maps the host's roles to SGR codes
 *    (`border`→90, `accent`→95, `dim`→2, `muted`→37, `text`→39) and whose `bg` opens a
 *    256-colour background and closes with `\x1b[49m`, the shape `surfaceOpener` requires
 *    (`shell-card.ts:288-303`). Width 40 throughout. The grammar these lines encode is documented
 *    at the top of `src/card-styles.ts`.
 * 2. **The tree Pi mounts, and the property path from `tui` down to that component.** It is copied
 *    from Pi's own construction, not guessed:
 *    - `interactive-mode.js:403-407` — the document container's children are
 *      `[header, loadedResources, chatContainer]`;
 *    - `chat-viewport.js:4-11,22-25` — the transcript is a `primary` `ScrollView` wrapping that
 *      document, and the layout root is a `VStack` of `[transcript, dock]`;
 *    - `interactive-mode.js:623-629` — mounting adds the seven containers with `addChild` (so
 *      `tui.children[0]` is the document, in both renderer modes) and then calls
 *      `setLayoutRoot(root)` (fullscreen only);
 *    - `pi-tui/dist/layout-node.d.ts:2,36-38` and `components/scroll-view.d.ts:57` — both the
 *      stack and the scroll view expose their parts through `LAYOUT_NODE()`.
 *
 * The fake keeps those shapes faithfully: `layoutRoot` is absent in regular mode and before
 * mounting, `children[0]` is always the document when mounted, and the scroll view's
 * `[LAYOUT_NODE]().component` is its child.
 */

/** The layout protocol symbol, exactly as pi-tui defines it (`pi-tui/dist/layout-node.js:1`). */
export const LAYOUT_NODE: symbol = Symbol.for("@earendil-works/pi-tui/layout-node");

/** Strips SGR sequences, so a test can assert on what the user sees. */
export function stripAnsi(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * One `float` card, width 40: title `read`, hint `ctrl+o`, one body row `config.ts`.
 * Rows: padding, header, padding, body, closing rule.
 */
export const READ_CARD: readonly string[] = [
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m \u001b[39m\u001b[95m✿ read\u001b[39m\u001b[90m                    \u001b[39m \u001b[2mctrl+o\u001b[39m \u001b[90m  \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m \u001b[39mconfig.ts\u001b[39m                          \u001b[90m \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
];

/**
 * The INSTALLED host's bash tool card, `float` style, width 60, split the way Pi builds it: the call
 * component (`ToolCardTop`) and the result component (`ToolCardBody`), each through `floatRows`.
 *
 * The heading is the host's minimal spelling, not the literal word `bash`: `quiet-tools.ts:521-525`
 * titles it with the bare command and the card glyph supplies the `$` prompt, while the timeout
 * rides in the muted role on the same row. The right-aligned `ctrl+o to expand` hint is in the dim
 * role. Widths are exact: `floatRows` paints a one-column margin on both sides of a 58-column inner
 * frame, and `cardTop` spends `1 + 1 + 24 + 1 + 11 + 18 + 2 = 58` columns on the heading row.
 */
export const HOST_BASH_CALL: readonly string[] = [
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                                         \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m \u001b[39m\u001b[95m$ npm test\u001b[39m\u001b[37m (timeout 30s)\u001b[39m\u001b[90m            \u001b[39m \u001b[2mctrl+o to expand\u001b[39m \u001b[90m  \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                                         \u001b[39m\u001b[49m ",
];

/** The result component of the same card: two body rows and the closing rule, width 60. */
export const HOST_BASH_RESULT: readonly string[] = [
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m PASS 42 tests                                          \u001b[90m \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m duration 1.2s                                          \u001b[90m \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                                         \u001b[39m\u001b[49m ",
];

/**
 * A `read` tool call beside it, drawn by the same host code (glyph `≡`, `TOOL_GLYPH.read`). The
 * heading is `≡ read src/api.ts`; nothing about it is bash, so a bash design must leave it alone.
 */
export const HOST_READ_CARD: readonly string[] = [
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                                         \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m \u001b[39m\u001b[95m≡ read src/api.ts\u001b[39m\u001b[90m                   \u001b[39m \u001b[2mctrl+o to expand\u001b[39m \u001b[90m  \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                                         \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m \u001b[39mexport function bridgeApi() {\u001b[39m                          \u001b[90m \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                                         \u001b[39m\u001b[49m ",
];

/**
 * One `float` card, width 40, with NO hint and NO body: padding, header, padding. Its opener and
 * closer rows are byte-identical to the padded card's, which is why detection must key on
 * position rather than on a row's shape alone.
 */
export const BASH_CARD: readonly string[] = [
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m \u001b[39m\u001b[95m✿ bash\u001b[39m\u001b[90m                            \u001b[39m\u001b[90m  \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
];

/**
 * One `float` card whose body row was truncated by `cardLine` (`shell-card.ts:172-184`): the
 * `…` arrives with a full reset, and the background is re-armed after it
 * (`paintSurfaceRow`, `:300-303`) — the escape sequence real output carries.
 */
export const TRUNCATED_CARD: readonly string[] = [
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m \u001b[39m\u001b[95m✿ bash\u001b[39m\u001b[90m                            \u001b[39m\u001b[90m  \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m \u001b[39mnpm run typecheck exits zero and \u001b[0m\u001b[48;5;236m…\u001b[0m\u001b[48;5;236m \u001b[90m \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
];

/**
 * The same card in `neon`: no margin, no background, `╭─ … ╮` / `│ … │` / `╰ … ╯`. Detection must
 * never mistake one style for the other, so both are fixtures.
 */
export const NEON_CARD: readonly string[] = [
  "\u001b[90m╭\u001b[39m\u001b[90m─ \u001b[39m\u001b[95m✿ read\u001b[39m\u001b[90m ─────────────────────\u001b[39m \u001b[2mctrl+o\u001b[39m \u001b[90m╮\u001b[39m",
  "\u001b[90m│\u001b[39m \u001b[39mconfig.ts\u001b[39m                            \u001b[90m│\u001b[39m",
  "\u001b[90m╰\u001b[39m\u001b[90m──────────────────────────────────────╯\u001b[39m",
];

/**
 * The same bash card in the host's `neon` outline, width 60, split the same way: the top rule is the
 * call component, the body plus the closing rule the result component. `cardTop` at width 60 spends
 * `1 + 2 + 24 + 1 + 13 + 18 + 1 = 60` columns, so the title and the right-aligned hint are the
 * host's own frame — a design changes the mark and the fill, never the rule's shape.
 */
export const HOST_BASH_NEON_CALL: readonly string[] = [
  "\u001b[90m╭\u001b[39m\u001b[90m─ \u001b[39m\u001b[95m$ npm test\u001b[39m\u001b[37m (timeout 30s)\u001b[39m\u001b[90m ─────────────\u001b[39m \u001b[2mctrl+o to expand\u001b[39m \u001b[90m╮\u001b[39m",
];

/** The result component of the `neon` bash card: two body rows and the closing rule, width 60. */
export const HOST_BASH_NEON_RESULT: readonly string[] = [
  "\u001b[90m│\u001b[39m PASS 42 tests                                            \u001b[90m│\u001b[39m",
  "\u001b[90m│\u001b[39m duration 1.2s                                            \u001b[90m│\u001b[39m",
  "\u001b[90m╰\u001b[39m\u001b[90m──────────────────────────────────────────────────────────╯\u001b[39m",
];

/**
 * A `float` card with a SUBTITLE and no hint, width 40: the header carries two text runs (title in
 * the title role, `· config.ts` in the muted role) and no dim hint. It pins the honest limit of
 * extraction: a heading whose last run is a subtitle must not be read as a hint.
 */
export const SUBTITLE_CARD: readonly string[] = [
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m \u001b[39m\u001b[95m✿ read\u001b[39m \u001b[37m·\u001b[39m \u001b[37mconfig.ts\u001b[39m\u001b[90m                \u001b[39m\u001b[90m  \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
];

/** A line the host did not draw as a card, plus a blank one: a repaint must leave both alone. */
export const PROSE_LINE = "I will read the config first.";
export const BLANK_LINE = "";

/** What the conversation component renders: prose, a card, more prose, a second card. */
export const CONVERSATION: readonly string[] = [
  PROSE_LINE,
  BLANK_LINE,
  ...READ_CARD,
  BLANK_LINE,
  ...TRUNCATED_CARD,
  BLANK_LINE,
  ...BASH_CARD,
];

/** A component, in Pi's sense: `render(width)` returns one string per row. */
export interface FakeComponent {
  render(width: number): string[];
}

/** The card component: records every width it was asked to render at. */
export interface FakeConversation extends FakeComponent {
  readonly widths: number[];
}

export function createFakeConversation(lines: readonly string[] = CONVERSATION): FakeConversation {
  const widths: number[] = [];
  return {
    widths,
    render(width: number): string[] {
      widths.push(width);
      return [...lines];
    },
  };
}

/** A component that paints one fixed row, for the header and the loaded-resources slots. */
function fixedRow(text: string): FakeComponent {
  return { render: () => [text] };
}

/** What `LAYOUT_NODE()` returns for a stack / scroll view, narrowed to what a walk reads. */
export interface FakeLayoutNode {
  type: string;
  entries?: ReadonlyArray<{ component?: unknown }>;
  component?: unknown;
}

/** Anything exposing the layout protocol, as `ScrollView` and `VStack` both do. */
export function layoutNodeOf(value: unknown): FakeLayoutNode | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const read = (value as Record<symbol, unknown>)[LAYOUT_NODE];
  if (typeof read !== "function") return undefined;
  const node: unknown = read.call(value);
  if (node === null || typeof node !== "object") return undefined;
  return node as FakeLayoutNode;
}

/** The transcript `ScrollView`, shaped like `pi-tui`'s: a scrollbar, a child, the layout protocol. */
export interface FakeScrollView {
  readonly child: unknown;
  scrollbar: "auto" | "hidden" | "always";
  setScrollbar(value: "auto" | "hidden" | "always"): void;
  getContentWidth(width: number): number;
  render(width: number): string[];
  [LAYOUT_NODE](): FakeLayoutNode;
}

export interface FakeDocument extends FakeComponent {
  children: FakeComponent[];
}

export interface FakeTui {
  mode: "fullscreen" | "regular";
  terminal: Record<string, unknown>;
  children: FakeComponent[];
  /** Absent in regular mode and before mounting, exactly as on Pi's own renderer. */
  layoutRoot?: { [LAYOUT_NODE](): FakeLayoutNode };
  render(width: number): string[];
  document: FakeDocument;
  transcript?: FakeScrollView;
  chat: FakeConversation;
}

export interface FakeTranscriptTuiOptions {
  /** `regular` models `TuiMainScreen`: children only, no layout root. */
  mode?: "fullscreen" | "regular";
  /** `false` models the window before `mountInteractiveTui` runs: nothing mounted at all. */
  mounted?: boolean;
  lines?: readonly string[];
}

/**
 * The fake `tui`. `layoutRoot` (fullscreen, mounted) and `children[0]` (mounted, either mode) both
 * lead to `chat`, so a walk can be written against the documented path and proven here — and the
 * absent shapes are just as reachable.
 */
export function createFakeTranscriptTui(options: FakeTranscriptTuiOptions = {}): FakeTui {
  const mode = options.mode ?? "fullscreen";
  const mounted = options.mounted ?? true;
  const chat = createFakeConversation(options.lines ?? CONVERSATION);
  const header = fixedRow("header");
  const loadedResources = fixedRow("resources");

  // interactive-mode.js:403-407 — the document container's children, in that order.
  const document: FakeDocument = {
    children: [header, loadedResources, chat],
    render(width: number): string[] {
      return this.children.flatMap((child) => child.render(width));
    },
  };

  // chat-viewport.js:4-11 — a primary ScrollView over the document; its render adds the scrollbar
  // column when `getContentWidth` steals one (pi-tui/components/scroll-view.js:186-190).
  const transcript: FakeScrollView = {
    child: document,
    scrollbar: "auto",
    setScrollbar(value) {
      this.scrollbar = value;
    },
    getContentWidth(width: number): number {
      return this.scrollbar === "hidden" ? width : Math.max(1, width - 1);
    },
    render(width: number): string[] {
      const contentWidth = this.getContentWidth(width);
      const lines = (this.child as FakeComponent).render(contentWidth);
      return contentWidth === width ? lines : lines.map((line) => `${line} `);
    },
    [LAYOUT_NODE](): FakeLayoutNode {
      return { type: "scroll", component: this.child };
    },
  };

  const dock = {
    [LAYOUT_NODE](): FakeLayoutNode {
      return { type: "vstack", entries: [{ component: fixedRow("editor") }] };
    },
  };

  const layoutRoot = {
    [LAYOUT_NODE](): FakeLayoutNode {
      return {
        type: "vstack",
        entries: [{ component: transcript }, { component: dock }],
      };
    },
  };

  const tui: FakeTui = {
    mode,
    terminal: {},
    // interactive-mode.js:622-625 — the seven containers, document first, in both modes.
    children: mounted
      ? [document, fixedRow("pending"), fixedRow("status"), fixedRow("above"), fixedRow("editor"), fixedRow("below"), fixedRow("footer")]
      : [],
    render(width: number): string[] {
      // TuiAltScreen renders the layout root and ignores `children` (tui-alt-screen.js:145-151).
      if (this.layoutRoot !== undefined) {
        return (this.layoutRoot[LAYOUT_NODE]().entries ?? []).flatMap((entry) =>
          (entry.component as FakeComponent | undefined)?.render(width) ?? [],
        );
      }
      return this.children.flatMap((child) => child.render(width));
    },
    document,
    chat,
  };
  // Only the fullscreen renderer has a layout root, and only once mounted (interactive-mode.js:626).
  if (mounted && mode === "fullscreen") {
    tui.layoutRoot = layoutRoot;
    tui.transcript = transcript;
  }
  return tui;
}
