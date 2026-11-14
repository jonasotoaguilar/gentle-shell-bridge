/**
 * The transform pipeline (S2, S3, S4): the general ordered pass the conversation wrapper runs
 * BEFORE the rows reach the host's frame loop, and after the card-style repaint.
 *
 * ## Why the pipeline lives here, and not in each plugin
 *
 * `pi.registerToolRenderer` runs when a tool row is BUILT (`docs/extensions.md`, "Custom
 * Rendering"), so a rendering choice made through that slot applies to the NEXT row and leaves the
 * cards already on screen untouched. `./card-style-wiring.ts` already wraps the conversation
 * component's `render(width)`, which is the one place that sees every frame, so this module turns
 * that wrapper into an extension point: registered transforms receive the rows the host produced
 * and return the rows to draw.
 *
 * ## What the pipeline guarantees
 *
 * - **Order.** `snapshotTransforms()` decides the sequence (`./bus.ts`); each transform receives the
 *   PREVIOUS transform's output, so two plugins compose without knowing about each other (S2).
 * - **Identity.** With no transform registered the input array itself is returned, which is what
 *   keeps a session that never used the feature byte-identical — the same promise the card-style
 *   transformer makes for `native` (S2).
 * - **Isolation.** A transform that throws, or that returns something which is not an array of
 *   strings, loses only its own contribution: the lines that were in force are kept, the failure is
 *   recorded with the transform's id and message, and the remaining transforms still run (S3).
 *   Nothing here can throw into the host's render, and a frame is never left without an array.
 * - **Width.** Whatever a transform returns is clipped to the width the host rendered at, with the
 *   same `clipToWidth` the card styles use, so a transform cannot make the frame wider than the
 *   terminal (S4).
 *
 * ## Diagnostics
 *
 * The outcome of the most recent frame is kept per transform, replacing the previous frame's record
 * — a report is about "now", not a history. `/bridge-status` prints it (`./status.ts`). A session
 * that registered no transform records nothing at all, which is what keeps its report unchanged.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { snapshotTransforms } from "./bus.ts";
import { clipToWidth } from "./card-style-transform.ts";
import { isRecord } from "./rows.ts";
import type { TransformContext, TranscriptTransform } from "./types.ts";

/** What the pipeline did with one transform in the most recent frame. */
export type TransformFrameStatus = "applied" | "skipped" | "failed";

/**
 * One transform's contribution to the last frame. `skipped` means it was called and left the rows
 * as they were; `failed` means it threw or returned something that is not lines, and its message
 * says which.
 */
export interface TransformFrameOutcome {
  id: string;
  status: TransformFrameStatus;
  /** Only for `failed`: what went wrong, verbatim, for `/bridge-status`. */
  message?: string;
}

interface PipelineState {
  /** The most recent frame's outcomes, in the order the transforms ran. */
  lastFrame: TransformFrameOutcome[];
}

/** Process-global, like every other piece of bridge state (`./bus.ts` explains why). */
const PIPELINE_STATE = Symbol.for("gentle-shell-bridge.transform-pipeline.state.v1");

function pipelineHost(): Record<symbol, PipelineState | undefined> {
  // SAFETY: only `pipelineState()` writes this key, and it re-checks the shape it finds.
  return globalThis as unknown as Record<symbol, PipelineState | undefined>;
}

function pipelineState(): PipelineState {
  const host = pipelineHost();
  const existing = host[PIPELINE_STATE];
  if (isRecord(existing) && Array.isArray(existing.lastFrame)) return existing as PipelineState;
  const created: PipelineState = { lastFrame: [] };
  host[PIPELINE_STATE] = created;
  return created;
}

/** What the most recent frame did with each transform, in pipeline order. A copy, never the state. */
export function getTransformFrameOutcomes(): TransformFrameOutcome[] {
  return pipelineState().lastFrame.map((outcome) => ({ ...outcome }));
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetTransformPipelineForTests(): void {
  delete pipelineHost()[PIPELINE_STATE];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a transform's return value is a row array at all. */
function isLineArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((line) => typeof line === "string");
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array with non-string entries";
  return typeof value;
}

/**
 * The transform's output, clipped to the host's width (S4). Returns `undefined` when nothing
 * changed, so the caller keeps the array it already had and identity survives a no-op.
 */
function clipResult(next: readonly string[], current: readonly string[], width: number): string[] | undefined {
  const clipped = next.map((line) => clipToWidth(line, width));
  const unchanged =
    clipped.length === current.length &&
    clipped.every((line, index) => line === current[index]);
  return unchanged ? undefined : clipped;
}

/**
 * Run the registered transforms over the frame, in order, and return the rows to draw (S2, S3, S4).
 *
 * The returned array is the input instance whenever the frame was not changed: no transform
 * registered, every transform a no-op, or every transform failing. The frame's outcome record is
 * replaced here, once per frame.
 */
export function applyTransforms(lines: string[], width: number): string[] {
  let transforms: TranscriptTransform[];
  try {
    transforms = snapshotTransforms();
  } catch {
    // The registry is process-global state written by other copies; a broken read is a pass-through
    // rather than a frame this module takes down.
    return lines;
  }
  if (transforms.length === 0) return lines;

  const ctx: TransformContext = { width };
  const outcomes: TransformFrameOutcome[] = [];
  let current = lines;

  for (const transform of transforms) {
    let next: readonly string[];
    try {
      // `transform` is validated at registration; a foreign mutation after that is still caught
      // here, because the call and the shape check are both inside this guard.
      const produced: unknown = transform.transform.call(transform, current, ctx);
      if (!isLineArray(produced)) {
        throw new Error(
          `the transform returned ${describeValue(produced)}; a transform must return an array of lines (string[]).`,
        );
      }
      next = produced;
    } catch (error) {
      // S3: this transform is skipped for the frame, and the remaining ones still run.
      outcomes.push({ id: transform.id, status: "failed", message: errorMessage(error) });
      continue;
    }

    const clipped = clipResult(next, current, width);
    outcomes.push({ id: transform.id, status: clipped === undefined ? "skipped" : "applied" });
    if (clipped !== undefined) current = clipped;
  }

  pipelineState().lastFrame = outcomes;
  return current;
}
