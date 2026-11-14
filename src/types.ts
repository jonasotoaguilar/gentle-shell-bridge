/**
 * The public row/provider contract, mirroring `docs/contract.md` §2–§3.
 *
 * The bridge carries rows through unchanged: it never reads, rewrites or interprets a row, so
 * every field here is a pass-through of what gentle-shell's renderer already understands
 * (`lib/visual-customize-view.ts:107-140`).
 */

/**
 * Context handed to a provider's `rows(ctx)` once per menu build.
 *
 * `theme` is the host's opaque theme object, passed through untouched; the bridge does not
 * depend on its shape, so consumers narrow it themselves. `configHome` is the resolved
 * gentle-shell config home (see `./config.ts`), so a plugin can place per-user state without
 * re-deriving the path.
 */
export interface RowContext {
  readonly theme: unknown;
  readonly configHome: string;
}

/** Row text; a function is evaluated when the menu is built. */
export type RowLabel = string | (() => string);

/** One value of a setting. Consecutive rows sharing `setting` share one rendered line. */
export interface RowChoice {
  setting: string;
  value: string;
  current(): boolean;
  hint?: string;
  /** `false` makes Enter apply the choice instead of applying on ←/→. */
  applyOnMove?: boolean;
}

/** Read-only depiction of the highlighted choice; never an application. */
export interface RowPreview {
  title: string;
  sample: string;
}

/**
 * Inline helpers available to `action`, so a row never opens a nested native dialog.
 * Shapes mirror `lib/visual-customize-view.ts:129-140`.
 */
export interface InlineHelpers {
  input(options: { prompt: string; value?: string }): Promise<string | undefined>;
  confirm(message: string): Promise<boolean>;
  capture(prompt: string): Promise<string | undefined>;
}

/**
 * A settings row as gentle-shell's renderer understands it. `category` is one of the
 * categories the host already renders; the bridge cannot create new ones.
 */
export interface CustomizeRow {
  /**
   * Optional here: a provider whose rows all belong to its own `provider.category` may omit it,
   * and the capture backend fills it from there (shallow-cloning the row, never mutating it).
   * The host's renderer still requires a category on every row it receives.
   */
  category?: string;
  label?: RowLabel;
  choice?: RowChoice;
  preview?: () => RowPreview;
  /** Hidden when false; a throw fails closed (row hidden). */
  visible?: () => boolean;
  keyhint?: string;
  action?: (inline: InlineHelpers) => void | Promise<void>;
}

/**
 * Context handed to a section's `lines(ctx)` and `meta(ctx)` on every frame.
 *
 * The same shape as `RowContext` — the host's theme, passed through untouched, and the resolved
 * gentle-shell config home — so a plugin that already builds rows uses one context type for both
 * surfaces and never re-derives the path. Aliased rather than duplicated: two identical interfaces
 * would drift.
 */
export type SectionContext = RowContext;

/**
 * The semantic roles a section row may paint with (N10). They are the host's own theme roles —
 * `lib/shell-bar.ts:98-101` paints `fg(role, text)` for exactly these names, and
 * `lib/shell-sidebar-layout.ts:123-124` signatures a theme with nine of them — so a row says what it
 * MEANS (`error`, `success`, `muted`) and the theme decides the colour. A raw colour, an SGR code or
 * any other word is rejected when the row is built, never coerced: a row the theme cannot paint
 * would otherwise reach the terminal as plain text the author believed was styled.
 */
export type Tone = "text" | "muted" | "dim" | "accent" | "success" | "error" | "warning";

/** The roles a `Tone` may name, for validation and for the docs. */
export const TONES: readonly Tone[] = [
  "text",
  "muted",
  "dim",
  "accent",
  "success",
  "error",
  "warning",
];

/**
 * One body row of a section (N10): what the host's own `AGENTS` rows carry, and nothing more.
 *
 * `label` is the row's text; `meta` is the right-aligned secondary column (tokens, elapsed time, a
 * value — the field that updates live, N14); `glyph` is a one-character mark before the label;
 * `tone` names a semantic role; `onClick` is what makes the row CLICKABLE (N12). A row without
 * `onClick` is inert: it never highlights under the pointer and never answers a click.
 */
