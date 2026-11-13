# Contract — `registerRows`, providers, rows, diagnostics

What a plugin can rely on. The mechanism behind it is in
[architecture.md](architecture.md); the persistence decision in [state.md](state.md).

## 1. `registerRows(provider): () => void`

```ts
const dispose: () => void = registerRows(provider);
```

Registers a row provider with the process-global bridge and returns a disposer
unsubscribing exactly that provider — no other provider's rows and no bridge state are
touched. It is safe to call from `session_start`, including after a rebind: the bridge
arms once, and a provider registered twice under the same `id` replaces its previous
registration instead of stacking rows.

Registration does **not** open the menu. Rows are built when a menu is actually
constructed.

## 2. Provider

```ts
interface RowProvider {
  id: string;                                  // unique, stable, e.g. "loon.banner-source"
  category: string;                            // a category gentle-shell already renders
  rows(ctx: RowContext): CustomizeRow[];       // evaluated lazily, per menu build
}
```

- `rows()` runs each time the menu is built, never at registration. That is what makes
  `current()` honest: the plugin reads its live state at build time, so the bullet matches
  reality before the user touches anything.
- `ctx` carries at least the active theme and the resolved gentle-shell config home. The
  theme is the one Pi passes to the factory (`factory(this.ui, theme, this.keybindings,
  close)`, `interactive-mode.ts:3136`); the config home is the directory gentle-shell
  resolves for its own files (default `~/.pi/gentle-ai`, `GENTLE_PI_CONFIG_HOME` override —
  `lib/gentle-shell-bundled.ts:231-239`), so a plugin can place per-user state without
  re-deriving the path.
- `id` is the handle used by ordering, replacement and the diagnostics report. Two
  providers may share an `id` only by replacing each other; two providers with different
  `id`s but the same `category` + `setting` conflict (see §6).

## 3. Row fields

All of these are already understood by gentle-shell's renderer
(`lib/visual-customize-view.ts:107-128`); the bridge carries them through unchanged.

| Field | Type | Behaviour |
| --- | --- | --- |
| `category` | string (existing category) | which menu page the row joins |
| `label` | `string \| (() => string)` | row text; a function is evaluated when the menu is built |
| `choice` | `{ setting, value, current(), hint?, applyOnMove? }` | one value of a setting; consecutive rows of the same `setting` share a line |
| `preview()` | `{ title, sample }` | read-only depiction of the highlighted choice, never an application |
| `visible()` | `() => boolean` | hidden when false; a throw fails closed (row hidden) |
| `keyhint` | string | footer hint for this row instead of the category default |
| `action(inline)` | `(inline) => void \| Promise<void>` | Enter/Space handler; may be async |

Inline helpers available to `action` (`lib/visual-customize-view.ts:129-140`):

- `inline.input({ prompt, value })` — inline field on the highlighted row; resolves the
  submitted string or `undefined` on cancel.
- `inline.confirm(message)` — inline confirmation; resolves `true` only after an explicit,
  fully visible yes.
- `inline.capture(prompt)` — next raw key press; resolves the key or `undefined` on Esc.

They exist so a row never opens a nested native dialog; a plugin that needs a value should
use them rather than `ctx.ui.input`.

## 4. How a toggle works

A toggle is not a widget type. Push two consecutive rows sharing the same `choice.setting`
with different `value`s:

```ts
const toggle = (value: string) => ({
  category: "Layout" as const,
  label: () => "Loon: banner source",
  choice: { setting: "Loon → Banner source", value, current: () => read() === value },
  action: () => store.set("bannerSource", value),
});

rows: () => [toggle("activity"), toggle("output")], // one rendered line
```

The renderer draws one line, `Name  ● current  ○ other`, and handles the keys itself: ←/→
applies a choice immediately, Enter applies when `applyOnMove` is `false`
(`lib/visual-customize-view.ts:565`). "Consecutive" is literal — a row between the two
values splits them into two lines.

Other row kinds follow from the same shape:

- **Command row** — no `choice`, only `action`: one line, Enter runs it.
- **Gated row** — `visible()` returns `false` (or throws) and the row disappears.
- **Preview row** — `preview()` supplies the read-only headline and sample.
- **Inline editor row** — `action` opens `inline.input()`, asks with `inline.confirm()`, or
  captures a key with `inline.capture()`.

## 5. Ordering and idempotency

- Providers apply in subscription order; their rows are appended in that order, so a
  deterministic provider set gives a deterministic menu.
- Disposing one provider leaves the others' relative order intact.
- Arming is idempotent across `session_start`, `/reload` and double loads: one interception
  layer, one injection per captured row array (non-enumerable marker on the array), one
  wrapper per UI object (non-enumerable marker on the target).
- Registering the same `id` twice yields one provider's rows and one diagnostics entry.

## 6. Conflicts

Same `category` + same `setting` from two different providers has one of two outcomes,
determined by insertion order:

- **Consecutive** in the captured array → the renderer coalesces them into a single line
  whose bullets are shared, with the two providers' `action`s behind the same setting
  (`lib/visual-customize-view.ts:395-401`).
- **Not consecutive** → two separate lines in a category, each with its own bullets, which
  reads as a duplicate to the user.

Recommended policy: **namespace the `setting`** with the plugin's name, e.g.
`"Loon → Banner source"`. Namespacing makes collisions impossible by construction and
keeps each line's meaning intact. The bridge warns on duplicate `category` + `setting`
pairs and reports them through `status`; it does not rename rows, because a row's setting
name is its identity in the renderer.

## 7. Failure isolation

A provider that throws while its rows are built loses its rows and nothing else:

- the menu still opens, with the other providers' rows;
- the failure is recorded as the last failure for `status`, with the provider `id` and the
  error message;
- the remaining providers still apply, in order.

The same applies to an exception inside a row's `visible()` (the row is hidden) and to a
rejection from `action()`. Both sync throws and async rejections are routed by the view's
`withBusy()` to `options.onError` (`lib/visual-customize-view.ts:224-235`), which
gentle-shell already wires to an error notification; the menu stays usable.

## 8. Diagnostics: `status`

One command, `status`, reporting:

| Field | Meaning |
| --- | --- |
| Providers | every registered provider, `id` and `category`, in subscription order |
| Backend | which interception backend is active |
| Last capture | outcome of the most recent menu build, with the number of rows injected |
| Last failures | most recent provider failures: `id`, message, and whether rows were dropped |

A menu that opened without the bridge's rows must show up here — armed-but-uncaptured,
shape mismatch, or provider failure. That is the contract's answer to "the plugin is
installed but nothing appeared".

## 9. Persistence

The bridge composes rows; it does not own preferences. A plugin reads and writes its own
state. `createStore(pluginId)` is an **optional** helper for a namespaced file with atomic
writes and a schema version; a plugin may keep its own file instead, and the bridge never
reads or writes that file. Rationale and rejected alternatives: [state.md](state.md).

## Limits

- `registerRows` and `createStore` are the contract; anything a plugin does inside
  `action()` beyond calling inline helpers is the plugin's own business.
- Rows can join existing categories only; `category` is typed to gentle-shell's closed
  union (`lib/visual-customize-view.ts:105`).
- `current()` must read live state and `action()` must persist before returning. This is a
  correctness rule the bridge cannot enforce at runtime; a plugin that caches a stale value
  renders a lying `●`.
- No priority or insertion-index API exists: order is subscription order only.
- The API is pre-release and has no compatibility guarantee yet.
