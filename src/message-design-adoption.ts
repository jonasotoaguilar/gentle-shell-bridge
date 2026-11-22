/**
 * Adopting the custom messages Pi already mounted (S3, S4): the capture point the host actually offers.
 *
 * ## Why this pass exists, and why it is not an API patch
 *
 * `pi.registerMessageRenderer(customType, renderer)` writes into THAT extension's own map
 * (`dist/core/extensions/loader.js:284-287`), and the runner answers `getMessageRenderer(customType)`
 * by scanning extensions in LOAD ORDER and returning the first one that has the type
 * (`dist/core/extensions/runner.js:534-540`). There is no `next()` chain, unlike tool renderers, and
 * no accessor for another extension's map. Every extension holds its own `pi` object with its own
 * closure, so a bridge that patched `pi.registerMessageRenderer` would capture only calls made
 * through the bridge's object — that is, none.
 *
 * What the host does expose is the component it built: `CustomMessageComponent` keeps the renderer Pi
 * resolved in `customRenderer`, re-calls it on every `rebuild()`, and falls back to its own box when
 * the renderer answers `undefined`
 * (`dist/modes/interactive/components/custom-message.js`, `rebuild()`). So adoption is: replace
 * `customRenderer` with the design renderer (`./message-design-wiring.ts`) that delegates to the one
 * the host had, then `invalidate()` so the stored renderer is re-resolved. Pi keeps its frame, its
 * `box`, its padding and its theme, and only the rows change.
 *
 * ## Nobody claimed the type: nobody is touched (S4)
 *
 * A child is ours only when its `message.customType` is claimed by a live design. Everything else is
 * `ignored`: no renderer replaced, no `invalidate()`, no store read. The claim test is a registry
 * walk with no persistence, so a session without message designs pays one scan per render pass and
 * nothing else.
 *
 * ## The one rebuild a switch needs
 *
 * The design renderer re-reads the selection on every pass, so `default` ↔ design with a host
 * renderer needs no rebuild at all. A type with NO host renderer does: `undefined` (Pi's own box) and
 * a component are different answers from the same renderer, so changing between them rebuilds the
 * message exactly once, when the shape changes and never twice.
 *
 * This pass runs inside Pi's render loop, in the same conversation wrapper that adopts tool cards. It
 * never throws: a container without children, a child that is not a message, a renderer that cannot be
 * replaced — all are counted, and the ones the user should know about are reported through the design
 * bus's one failure channel.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { isMessageTypeClaimed, recordMessageDesignFailure, resolveMessageDesignSelection } from "./message-designs.ts";
import { messageDesignRenderer } from "./message-design-wiring.ts";
import { isRecord } from "./rows.ts";

/** What one adoption pass did, per child. */
export interface AdoptCustomMessagesResult {
  /** Children the pass looked at. */
  scanned: number;
  /** Messages whose renderer this pass replaced with the design renderer. */
  adopted: number;
  /** Messages this pass (or an earlier one) already adopted, and the rebuild it needed if any. */
  already: number;
  /** Children that are not a message of a claimed type. */
  ignored: number;
  /** Messages left exactly as the host built them after a reported failure. */
  failed: number;
}

/** What this pass remembers about ONE message it adopted. */
interface AdoptedMessage {
  /** Whether the renderer was built while a design was selected (true) or while it was not. */
  designAtBuild: boolean;
}

/**
 * Own property on a message component this module adopted. It certifies the exact renderer installed,
 * so a rebuild, a reload or a second loaded copy of this package cannot stack two design renderers on
 * one message.
 */
const ADOPTED_MESSAGE: unique symbol = Symbol.for(
  "gentle-shell-bridge.message-designs.adopted-message.v1",
);

interface AdoptionState {
  /** Per custom type, how many messages this process adopted. */
  adoptedMessages: Array<{ customType: string; messages: number }>;
}

