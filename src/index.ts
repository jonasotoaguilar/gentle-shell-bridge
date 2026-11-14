/**
 * gentle-shell-bridge entry point.
 *
 * Pi loads `src/extension.ts` (the `pi.extensions` manifest entry) through jiti, so the sources are
 * the published artifact: there is no build step and no `dist/`. This module is the package's
 * programmatic API surface for plugins: rows, sidebar sections, card styles, transcript transforms
 * and the optional store. Backend internals — the capture patch, the hook registry, the arm
 * lifecycle, the rail interception, the section renderer, the card-style line and transformer, the
 * transform pipeline, `status` and the bus snapshots — are reached through the extension entry, not
 * re-exported here. docs/contract.md's Limits section is explicit about which names are the
 * contract.
 *
 * Importing this module also publishes the runtime handshake (`./api.ts`), the channel a plugin
 * uses when it does not import the package at all. A plugin that does import it calls
 * `bridgeApi()` from its `session_start` handler: the object, or `undefined` when the bridge is
 * not installed. There is no deferred path.
 */
export { VERSION, bridgeApi, isBridgeApi } from "./api.ts";
export type { BridgeApi } from "./api.ts";
export { registerCardStyle, registerRows, registerSection, registerTransform } from "./bus.ts";
export { createStore, STORE_SCHEMA_VERSION } from "./store.ts";
export type { Store, StoreProblem, StoreProblemKind } from "./store.ts";
export type {
  CardFrame,
  CardFrameBottomContext,
  CardFrameLineContext,
  CardFrameTopContext,
  CardStyleRegistration,
  CustomizeRow,
  InlineHelpers,
  RowChoice,
  RowContext,
  RowLabel,
  RowPreview,
  RowProvider,
  SectionContext,
  SidebarSection,
  TransformContext,
  TranscriptTransform,
} from "./types.ts";
