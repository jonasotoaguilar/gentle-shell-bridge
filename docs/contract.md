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
`STORE_SCHEMA_VERSION`, `VERSION`, the runtime helpers `bridgeApi`, `isBridgeApi`, `onBridgeApi`,
the announcement channel `BRIDGE_READY_EVENT` (§9), and
the row/provider/section/store/API types. `snapshotProviders`, `snapshotSections`,
`publishBridgeApi`, `announceBridgeReady` and every `…ForTests` seam are **internal**: they exist so
the bridge's own backends and tests can drive one process, and they are not part of this
contract.

## 2. Provider

```ts
interface RowProvider {
  id: string;                                  // unique, stable, e.g. "loon.banner-source"
  category: string;                            // a category gentle-shell already renders
  name?: string;                               // optional: this plugin's INTEGRATIONS row (§8)
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
  label: () => "Loon banner source",
  choice: { setting: "Loon banner source", value, current: () => read() === value },
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

### Row names

`choice.setting` (the line's name) and `label` (the row's text) are what a human reads, so both obey
ONE shape: **one to three plain words**, title case like the host's own rows (`Card style`,
`Card content`), and **none of** `→ ← ↑ ↓ : . | / \ [ ] ( ) { }`. No trailing qualifier — the
category already says where the row lives, and the values already say what the choices are:

```text
Bash rendering                  OK    a row name: the host's own vocabulary
Bash card → Bash rendering      BAD   arrow and a repeated qualifier: reads as a breadcrumb
Bash card: rendering            BAD   colon
Section: bash-card.status       BAD   prefix plus a dotted id
```

The bridge enforces the shape instead of trusting authors; it is never a silent rewrite:

- a provider row whose line name or label breaks it is **dropped from the menu build** — absent
  from the rows the host receives AND from the rows `/bridge-status` compares for duplicates, so it
  is not part of the effective set;
- a section or a card style whose `rowLabel` breaks it is **not registered at all**;
- the offending string is recorded verbatim with the rule it broke, and `/bridge-status` lists it
  under `row name rejections`. The menu never shows a sanitized version of a name the bridge refused,
  so the exact string in the report is the one to fix.

Derived names (a section `title`, a card style `label`) cannot violate the shape: derivation drops
every non-word character — marks included — and clamps the result to the same word limit. The
clamp is the only transformation the bridge performs, and only on text it derives itself.

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

Recommended policy: **pick a distinct plain-word name**, e.g. `"Loon banner source"` rather than
`"Banner source"`. Namespacing with punctuation (`"Loon → Banner source"`) is not an option: the
row-name shape forbids arrows and colons, and the bridge rejects such a name before it is stored
(see §4, "Row names"). The bridge warns on duplicate `category` + `setting` pairs and reports them
through `/bridge-status`, comparing the rows of the last menu build (`no build yet` before the first
build); it does not rename rows, because a row's setting name is its identity in the renderer.

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
| Sections | every registered section with its id, title, the `row` label the menu reads (and the collision note when two wanted the same label), persisted visibility (plus `collapsed` while the card is folded) and where its position comes from (`order 3` or `registration order`); omitted when no section is registered. Ids stay here on purpose: this report is for the plugin author, not the user picking a toggle |
| Section frame | which drawing the section header and rows use: `host` when the host's own `renderPanelHeader`/`renderPanelRow` were found on an object the bridge is handed, `fallback` otherwise — with what was looked for, whether Pi has handed the widget factory a theme, and (for `fallback`) a `section frame gap` line naming what cannot be reached. Emitted with the sections table |
| Section interaction | how the pointer reaches the rows: the host's own `handleMouse` dispatch, and how the hover claim is carried (`hover owner claimed on the host's sidebar state`, `unavailable` with the reason, or `not used yet`). Emitted with the sections table |
| Section failures | the most recent sidebar frame's failing sections with `id`, `phase` (`lines`/`meta`/`onClick`) and message |
| Sidebar | `intercepted (rail wrapped)`, `intercepted (rail pending)`, `no-sidebar-state`, or `not armed` with the reason the wiring could not acquire a `tui` |
| Transforms | every registered transcript transform in pipeline order (`order 3` or `registration order`) with the last frame's outcome: `applied`, `skipped`, `failed` with the message, or `not run`; omitted when no transform is registered |
| Card style surfaces | per surface (`conversation`, `rail`): whether the selected style reached it and what its last frame did there (`transformed N cards`, `pass-through (native / missing / no card)`, `failed` with the style and message); `not reached` carries the attach outcome (`no-layout-root`, `no-sidebar`, `no-rail`, …). Emitted with the card-style block |
| Last repaint | the most recent repaint a bridge-owned write requested: the surfaces, the cause (`section "loon.music" → hidden`, `card style → loon.cute`) and `repainted` or `unavailable` with the reason. Omitted until such a write happens |
| Row name rejections | every line name and row label the bridge refused (`rows`, `section` or `card style`), with the surface, the registration `id`, the field (`line name`/`row label`), the offending string VERBATIM and the rule it broke; omitted when nothing was rejected |
| Plugin lines | one entry per plugin that registered (`rows`, `section`, `card style` or `transform`): its row name and whether it was `derived from package "@acme/loon-kit"` or an `explicit name`, the registrations `accepted` and `rejected`, and whether the line is `set` or, with the reason, `no line set`. The header also says when the host's `setStatus` was unavailable. Omitted when no plugin registered so far |

