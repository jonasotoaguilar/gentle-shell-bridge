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
 * A plugin's sidebar section: the analogue of `RowProvider` for the rail, mirroring the sidebar
 * spec's S2. The plugin writes content only — it never names a `setting`, a rail key or a card
 * frame; the bridge frames the section and contributes its visibility toggle.
 */
export interface SidebarSection {
  /** Unique and stable: the key for ordering, replacement and the persisted visibility toggle. */
  id: string;
  /** The section heading, drawn like the host's own `AGENTS`/`CHANGES`/`STATS` titles. */
  title: string;
  /** Optional right-aligned text, the analogue of `idle` / `clean` / `3`. */
  meta?(ctx: SectionContext): string | undefined;
  /**
   * The body, evaluated per frame, so live state is honest without a redraw API. A throw drops
   * this section's body, and only this section's.
   */
  lines(ctx: SectionContext): string[];
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
  /** Evaluated each time the menu is built, never at registration. */
  rows(ctx: RowContext): CustomizeRow[];
}