/** Stable process-global slot, like every other piece of bridge state: two copies must agree. */
const ADOPTION_KEY = Symbol.for("gentle-shell-bridge.message-designs.adoption.v1");

function adoptionHost(): Record<symbol, AdoptionState | undefined> {
  // SAFETY: only `adoptionState()` writes this key, and it re-checks the shape before trusting a
  // value left behind by another copy or an older load.
  return globalThis as unknown as Record<symbol, AdoptionState | undefined>;
}

function adoptionState(): AdoptionState {
  const host = adoptionHost();
  const existing = host[ADOPTION_KEY];
  if (existing !== undefined && Array.isArray(existing.adoptedMessages)) return existing;
  const created: AdoptionState = { adoptedMessages: [] };
  host[ADOPTION_KEY] = created;
  return created;
}

/** What `/bridge-status` reports about this pass. */
export interface MessageDesignAdoptionDiagnostics {
  /** Per custom type, how many messages were adopted after construction this process. */
  adoptedMessages: Array<{ customType: string; messages: number }>;
}

/** Diagnostics snapshot for `/bridge-status`. */
export function getMessageDesignAdoptionDiagnostics(): MessageDesignAdoptionDiagnostics {
  return {
    adoptedMessages: adoptionState().adoptedMessages.map((entry) => ({ ...entry })),
  };
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetMessageDesignAdoptionForTests(): void {
  adoptionState().adoptedMessages.length = 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordAdoptedMessage(customType: string): void {
  const state = adoptionState();
  const entry = state.adoptedMessages.find((candidate) => candidate.customType === customType);
  if (entry === undefined) state.adoptedMessages.push({ customType, messages: 1 });
  else entry.messages += 1;
}

/**
 * Whether this type draws a design RIGHT NOW. Resolved at most once per type per pass, because it is
 * the only step that reads the persisted selection.
 */
function designIsSelected(customType: string, perPass: Map<string, boolean>): boolean {
  const cached = perPass.get(customType);
  if (cached !== undefined) return cached;
  let selected = false;
  try {
    selected = resolveMessageDesignSelection(customType).kind === "design";
  } catch (error) {
    recordMessageDesignFailure(customType, "(selection)", errorMessage(error));
  }
  perPass.set(customType, selected);
  return selected;
}

/** Read a member of a host object inside the render loop without letting a throwing getter out. */
function readMember(component: Record<string, unknown>, member: string): unknown {
  try {
    return component[member];
  } catch {
    return undefined;
  }
}

/**
 * Adopt every custom message in a container. Called on each CONVERSATION render pass, before the host
 * renders its children; safe to call on anything, and it never throws.
 */
export function adoptCustomMessages(container: unknown): AdoptCustomMessagesResult {
  const result: AdoptCustomMessagesResult = {
    scanned: 0,
    adopted: 0,
    already: 0,
    ignored: 0,
    failed: 0,
  };
  let children: unknown;
  try {
    if (!isRecord(container)) return result;
    children = container.children;
  } catch {
    // A host object whose `children` accessor throws is not a container this pass can read; the
    // host's own messages stand and there is no type to attribute the failure to.
    return result;
  }
  if (!Array.isArray(children)) return result;

  const perPass = new Map<string, boolean>();
  for (const child of children) {
    result.scanned += 1;
    try {
      result[adoptMessage(child, perPass)] += 1;
    } catch (error) {
      // `adoptMessage` is written not to throw; this is the last line of defence inside Pi's render
      // loop, so even a host object whose every accessor throws cannot take the frame down.
      result.failed += 1;
      const customType = messageTypeOf(child);
      if (customType !== undefined) {
        recordMessageDesignFailure(customType, "(adoption)", errorMessage(error));
      }
    }
  }
  return result;
}

/** The custom type of a message child, or `undefined` when this child is not one. */
function messageTypeOf(child: unknown): string | undefined {
  if (!isRecord(child)) return undefined;
  const message = readMember(child, "message");
  if (!isRecord(message)) return undefined;
  const customType = readMember(message, "customType");
  return typeof customType === "string" && customType !== "" ? customType : undefined;
}

type MessageOutcome = "adopted" | "already" | "ignored" | "failed";

function adoptMessage(child: unknown, perPass: Map<string, boolean>): MessageOutcome {
  const customType = messageTypeOf(child);
  if (customType === undefined) return "ignored";
  // Recognition is by CLAIM, never by the drawn frame (S4): a message nobody declared a design for is
  // not ours to touch, and this is the only check that keeps an unclaimed session byte-identical.
  if (!isMessageTypeClaimed(customType)) return "ignored";
  if (!isRecord(child)) return "ignored";
  // A component, and nothing else: a message object that is not renderable is not a message Pi drew.
  if (typeof readMember(child, "render") !== "function") return "ignored";

  const design = designIsSelected(customType, perPass);
  const adopted = adoptedMessage(child);
  if (adopted !== undefined) {
    // Already adopted. The design renderer reads the selection per pass, so only the shape a renderer
    // can answer changes anything: `undefined` (Pi's box) and a component are different answers.
    if (adopted.designAtBuild !== design) {
      adopted.designAtBuild = design;
      invalidate(child, customType);
    }
    return "already";
  }

  const hostRenderer = readMember(child, "customRenderer");
  const renderer = messageDesignRenderer(
    customType,
    typeof hostRenderer === "function" ? (hostRenderer as never) : undefined,
  );
  try {
    child.customRenderer = renderer;
  } catch (error) {
    recordMessageDesignFailure(
      customType,
      "(adoption)",
      `the message refuses its customRenderer (${errorMessage(error)}); Pi's own rendering stands.`,
    );
    return "failed";
  }
  // A setter (or a frozen object in a non-strict host) can ignore the assignment without throwing: the
  // message is only adopted when the renderer this pass installed is really the one Pi will call.
  if (child.customRenderer !== renderer) {
    recordMessageDesignFailure(
      customType,
      "(adoption)",
      "the message did not take the design renderer; Pi's own rendering stands.",
    );
    return "failed";
  }

  const record: AdoptedMessage = { designAtBuild: design };
  Object.defineProperty(child, ADOPTED_MESSAGE, {
    value: record,
    enumerable: false,
    configurable: true,
  });
  recordAdoptedMessage(customType);
  // The renderer Pi stored was resolved when the message was added; `invalidate()` is what makes it
  // resolve again, through the design renderer.
  invalidate(child, customType);
  return "adopted";
}

/** The adoption record of a child this pass installed a renderer on, if it is really still ours. */
function adoptedMessage(child: Record<string, unknown>): AdoptedMessage | undefined {
  const record = (child as Record<symbol, unknown>)[ADOPTED_MESSAGE];
  if (!isRecord(record)) return undefined;
  // SAFETY: the only writer of this symbol is `adoptMessage`, which stores an `AdoptedMessage`; a
  // value left by another copy is re-checked for the one field this pass reads before it is trusted.
  return typeof record.designAtBuild === "boolean"
    ? (record as unknown as AdoptedMessage)
    : undefined;
}

/** Rebuild one message; a throwing `invalidate` is the host's own failure and is reported once. */
function invalidate(child: Record<string, unknown>, customType: string): void {
  const invalidateChild = readMember(child, "invalidate");
  if (typeof invalidateChild !== "function") {
    recordMessageDesignFailure(
      customType,
      "(adoption)",
      "the message has no invalidate(), so its renderer cannot be re-resolved; Pi keeps drawing " +
        "what it already drew until the message is rebuilt by the host.",
    );
    return;
  }
  try {
    (invalidateChild as () => void).call(child);
  } catch (error) {
    recordMessageDesignFailure(
      customType,
      "(adoption)",
      `the message threw from invalidate() after adoption (${errorMessage(error)}); its next frame ` +
        "still draws through the design.",
    );
  }
}