A menu that opened without the bridge's rows must show up here — armed-but-uncaptured,
shape mismatch, or provider failure. A registered section that never appears must show up
too: the sections table proves the registration, and the sidebar line proves whether the rail
was ever reached. Diagnostics never run a provider's `rows()` and never run a section's
`lines()` or `meta()`: both are UI, and a report is not a frame.

### The plugin's INTEGRATIONS line

`ctx.ui.setStatus(key, text)` paints one row in the host's INTEGRATIONS card, and `undefined`
removes it. The bridge sets exactly **one** row per plugin, no matter how many rows, sections,
card styles or transforms that plugin registers (one plugin, one line).

- **The text is opaque.** The host renders the whole string as one row; it is not parsed into a
  key and a value, so everything the row says must be inside it: `Loon kit · ready`. The host's
  `sanitizeStatus` strips ANSI sequences and collapses whitespace, so **ANSI is not yours** and a
  glyph must be part of the text itself (the host's own fixture row is `🧠 gentle-pi · ready`).
- **Colour belongs to the host.** Every entry is painted with one shared status role. A plugin
  cannot choose a colour; it can only choose a glyph.
- **The name is derived, not configured.** The bridge captures the module that registered, resolves
  it to its owning `package.json` and derives one to three plain words from its `name`
  (`@acme/loon-kit` → `Loon kit`). The answer is cached per module. A module with no owning package
  (a single copied file) gets NO row, and `/bridge-status` says why. Any registration kind accepts an
  optional `name`, honoured on the plugin's **first** registration only, which overrides the derived
  name; that is how a single-file extension names itself.
- **The name obeys the row-name shape** (§4, Row names). A derived name is cleaned; when nothing
  usable is left there is no row. An explicit name is validated, never rewritten: a rejected name
  produces no row at all.
- **The state is derived, never promised.** `ready` means every registration the bridge accepted;
  one rejected registration (an invalid id, a row label that broke the shape rule) repaints the same
  key as `degraded`, and this report names the rejected items.
- **One key, painted in place.** A plugin's key is stable for its lifetime; every later change
  repaints that same key, and `session_shutdown` clears it with `undefined`. A `ctx.ui` without
  `setStatus` skips the whole feature and is reported here instead of throwing into a registration.

The row name is the diagnostic column's label; the key and the module path stay in this report,
because it is read by the plugin author, not by the user reading the footer.

## 9. Reaching the bridge — `session_start`, or the announcement

**The rule: register at `session_start` if the package loaded first, otherwise when the
announcement arrives.** Pi loads every extension module and waits for its async initialization
before it fires `session_start` (`docs/extensions.md:213`), and it fires that event for `startup`,
`reload`, `new`, `resume` and `fork` (`:393`). But it does not guarantee that THIS package loaded
before the plugin: global extensions (`~/.pi/agent/extensions`) load — and receive `session_start` —
before a configured package's module publishes. A real TUI showed exactly that, with the plugin's
handler finding no symbol while the bridge went on to publish a moment later.

So an absent symbol at `session_start` is **"not yet"**, not "not installed". The symbol stays the
only authority for *which* object to use; the announcement below is how a plugin learns that a
later publication happened. The bridge publishes its object as its module loads, and the process is
told once, on Pi's cross-extension bus.

### What is published

`Symbol.for("gentle-shell-bridge/api/v1")` holds exactly:

```ts
Object.freeze({
  schema: "gentle-shell-bridge/api", // identity, so a foreign payload is never mistaken for ours
  version: 1,                        // the major; a breaking change is a NEW symbol key
  VERSION: "0.3.0",                  // the publishing release; informational only
  registerRows,
  registerSection,
  registerCardStyle,                 // since 0.2.0; optional on an older published object
  registerTransform,                 // since 0.3.0; optional on an older published object
  createStore,
});
```

Publication is **first wins**: a compatible object already in the slot is kept and never replaced,
and the slot is never reset. A consumer gates on the schema string, `version === 1` and the three
callable members below — `registerCardStyle` and `registerTransform` are NOT part of the gate, so an
object published by an older copy is still a usable bridge for rows, sections and the store; a plugin
that needs a later surface checks `typeof api.registerCardStyle === "function"` (or
`typeof api.registerTransform === "function"`) before calling it. Anything else — another library's
payload, another major, a partial object — is
**absent**, never an error: the object is not used, the slot is left exactly as it is (never
overwritten, deleted or reset), and one notice per process names the mismatch. `v1` in the key is
the major: a breaking change is a new `v2` key, never a mutation of this one.

### Two ways to read it

Read the symbol directly — no import, the form the worked example uses. The `session_start` attempt
is kept, and the announcement covers a bridge that publishes after this file loaded:

```ts
const KEY = Symbol.for("gentle-shell-bridge/api/v1");
const isApi = (value: any): boolean =>
  typeof value === "object" && value !== null &&
  value.schema === "gentle-shell-bridge/api" && value.version === 1 &&
  typeof value.registerRows === "function" &&
  typeof value.registerSection === "function" &&
  typeof value.createStore === "function";

const register = (): boolean => {
  const api = (globalThis as any)[KEY];
  if (!isApi(api)) return false;
  // api.registerRows(...) / api.registerSection(...) / api.createStore(...)
  return true;
};

const registered = register();
if (!registered) pi.events?.on("gentle-shell-bridge:ready", register);

pi.on("session_start", (_event, ctx) => {
  if (!register()) {
    ctx.ui?.notify(
      "my-plugin: waiting for gentle-shell-bridge to announce itself",
      "warning",
    );
  }
});
```

Or import the package and call `onBridgeApi(handler, pi.events)`, which does both forms for you: the
handler runs immediately when the object is already published (and no listener is taken), otherwise
it runs when the announcement arrives, once, after which the subscription removes itself.

```ts
import { onBridgeApi, type BridgeApi } from "gentle-shell-bridge";

const register = (api: BridgeApi): void => {
  // api.registerRows(...) / api.registerSection(...) / api.createStore(...)
};

// Works in both orders: this package loaded first, or the plugin did.
const dispose = onBridgeApi(register, pi.events);
```

`bridgeApi()` never waits, defers or retries: it answers about the slot as it is right now.

### The announcement: `gentle-shell-bridge:ready`

When this package publishes its object, it emits one event on Pi's cross-extension bus
(`docs/extensions.md:1965-1972`), the same channel gentle-shell's other extensions use:

```ts
pi.events.on("gentle-shell-bridge:ready", (payload) => {
  // { schema: "gentle-shell-bridge/api", version: 1, VERSION: "0.3.0" }
});
```

- **Name:** `gentle-shell-bridge:ready`. Payload: `{ schema, version, VERSION }` — the same identity,
  major and release the published object carries, frozen. Informational only: the payload says
  *which* bridge announced itself, never *what* it can do.
- **Emitted once per process**, after a successful publish, no matter how many copies of the package
  Pi loaded (`moduleCache: false` gives it one module instance per extension, not one per process).
- **Never for an incompatible slot.** If the symbol holds another library's payload or another major,
  nothing is announced: there is no object to send a listener to, and `bridgeApi()` stays
  `undefined`.
- **Silent without a bus.** On a Pi with no `pi.events`, nothing is emitted and nothing is reported;
  the symbol still works for any plugin that reads it.
- **It is a notification, not a registry.** The listener still reads the symbol and applies the gate:
  an announcement that is not backed by a compatible object is ignored. That is why the event can
  never hand out a half-working API.

The order that matters: the announcement may arrive before or after the plugin's `session_start`,
and registration is idempotent by stable id, so a plugin may register from both paths.

### Surface 1: rows for a customize category

One provider contributes rows to a category the host already renders. A toggle is two
**consecutive** rows sharing one `choice.setting`:

```ts
const store = api.createStore("loon");
const read = () => store.get("bannerSource", "activity");

const toggle = (value: string) => ({
  category: "Cards" as const,
  label: () => "Loon banner source",
  choice: {
    setting: "Loon banner source",
    value,
    current: () => read() === value, // live: read at render time, so the ● never lies
  },
  preview: () => ({ title: value, sample: "literal depiction of this choice" }),
  action: () => store.set("bannerSource", value), // persist FIRST; the host repaints after
});

const dispose = api.registerRows({
  id: "loon.banner-source",
  category: "Cards",
  rows: () => [toggle("activity"), toggle("output")], // consecutive rows → one line
});
```

Nothing may sit between the two values or the renderer draws two lines. `current()` is evaluated
when the menu is built, `action()` runs before the host's own repaint, and `preview()` replaces the
host's "Preview unavailable" default. `dispose()` removes exactly this provider's rows.

### Surface 2: a sidebar section

One call adds the card to gentle-shell's fullscreen sidebar **and** its show/hide toggle to
`/gentle:customize` → `Sections`. The plugin writes content only; it never names a `setting`, a
value, the `Sections` category or the rail:

```ts
const dispose = api.registerSection({
  id: "loon.music",             // unique and stable: ordering, replacement, the toggle
  title: "MUSIC",               // card heading, drawn by the host's own frame
  rowLabel: "music",            // optional: what the Sections row reads (derived from title when absent)
  meta: () => "1 playing",      // optional right-aligned text
  lines: () => ["track  Blue in Green", "album  Kind of Blue"], // per frame, live
  defaultVisible: true,         // absent means true
  order: 10,                    // optional integer
});
```

The bridge generates the `Sections` rows for it: two consecutive rows sharing one label,
values `shown` / `hidden`, with a live `current()` and a persist-first `action()`. The label — not
the id — is the line's name: `music  ● shown  ○ hidden`, next to the host's own
`stats  ● shown  ○ hidden`. A hidden section is not rendered and its `lines()`/`meta()` are not
called. A throw loses only that section's body and is reported by `/bridge-status`. `dispose()`
removes the card and the toggle together, leaving every other section untouched.

### Surface 3: the optional namespaced store

`createStore(pluginId)` is optional. A plugin may keep its own file instead; the bridge never reads
or writes that file.

```ts
const store = api.createStore("loon");
store.set("bannerSource", "activity");
const value = store.get("bannerSource", "activity"); // caller's fallback when absent or unreadable
```

The document is `{ "schemaVersion": 1, "values": { … } }` at
`<gentle config home>/gentle-shell-bridge/<pluginId>.json`. `values` is an envelope, so a plugin
key cannot collide with `schemaVersion`. Writes are atomic: a temporary file in the same directory,
then a rename over the target. `pluginId` is rejected before any filesystem access unless it is one
non-empty path segment. A malformed file or an unknown `schemaVersion` reads as empty and is
reported by `/bridge-status`; it is not repaired or deleted, and a later `set` writes a valid
document. Details and the rejected alternatives: §10 and [state.md](state.md).

### When the API is absent: the plugin decides

| What the handler sees | What it means | What the plugin may do |
| --- | --- | --- |
| `bridgeApi() === undefined`, or the direct read is `undefined`, **and no announcement arrived** | no bridge has published in this process (yet) | notify and continue, wait for `gentle-shell-bridge:ready`, or fail loudly — say which |
| the object fails the gate | another library's payload, another major, or a partial object | same as absent: never call it |
| a compatible object | the bridge is installed, with every surface above | register, then forget about load order |

Absent is still absent: `bridgeApi()` describes the slot as it is right now. What changed is the
conclusion a plugin draws from it — "not installed" is only honest when no announcement can arrive
(a Pi without `pi.events`, or a plugin that chose not to listen). The bridge cannot tell a plugin
what to do when it is absent, and does not try: notify-and-continue, a local fallback and a loud
failure are all legitimate, and only the plugin knows which one fits.

### The compatibility cliff, on purpose

An older bridge publishes nothing at this key, so a newer plugin sees **absent** instead of being
deferred silently. A newer bridge and an older plugin meet the same way when the plugin's gate
demands a member the old object does not have. That is the intended answer: a plugin can always
tell the user it found no compatible bridge, and no registration can sit invisible in a holding
area waiting for a version that will never arrive.

## 10. Persistence

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

## 11. Sidebar sections

One call adds a card to gentle-shell's fullscreen sidebar **and** its show/hide toggle to
`/gentle:customize` → `Sections`. The plugin writes content; it never writes a `setting`, a
`value`, a `current()`, an `action()`, a `preview()`, never names the `Sections` category and
never touches the rail.

```ts
import { registerSection } from "gentle-shell-bridge";

const dispose: () => void = registerSection({
  id: "loon.music",                 // unique and stable: ordering, replacement, the toggle
  title: "MUSIC",                   // card heading, drawn like AGENTS / CHANGES / STATS
  rowLabel: "music",                // optional: the text the Sections row reads
  meta: () => "1 playing",          // optional right-aligned count; live, read per frame
  lines: (ctx) => [                 // body, evaluated per frame
    "track  Blue in Green",         // a plain string: drawn byte for byte, as before
    {                               // or a structured row, drawn like a native one
      glyph: "▸",
      label: "album",
      meta: "Kind of Blue",
      tone: "muted",                // text | muted | dim | accent | success | error | warning
      onClick: () => play(),        // only a row with onClick is clickable
    },
  ],
  defaultVisible: true,             // absent means true
  order: 10,                        // optional integer
});
```

- `id` — registering an existing id **replaces** the previous section in place; a second
  card never appears. It is the toggle's identity (replacement, disposer and the persisted
  visibility key), and it is **internal**: it never appears in a row.
