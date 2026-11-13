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

The package's public entry exports exactly `registerRows`, `registerSection`, `createStore`,
`STORE_SCHEMA_VERSION`, `VERSION` and the row/provider/section/store types. `snapshotProviders`,
`snapshotSections` and every `…ForTests` seam are **internal**: they exist so the bridge's own
backends and tests can read one ordered list, and they are not part of this contract.

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
pairs and reports them through `/bridge-status`, comparing the rows of the last menu build
(`no build yet` before the first build); it does not rename rows, because a row's
setting name is its identity in the renderer.

## 7. Failure isolation

A provider that throws while its rows are built loses its rows and nothing else:

- the menu still opens, with the other providers' rows;
- the failure is recorded as the last failure for `/bridge-status`, with the provider `id` and the
  error message;
- the remaining providers still apply, in order.

The same applies to an exception inside a row's `visible()` (the row is hidden) and to a
rejection from `action()`. Both sync throws and async rejections are routed by the view's
`withBusy()` to `options.onError` (`lib/visual-customize-view.ts:224-235`), which
gentle-shell already wires to an error notification; the menu stays usable.

## 8. Diagnostics: `/bridge-status`

One command, `/bridge-status`, reporting:

| Field | Meaning |
| --- | --- |
| Providers | every registered provider, `id` and `category`, in subscription order |
| Backend | which interception backend is active: `hook` or `capture` |
| Last capture | outcome of the most recent menu build, with the number of rows injected |
| Last failures | most recent provider failures: `id`, message, and whether rows were dropped |
| Store problems | store files this process could not use, with the plugin id and the reason |
| Duplicate settings | every `category` + `setting` pair contributed by more than one provider in the rows of the last menu build; `no build yet` before the first build |
| Sections | every registered section with its id, title, persisted visibility and where its position comes from (`order 3` or `registration order`); omitted when no section is registered |
| Section failures | the most recent sidebar frame's failing sections with `id`, `phase` (`lines`/`meta`) and message |
| Sidebar | `intercepted (rail wrapped)`, `intercepted (rail pending)`, `no-sidebar-state`, or `not armed` with the reason the wiring could not acquire a `tui` |

A menu that opened without the bridge's rows must show up here — armed-but-uncaptured,
shape mismatch, or provider failure. A registered section that never appears must show up
too: the sections table proves the registration, and the sidebar line proves whether the rail
was ever reached. Diagnostics never run a provider's `rows()` and never run a section's
`lines()` or `meta()`: both are UI, and a report is not a frame.

## 9. Persistence

The bridge composes rows; it does not own preferences. A plugin reads and writes its own
state. `createStore(pluginId)` is an **optional** helper for a namespaced file with atomic
writes and a schema version; a plugin may keep its own file instead, and the bridge never
reads or writes that file.

The document is `{ "schemaVersion": 1, "values": { … } }`. `values` is an envelope, so a
plugin key cannot collide with `schemaVersion`. The file lives at
`<bridge config home>/<pluginId>.json`, where `<bridge config home>` is `<gentle config
home>/gentle-shell-bridge`; `pluginId` is rejected before it reaches the filesystem unless
it is one non-empty path segment. A malformed file, or one whose `schemaVersion` is not `1`,
reads as empty and is reported by `/bridge-status`; the file is not repaired or deleted, and
a later `set` writes a valid document that carries over existing `values` entries while
dropping foreign top-level keys. Rationale and rejected alternatives: [state.md](state.md).

## 10. Sidebar sections

One call adds a card to gentle-shell's fullscreen sidebar **and** its show/hide toggle to
`/gentle:customize` → `Sections`. The plugin writes content; it never writes a `setting`, a
`value`, a `current()`, an `action()`, a `preview()`, never names the `Sections` category and
never touches the rail.

```ts
import { registerSection } from "gentle-shell-bridge";

const dispose: () => void = registerSection({
  id: "loon.music",                 // unique and stable: ordering, replacement, the toggle
  title: "MUSIC",                   // card heading, drawn like AGENTS / CHANGES / STATS
  meta: () => "1 playing",          // optional right-aligned count; omitted when blank
  lines: (ctx) => ["track  …"],     // body, evaluated per frame
  defaultVisible: true,             // absent means true
  order: 10,                        // optional integer
});
```

- `id` — registering an existing id **replaces** the previous section in place; a second
  card never appears. That is also the toggle's identity, so a replacement keeps the user's
  shown/hidden choice.