export interface SectionRow {
  label: string;
  meta?: string;
  glyph?: string;
  tone?: Tone;
  onClick?: () => void;
}

/**
 * One body row: a plain string (kept byte-identical, so no existing plugin changes appearance) or a
 * structured row.
 */
export type SectionLine = string | SectionRow;

/**
 * A plugin's sidebar section: the analogue of `RowProvider` for the rail, mirroring the sidebar
 * spec's S2. The plugin writes content only — it never names a `setting`, a rail key or a card
 * frame; the bridge frames the section, draws the host's header and contributes the section's
 * visibility and collapse controls.
 */
export interface SidebarSection {
  /** Unique and stable: the key for ordering, replacement and the persisted visibility toggle. */
  id: string;
  /** The section heading, drawn like the host's own `AGENTS`/`CHANGES`/`STATS` titles. */
  title: string;
  /** Optional display name for the plugin's INTEGRATIONS line; see `RowProvider.name`. */
  name?: string;
  /**
   * What the `Sections` rows read, e.g. `"music"`. Optional: when absent the bridge derives it from
   * `title` (lowercase words, no dots, no prefix), and two sections whose labels read the same are
   * disambiguated deterministically and reported by `/bridge-status`. The `id` is never shown.
   */
  rowLabel?: string;
  /** Optional right-aligned text, the analogue of `idle` / `clean` / `3`. */
  meta?(ctx: SectionContext): string | undefined;
  /**
   * The body, evaluated per frame, so live state is honest without a redraw API. A throw drops
   * this section's body, and only this section's. A row is a plain string or a `SectionRow`
   * (N10), and a structured row's `meta` — like the body itself — is read at render time, so a
   * plugin that changes it is repainted without re-registering (N14). A collapsed section is not
   * built at all (N13).
   */
  lines(ctx: SectionContext): SectionLine[];
  /** Visible unless the user (or the plugin) says otherwise; defaults to `true`. */
  defaultVisible?: boolean;
  /**
   * Optional integer. Sections with an `order` render first, ascending; sections without one
   * follow in registration order.
   */
  order?: number;
}

/** A plugin's contribution: rows for one category, built lazily per menu build. */
export interface RowProvider {
  /** Unique and stable, e.g. `"loon.banner-source"`; the key for ordering and replacement. */
  id: string;
  /** The category this provider adds rows to. */
  category: string;
  /**
   * Optional display name for this plugin's INTEGRATIONS line, e.g. `"Loon kit"`. Honoured on the
   * plugin's FIRST registration only; later ones are ignored. It overrides the name derived from the
   * owning package, must obey the row-name shape (one to three plain words, no structural marks) and
   * is never rewritten: a rejected name produces no line at all. A single-file extension with no
   * `package.json` above it is otherwise unattributable and gets no line — naming it here is how it
   * gets one.
   */
  name?: string;
  /** Evaluated each time the menu is built, never at registration. */
  rows(ctx: RowContext): CustomizeRow[];
}

/**
 * What a card style's `top` receives: the measured width, plus the pieces of the host's own frame
 * the bridge extracted once, in one place (S2). A style must never try to parse them back out of a
 * line.
 */
export interface CardFrameTopContext {
  readonly width: number;
  /** The card's title as the host printed it, without the glyph; absent when it could not be found. */
  readonly title?: string;
  /** The right-aligned hint as the host printed it, e.g. `ctrl+o`; absent when the card had none. */
  readonly hint?: string;
}

/** What a card style's `line` receives: one body row of the host's card. */
export interface CardFrameLineContext {
  readonly text: string;
  readonly width: number;
  /** `true` for the first body row of the card, `false` for every continuation row. */
  readonly first: boolean;
}

/** What a card style's `bottom` receives. */
export interface CardFrameBottomContext {
  readonly width: number;
}

/**
 * The three functions a style draws with, and the whole of what the bridge calls (S2). The bridge
 * supplies the width and the text; it never asks the style where anything is.
 */