- `title` — the heading the host's own card frame draws. The bridge does not draw a box.
- `rowLabel` — optional: what the `Sections` row reads, e.g. `music`. When absent the bridge
  derives one from `title`: lowercase words joined by spaces, dots and punctuation dropped, no
  prefix, clamped to three words (`"BASH CARD"` → `"bash card"`, `"usageCost"` → `"usage cost"`,
  `"MUSIC PLAYER NOW PLAYING"` → `"music player now"`). Two sections whose labels would read the
  same are told apart deterministically (`music`, `music 2`, …) and `/bridge-status` says which one
  moved. A `rowLabel` that breaks the row-name shape (one to three plain words, no arrow, colon,
  dot, pipe, slash or bracket — see §4) is rejected: the section is not registered, and the
  offending string is reported under `row name rejections`. Nothing is rewritten.
- `meta(ctx)` — optional right-aligned text. Read per frame, so a value that changes is drawn on the
  next frame without re-registering. A throw drops that section's body (see below).
- `lines(ctx)` — the body. Evaluated **per frame**, so live state is honest with no redraw API. A row
  is a plain string or a structured row (see below).
- `defaultVisible` — the fallback until the user toggles the section.
- `order` — sections **with** an `order` render first, ascending; sections without one follow
  in registration order. Ties keep registration order. The rule is computed from an explicit
  sort key, never from map iteration.

