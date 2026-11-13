/**
 * gentle-shell-bridge entry point.
 *
 * Pi loads this module through jiti, so the sources are the published artifact: there is no
 * build step and no `dist/`. The bus and its `resetBusForTests` seam live in `./bus.ts`; the
 * seam is deliberately not re-exported here.
 */
export { registerRows, snapshotProviders } from "./bus.ts";
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