- `title` — the heading the host's own card frame draws. The bridge does not draw a box.
- `meta(ctx)` — optional right-aligned text. A throw drops that section's body (see below).
- `lines(ctx)` — the body. Evaluated **per frame**, so live state is honest with no redraw API.
- `defaultVisible` — the fallback until the user toggles the section.
- `order` — sections **with** an `order` render first, ascending; sections without one follow
  in registration order. Ties keep registration order. The rule is computed from an explicit
  sort key, never from map iteration.

`ctx` carries the same shape as `RowContext`: the resolved gentle-shell config home and the
host theme where one is available (the rail render call carries none, so a section sees
`theme: undefined`).

### Rendering

A section is drawn by the host's own card code: the bridge contributes the part's rows and
the card groups over them, and the layout calls `sectionCardRows` on them. A body row is
clipped to the width the host passes and the body is capped at 8 rows, with a visible
`… +N more` marker when the cap bites. The bridge never returns a row wider than that number —
which is **UTF-16 code units, not terminal columns**: a wide CJK glyph or an emoji counts as one
unit here, so the host may still clip what we thought fitted. A plugin that emits ANSI escape
sequences owns its own width: the bridge neither parses nor strips them.

**Sections render after the native ones. Interleaving is impossible**: the host's status
sections (`CHANGES`, `STATS`, `INTEGRATIONS`) are built in a closure the bridge cannot reach
(`lib/shell-bar.ts:247,251-316`), and the rail paints a hard-coded key order
(`lib/shell-sidebar-layout.ts:344`). The bridge therefore appends to the last painted part
(`footer`), so a section always follows every native card.

### Hidden means not built

A hidden section is not rendered **and** its `lines()`/`meta()` are not called. Hiding is a
user choice, not a request to compute something invisible.

### Failure isolation

A throwing `lines()` or `meta()`, or a return that is not the documented shape, drops that
section's body, records `{ sectionId, phase, message }` for `/bridge-status`, and leaves every
native card and every other section rendering. A non-array or a non-string row is a failure,
never coerced.

### The automatic `Sections` rows

For every registered section the bridge emits **two consecutive rows** in category
`Sections`, sharing one `choice.setting` (`Section: <id>`), with values `shown` and `hidden`:

- the label is the section title, so a user knows which line controls what;
- `current()` reads the persisted value live, so the `●` never lies;
- `action()` persists **first** and returns; the host's own repaint re-reads `current()`;
- `preview()` returns a literal depiction of the card in that state, never the host's
  "Preview unavailable" default.

Rows are built per menu build from the live registry: a section registered later appears
without re-registering anything, and a disposed section's rows disappear with it.

### Persistence: the same experience, a different file

Visibility is **bridge-owned state**, not plugin state — the bridge added the toggle, so a
plugin needs no store of its own. It is persisted through the existing `createStore` helper in
one namespaced file:

`<gentle config home>/gentle-shell-bridge/bridge-sections.json`

```json
{
  "schemaVersion": 1,
  "values": {
    "sections": { "loon.music": false }
  }
}
```

`sections` maps a section id to `true` (shown) / `false` (hidden); a missing id falls back to
`defaultVisible`. A value that is not a boolean is ignored rather than coerced.

Why not `visual-customization.json`: the host validates that file against a closed
`VISUAL_SECTION_KEYS` list (`lib/visual-customization-policy.ts:82`, `keysMatch` ~:112-130) and
rejects unknown keys, so a third-party section key cannot live there. The user experience is
identical to a native section toggle; the file deliberately is not. The blast radius is the
same per-plugin decision recorded in [state.md](state.md).

## Limits

- `registerRows` and `createStore` are the contract; anything a plugin does inside
  `action()` beyond calling inline helpers is the plugin's own business.
- Rows can join existing categories only; `category` is typed to gentle-shell's closed
  union (`lib/visual-customize-view.ts:105`).
- **Sections join the rail after the native cards, never between them.** The host's status
  sections are unreachable (a closure), so "interleaved with `CHANGES`" is not offered; the
  limit is documented rather than faked.
- The sidebar surface has been proven against a fake host that models the real rail shape
  (`test/fake-sidebar.ts`), not in a running TUI. In particular, whether the widget Pi hands
  the `tui` through renders nothing visible is **unconfirmed** (see
  [architecture.md](architecture.md) §12).
- `current()` must read live state and `action()` must persist before returning. This is a
  correctness rule the bridge cannot enforce at runtime; a plugin that caches a stale value
  renders a lying `●`.
- No priority or insertion-index API exists: order is subscription order only.
- The API is pre-release and has no compatibility guarantee yet.