`ctx` carries the same shape as `RowContext`: the resolved gentle-shell config home and, now that Pi
hands the bridge a theme (`ctx.ui.setWidget(key, (tui, theme) => …)`), the host theme — so a section
can paint with the same roles the rest of the shell uses. Before the widget factory runs, `theme` is
`undefined` and the card is drawn uncoloured; `/bridge-status` says which.

### Body rows

A row is a plain **string** or a structured **row object**:

```ts
{ label: string; meta?: string; glyph?: string; tone?: Tone; onClick?: () => void }
```

- a plain string is drawn **byte for byte**: the author's characters, clipped to the width, no
  indent, no padding, no styling. Every section written before structured rows existed looks
  exactly the same;
- a structured row is drawn the way the host draws its own `AGENTS` rows: indent, `glyph label` on
  the left, the right-aligned dimmer `meta`, and the parts painted with the host's roles;
- `tone` names one of the host's own roles — `text`, `muted`, `dim`, `accent`, `success`, `error`,
  `warning` — and never a colour or an SGR code. Anything else is **rejected**;
- `onClick` is what makes a row clickable. A row without it is **inert**: it never highlights under
  the pointer and never answers a click;
- `meta` is read at render time, so the same registration can show a value that moves (a mode, a
  count, an elapsed time) with no re-registration.

