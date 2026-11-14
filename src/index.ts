/**
 * gentle-shell-bridge entry point.
 *
 * Pi loads `src/extension.ts` (the `pi.extensions` manifest entry) through jiti, so the sources are
 * the published artifact: there is no build step and no `dist/`. This module is the package's
 * programmatic API surface for plugins: rows, sidebar sections, card styles, transcript transforms,
 * the optional store and the runtime handshake (`bridgeApi`, `onBridgeApi`, the announcement event). Backend internals — the capture patch, the hook registry, the arm
 * lifecycle, the rail interception, the section renderer, the card-style line and transformer, the
 * transform pipeline, `status` and the bus snapshots — are reached through the extension entry, not
 * re-exported here. docs/contract.md's Limits section is explicit about which names are the
 * contract.
 *
 * Importing this module also publishes the runtime handshake (`./api.ts`), the channel a plugin
 * uses when it does not import the package at all. A plugin that does import it calls
 * `bridgeApi()` from its `session_start` handler — the object, or `undefined` when the bridge is
 * not installed — or `onBridgeApi(handler, pi.events)`, which is the same answer plus the
 * announcement form: the handler runs immediately when the object is already published, and when
 * it is not, it runs when the bridge announces itself. There is no holding area either way.
 */
export {
  BRIDGE_READY_EVENT,
  VERSION,
  bridgeApi,
  isBridgeApi,
  onBridgeApi,
} from "./api.ts";
export type {
  BridgeApi,
  BridgeApiHandler,
  BridgeEventBus,
  BridgeEventUnsubscribe,
  BridgeReadyPayload,
} from "./api.ts";
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
  SectionLine,
  SectionRow,
  SidebarSection,
  Tone,
  TransformContext,
  TransformCounts,
  TranscriptTransform,
} from "./types.ts";
