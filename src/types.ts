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

/** A plugin's contribution: rows for one category, built lazily per menu build. */
export interface RowProvider {
  /** Unique and stable, e.g. `"loon.banner-source"`; the key for ordering and replacement. */
  id: string;
  /** The category this provider adds rows to. */
  category: string;
  /** Evaluated each time the menu is built, never at registration. */
  rows(ctx: RowContext): CustomizeRow[];
}