The bridge maps physical rows to row identity and answers the host's own pointer dispatch; clicking
an actionable row runs exactly one `onClick`, once per click. A throwing `onClick` is recorded (phase
`onClick`) and never escapes into the host.

### Rendering

A section is drawn by the host's own card code: the bridge contributes the part's header and rows and
the card groups over them, and the layout calls `sectionCardRows` on them. The HEADER is the host's
header — caret from the section's own collapse state, uppercase title, right-aligned `meta`, the
host's hover accent.

Where those two builders come from is reported, not assumed. The host's own
`renderPanelHeader`/`renderPanelRow` live in gentle-shell's `lib/shell-panel.ts`, which this package
cannot import (Pi loads each extension in its own module graph). So the bridge **looks** for them on
every object it is handed — the rail part, the Pi theme, the terminal's sidebar state — and:

- when it finds them, it draws with them and `/bridge-status` reports `section frame: host`;
- otherwise it draws with a byte-identical port of the same algorithm (proved against the host's
  code transcribed into `test/section-panel.test.ts`) and reports `section frame: fallback` plus the
  gap, naming exactly what was looked for.

A plain string row is clipped to the width the host passes and the body is capped at 8 rows, with a
visible `… +N more` marker when the cap bites. A structured row is fitted by the panel builder, which
measures **columns** (SGR-aware). The bridge never returns a row wider than that number — for a
PLAIN row the measure is **UTF-16 code units, not terminal columns**, so a wide CJK glyph or an emoji
counts as one unit there and the host may still clip what we thought fitted; a plugin that emits ANSI
escape sequences in a plain row owns its own width.

**Sections render after the native ones. Interleaving is impossible**: the host's status
sections (`CHANGES`, `STATS`, `INTEGRATIONS`) are built in a closure the bridge cannot reach
(`lib/shell-bar.ts:247,251-316`), and the rail paints a hard-coded key order
(`lib/shell-sidebar-layout.ts:344`). The bridge therefore appends to the last painted part
(`footer`), so a section always follows every native card.

### Collapsing

The header is the section's collapse control, as it is for the host's own cards: clicking it folds
the card. A collapsed section is its header alone — the body is **not built**, not built and hidden,
so `lines()` is not called while it is folded. The folded state is bridge-owned store state (the
plugin writes no flag and no setting for it), and a click persists it and asks for the frame in the
same call.

### Live updates and the digest

`meta()` and `lines()` are read per frame, and the bridge folds what they produced into the rail
part's `digest`. The host's layout re-renders a part only when that value moves
(`lib/shell-sidebar-layout.ts:114-119`), so a row field that changed — a mode, a count, a hovered row
— reaches the screen with no re-registration and no timer. The host's own digest stays part of the
value; when nothing contributes rows, the host's answer is passed through unchanged.

### Hidden means not built

A hidden section is not rendered **and** its `lines()`/`meta()` are not called. Hiding is a
user choice, not a request to compute something invisible.

