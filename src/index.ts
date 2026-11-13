/**
 * gentle-shell-bridge entry point.
 *
 * Pi loads `src/extension.ts` (the `pi.extensions` manifest entry) through jiti, so the sources are
 * the published artifact: there is no build step and no `dist/`. This module is the package's
 * programmatic API surface for plugins. Backend internals — the capture patch, the hook registry,
 * the arm lifecycle and `status` — are reached through the extension entry, not re-exported here.
 */
export { registerRows, snapshotProviders } from "./bus.ts";
export { createStore, STORE_SCHEMA_VERSION } from "./store.ts";
export type { Store, StoreProblem, StoreProblemKind } from "./store.ts";
export type {
  CustomizeRow,
  InlineHelpers,
  RowChoice,
  RowContext,
  RowLabel,
  RowPreview,
  RowProvider,
} from "./types.ts";

export const VERSION = "0.0.0";