export interface CardFrame {
  top(ctx: CardFrameTopContext): string;
  line(ctx: CardFrameLineContext): string;
  bottom(ctx: CardFrameBottomContext): string;
}

/**
 * What a transform reports about its own frame (F1): how many candidate cards it examined, how many
 * it recognised, how many it rewrote, and — when its grammar has several shapes — which shape
 * matched, by the transform's own name for it.
 *
 * COUNTS ONLY. A frame carries the user's private output, so nothing of it may be stored or shown:
 * no line, no text, no plugin output. A shape name is therefore a NAME and nothing else — lowercase
 * letters, digits, `_`, `.` or `-`, at most 24 characters — and anything else is dropped rather than
 * recorded (`src/transform-pipeline.ts` sanitises every value before it is stored).
 */
export interface TransformCounts {
  /** Rows the transform examined as a possible card head. */
  candidates: number;
  /** Candidates its grammar accepted. */
  recognised: number;
  /** Cards it actually rewrote this frame; `0` when its setting leaves them alone. */
  rewritten: number;
  /** Which shape matched, by name, and how many times. Absent when the grammar has one shape. */
  shapes?: Readonly<Record<string, number>>;
}

/**
 * Context handed to a transform on every frame. `width` is the width the host rendered the
 * conversation at, which is also the hard limit on what the transform may return (S4).
 */
export interface TransformContext {
  readonly width: number;
  /**
   * Report this frame's counts (F1). The bridge adds the line count and the outcome itself, records
   * the result in this frame's entry for `/bridge-status`, and never lets it reach the frame: a
   * throw, or nonsense, costs the counts and nothing else (F4).
   *
   * Optional because a published bridge older than the telemetry has no such member: call it behind
   * `typeof ctx.report === "function"` and the transform keeps working with either.
   */
  report?(counts: TransformCounts): void;
}

/**
 * A plugin's transcript transform (S1): a function over the conversation's lines.
 *
 * Unlike a card style, a transform is not given a detected card — it sees the rows the host (and
 * any earlier transform) produced and returns the rows to draw. That is the layer a rendering
 * choice needs to apply to cards that are ALREADY on screen: a tool renderer resolves once, when a
 * row is built, while the conversation component renders every frame.
 *
 * The bridge clips whatever comes back to `ctx.width`, skips the transform for the frame if it
 * throws, and never lets a transform into Pi's render loop (S3, S4).
 */
export interface TranscriptTransform {
  /** Unique and stable: the replacement key, the ordering key and the `/bridge-status` name. */
  id: string;
  /** Optional display name for the plugin's INTEGRATIONS line; see `RowProvider.name`. */
  name?: string;
  /**
   * Optional integer. Transforms with an `order` run first, ascending; the rest follow in
   * registration order, so several plugins always produce one deterministic pipeline (S2).
   */
  order?: number;
  /** The rows, and the width to honour. Return the rows to draw. */
  transform(lines: readonly string[], ctx: TransformContext): readonly string[];
}

/**
 * A plugin's card style: chrome, never a parser (S1). The bridge owns detection and hands this
 * registration's `frame` the card it found; the style owns only what the card looks like.
 */
export interface CardStyleRegistration {
  /**
   * Unique and stable: it is the value the user selects and the key for ordering and replacement.
   * It may not be `native` (the bridge's own pass-through value) nor one of the host's own values,
   * because the line would then show the same value twice.
   */
  id: string;
  /** Optional display name for the plugin's INTEGRATIONS line; see `RowProvider.name`. */
  name?: string;
  /** The short text shown on the `Card style` line for this value. */
  label: string;
  /**
   * What this style's row reads in the menu, e.g. `"plain"`. Optional: when absent the bridge
   * derives it from `label` (lowercase words, no dots, no prefix). `label` stays the line's value and
   * the `id` stays internal; the row never shows the id.
   */
  rowLabel?: string;
  frame: CardFrame;
  /** Optional literal depiction of the style, drawn in the customize preview. */
  preview?(): RowPreview;
  /**
   * Optional integer. Styles with an `order` come first, ascending; the rest follow in registration
   * order, so several plugins always produce one deterministic value sequence (S12).
   */
  order?: number;
}