### Failure isolation

A throwing `lines()` or `meta()`, or a return that is not the documented shape, drops that
section's body, records `{ sectionId, phase, message }` for `/bridge-status`, and leaves every
native card and every other section rendering. A non-array, a sparse array, or a row that is not a
string and has no string `label` is a failure, never coerced; so is a `tone` outside the seven host
roles, a non-string `meta`/`glyph`, and an `onClick` that is not a function. A throwing `onClick` is
recorded with phase `onClick`.

### The automatic `Sections` rows

The host's own `Sections` rows are bare labels: `changes`, `rdd`, `agents`, `todo`,
`usageCost`, `modelDetails`, `contextWarning`, `stats`. The bridge's rows read the same way — a
label the user reads, never an id and never a prefix:

```text
stats             ● shown  ○ hidden     ← the host's own row
music             ● shown  ○ hidden     ← a plugin's section (id "loon.music", title "MUSIC")
```

For every registered section the bridge emits **two consecutive rows** in category `Sections`,
sharing one label as their `choice.setting` (the host prints the setting as the line's name) with
values `shown` and `hidden`:

- the label is the author's `rowLabel`, or `title` made readable (lowercase, words joined, no dots,
  no prefix, clamped to three words); the same string is the row `label` and the line's `setting`.
  An author's `rowLabel` must satisfy the row-name shape (§4): one that does not is rejected, the
  section is never registered, and the string and the rule appear under `row name rejections`;
- `current()` reads the persisted value live, so the `●` never lies;
- `action()` persists **first** and returns; the host's own repaint re-reads `current()`;
- `preview()` returns a literal depiction of the card in that state, never the host's
  "Preview unavailable" default.

**The id is internal, the label is public.** `id` keys the registry (replacement and ordering), the
`Sections`-row disposer and `bridge-sections.json`; it is never rendered. The label is the only
thing a user sees.

**Two sections never collide.** If two labels would read the same, the bridge disambiguates in
render order: the first keeps the label, the next gets the lowest free suffix (`music`, `music 2`,
`music 3`, …), never the raw id. The assignment is recomputed per menu build from the live
registry, so it is deterministic for a given set of registrations. `/bridge-status` reports the
label in force for each section and names the collision, so the menu and the report can never
disagree. A title with no letters or digits at all derives to `section` (the fallback word)
rather than an empty or id-shaped label.

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
    "sections": { "loon.music": false },
    "collapsed": { "loon.music": true }
  }
}
```

`sections` maps a section id to `true` (shown) / `false` (hidden); a missing id falls back to
`defaultVisible`. `collapsed` maps a section id to `true` (folded) / `false` (open); a missing id is
OPEN, the state a card a user has never folded starts in. A value that is not a boolean is ignored
rather than coerced. Both maps are bridge-owned: the plugin writes neither a flag nor a setting.

Why not `visual-customization.json`: the host validates that file against a closed
`VISUAL_SECTION_KEYS` list (`lib/visual-customization-policy.ts:82`, `keysMatch` ~:112-130) and
rejects unknown keys, so a third-party section key cannot live there. The user experience is
identical to a native section toggle; the file deliberately is not. The blast radius is the
same per-plugin decision recorded in [state.md](state.md).

## 12. Card styles

One call adds a card style to gentle-shell's conversation cards — a third option on the same
`Card style` line the host already draws, with no change to the host.

```ts
import { registerCardStyle } from "gentle-shell-bridge";

const dispose: () => void = registerCardStyle({
  id: "loon.cute",              // identity: replacement and ordering key, and the stored value
  label: "cute",                // what the user reads; unique among the line's values
  rowLabel: "cute",             // optional: what this style's row reads (derived from label when absent)
  order: 10,                    // optional: ordered styles first, ascending, then registration order
  frame: { top, line, bottom }, // the three functions below; nothing else is called
  preview: () => ({ title: "Cute", sample: "○ cute  ╭─ welcome ─╮" }), // optional, literal
});
```

The id never appears in a row: the host's line reads `Card style  ○ neon ● float ○ cute`, and the
style's own row is labelled `cute` (or the author's `rowLabel`), exactly like a host row's visible
text. `label` stays the line's value — the text the host renders and the uniqueness rule applies to
— while `rowLabel` is what the menu row reads when it is not a setting line.

### The frame contract

```ts
top(ctx: { width: number; title?: string; hint?: string }): string;
line(ctx: { text: string; width: number; first: boolean }): string;
bottom(ctx: { width: number }): string;
```

`width` is the width the host rendered at. `title` is the heading the host printed, without its
glyph and without the right-aligned hint; `hint` is that hint when its style runs prove it is one
(a subtitle is never passed as a hint, and when the split is not provable the whole remainder
arrives as `title` with `hint` undefined). `line` receives one body row at a time, `first` true for
the card's first row. The bridge extracts all of it and passes it in; a style parses nothing. A row
a style returns wider than `width` is clipped before it reaches the screen.

### The host's own line is extended, never duplicated

At capture the bridge locates the host's `Card style` rows (category `Cards`, that `setting`),
splices them out and puts them back at the same index, immediately followed by one row per
registered style, all sharing the host's `setting`. The host coalesces consecutive rows that share a
setting, so the user sees ONE line in the host's own position:

```text
Card style  ○ neon ● float ○ cute
```

The host's own rows keep the host's `current()` and `action()`, wrapped in exactly two ways:
`current()` reports `false` while a registered style is selected (one bullet at a time), and
`action()` also returns the bridge to native rendering (below). The bridge never reimplements
`neon`/`float` and never writes the host's `card-style.json`.

### Which surfaces a style reaches

A style is one global choice, so it paints **both** surfaces the host frames cards on:

- **the conversation** — the chat component, whose `render(width)` the bridge wraps;
- **the rail** — the fullscreen sidebar, whose section cards the host frames itself
  (`lib/shell-sidebar-layout.ts:36-47`) and whose framed rows the bridge repaints through the same
  `transformCardLines` the conversation uses. Host sections (`CHANGES`, `AGENTS`, …) and the
  sections a plugin contributed are restyled alike, because the rail frames them with one function.

`native` is the pass-through on both: the host's own frames reach the screen as the same array
instance the host produced. A plugin registers nothing extra for the rail — the style it already
declared is the whole change (the example's `plain` is the proof), and `/bridge-status` reports each
surface separately (`card style surface conversation: …`, `card style surface rail: …`) so "the
conversation changed but the sidebar did not" is answerable.

The rail is restyled only where the host already drew a `float` frame: a `neon` rail, a panel
surface, or any row the bridge cannot prove is a card passes through untouched.

### A selection repaints, synchronously

Pressing a value writes the selection and then repaints, before the action returns: the host's own
`invalidateSidebar` step (its terminal-side cache revision) and `requestRender()`. A press that
selects the value already stored requests no frame. The same rule covers a section's shown/hidden
toggle, which repaints the rail. When no `tui` has been captured, or it has no `requestRender`, the
write still lands and `/bridge-status` reports `last repaint: … (unavailable: …)` — a write that
reached no surface is never silent.

### The way back to host rendering

Pressing a host value (`neon`/`float`) **is** the way back: the host's own action runs, and the
bridge clears its selection to `native` in a `finally`, so even a throwing setter cannot leave the
session trapped inside a bridge style. The host's values are native rendering.

### Fallback mode

If the host's line cannot be located (a renamed setting, a menu without `Cards`, no capture at
all), the bridge contributes its own line instead — `Bridge card style`, with `native` plus every
registered style. `native` means "the bridge leaves the conversation alone". `/bridge-status`
reports which mode is in force; the values are never dropped to fit a narrow terminal, and the
bridge does not control that width.

### The selection

The selection is the bridge's state, not the plugin's:
`<gentle config home>/gentle-shell-bridge/bridge-card-style.json`.

```json
{ "schemaVersion": 1, "values": { "cardStyle": "loon.cute" } }
```

`cardStyle` is a style id or `native`. A missing file, an unreadable one, an unknown
`schemaVersion` or a non-string value reads as `native`. A stored id whose style was disposed
resolves to **missing**, which behaves exactly like `native` — no chrome is drawn for a style that
no longer exists — and `/bridge-status` says `selection: … (missing: not registered)`. That is the
whole degrade rule: choosing a style is opt-in, and losing the plugin that owns it can never leave a
conversation broken.

### What a registration must satisfy

- `id`: a non-empty string, not `__proto__`/`constructor`/`prototype`, no NUL byte, and not a value
  the line already shows (`neon`, `float`, `native`).
- `label`: a non-empty string, unique — case-sensitively, as the host displays it — among the
  line's values (another registered style's label or the host's own). Two values reading the same
  cannot be told apart.
- `rowLabel`: optional; the text this style's row reads, used verbatim. Absent, it is derived from
  `label` (lowercase words, no dots, no prefix, at most three words). The same row-name shape as
  every other row applies (§4): one that breaks it is rejected — the style is not registered, and
  the string and the rule are reported under `row name rejections`. An empty one is rejected too.
  The `id` is never a row label.
- `frame.top`, `frame.line`, `frame.bottom`: functions. Any failure throws **before** anything is
  stored, like the row and section id rules.
- Registering an existing `id` replaces that style in place; `dispose()` removes exactly the one
  registration it created, and calling it twice is a no-op.

### What cannot be promised

- A later post-processor that rewrites the conversation — a component that re-frames the rows and
  strips box chrome — can erase this frame. The bridge cannot prevent it, and
  `/bridge-status` says so instead of pretending otherwise, naming the mechanism and no product.
- The repaint depends on the host's own `float` grammar (see
  [architecture.md](architecture.md) §14): a card drawn some other way is left exactly as it is.
- A style never breaks the conversation: any throw inside detection or inside a style makes that
  frame a pass-through and is reported.

## 13. Transcript transforms

One call adds a function that sees the conversation's rows on **every frame** and returns the rows to
draw. It is the layer a rendering choice needs, because `pi.registerToolRenderer` resolves once, when
a tool row is BUILT: a choice made there can only reach the NEXT row, while a transform runs inside
the wrapper the bridge already installs on the conversation component
([architecture.md](architecture.md) §15).

```ts
import { registerTransform } from "gentle-shell-bridge";

const dispose: () => void = registerTransform({
  id: "loon.gutter",        // unique and stable: ordering, replacement, the /bridge-status name
  order: 10,                // optional: ordered transforms run first, ascending
  transform: (lines, ctx) => lines.map((line) => `│ ${line}`.slice(0, ctx.width)),
});
```

### What the transform receives

`lines` is the frame's rows: the host's own output, after the card-style repaint when a style is
selected (so a transform sees what the user would have seen), and after every transform that ran
before it — the pipeline is ordered, and each transform receives the previous one's output.
`ctx.width` is the width the host rendered at.

A transform receives LINES and nothing else: no tool name, no arguments, no result object. A plugin
that needs tool metadata uses `pi.registerToolRenderer` for rows yet to be built; a plugin that needs
a rendering choice to apply to rows ALREADY on screen uses a transform.

### What the bridge guarantees

- **Order.** Transforms with an `order` run first, ascending, then the rest in registration order —
the rule sections and card styles already use. The sequence is snapshotted once per frame.
- **Width.** Whatever a transform returns is clipped to `ctx.width` with the same `clipToWidth` the
card styles use, so it cannot make the frame wider than the terminal. A clipped styled row gets a
reset appended; nothing is padded to fit.
- **Isolation.** A transform that throws, or that returns something which is not an array of
strings, loses only its own contribution for that frame: the lines in force are kept, the failure is
recorded with its id and message, and the remaining transforms still run. Nothing a transform does
can throw into Pi's render.
- **Identity.** With no transform registered the wrapper returns the host's own array instance, and a
transform that returns its input unchanged keeps it: a frame nothing changed is the same array.

### What a registration must satisfy

- `id`: the same rule as every other surface — a non-empty string, not `__proto__`/`constructor`/
`prototype`, no NUL byte.
- `transform`: a function of `(lines, ctx)`. Anything else throws **before** anything is stored.
- Registering an existing `id` replaces that transform in place; `dispose()` removes exactly the one
registration it created, and calling it twice is a no-op.

### `/bridge-status`

The block is emitted only when a transform is registered, so a session that never used the pipeline
keeps its report byte for byte:

```text
transforms: 2 registered
  - bash-card-example.bash-cards (order 10): applied
  - loon.strict (registration order): failed (definitions are missing)
```

`applied` means the frame changed, `skipped` means the transform was called and left the rows as they
were, `failed` carries its message, and `not run` means it was registered after the last frame. The
outcome is the LAST frame's, not a history: a report is about what the user is looking at now.

## Limits

- `registerRows`, `registerSection`, `registerCardStyle`, `registerTransform`, `createStore`,
  `bridgeApi`, `isBridgeApi`, `onBridgeApi` and the `gentle-shell-bridge:ready` event are the
  contract; anything a plugin does inside `action()` beyond
  calling inline helpers is the plugin's own business.
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
- The runtime handshake is proven under `node --test` with a simulated process (a reset
  `globalThis`, a fake `pi.events` and a freshly loaded example per scenario), not by two live Pi
  extensions loading in either order inside one real session. What it pins: the announcement's name,
  payload and once-per-process rule, and that an early plugin registers all four surfaces from it.
- The announcement is only as good as Pi's bus: a host without `pi.events` gets no event, which is
  why the symbol remains the authority and the example reports that state honestly instead of
  waiting for something that cannot arrive.
- A card style's frame is measured in terminal columns (wide characters count 2, combining marks
  0); a style that mixes in its own images or escape tricks owns whatever the terminal does with it.
- Card styles are proven against a fake conversation component that reproduces gentle-shell's
  `float` output, never in a running Pi TUI; the downstream-override conflict above is a property of
  a real session the fake cannot reproduce.
- `registerCardStyle` and `registerTransform` are optional on the published object: an object
  published by a copy older than that surface passes the gate but lacks it, so a plugin that needs
  one checks `typeof api.registerCardStyle === "function"` (or `registerTransform`) first.
- A transform is a per-frame pass, so a slow transform is a slow frame; the bridge isolates its
  failures and clips its width, and can bound nothing else. It sees lines, never tool metadata.
- The API is released (`0.3.0`). The `v1` symbol is the compatibility boundary: a breaking
  change takes a new key instead of mutating this one (§9). The `gentle-shell-bridge:ready` event is
  additive: a plugin that never subscribes loses nothing but the late-load case.
