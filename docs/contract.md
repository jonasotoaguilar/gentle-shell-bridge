# Contract — rows, sections, the store, card styles, transforms, tool designs, keymaps, palette items and diagnostics

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
(`lib/visual-customize-view.ts:107-128`); the bridge carries them through unchanged, with one
deliberate exception: it sets `choice.applyOnMove: false` on every row it contributes (§4).

| Field | Type | Behaviour |
| --- | --- | --- |
| `category` | string (existing category) | which menu page the row joins |
| `label` | `string \| (() => string)` | row text; a function is evaluated when the menu is built |
| `choice` | `{ setting, value, current(), hint?, applyOnMove? }` | one value of a setting; consecutive rows of the same `setting` share a line. The bridge forces `applyOnMove: false` (§4) |
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

### Visibility

`visible` is the one row field the bridge never reads. It is handed to the host as the same function
reference — `test/button-rows.test.ts:185-212` asserts that identity and that no field is added,
dropped or renamed — so whether a row shows is the plugin's own live state, evaluated by the
renderer, not a bridge setting. The contract on it is two sentences (`src/types.ts:87-88`): hidden
when it returns `false`, and a throw fails closed, so the row is hidden.

A hidden row is still a row the provider returned: the bridge neither evaluates nor filters it
(`src/rows.ts:203-240` is the whole row build, and it never mentions `visible`), so its
`choice.setting` still counts towards the duplicate check of §6 and its `label` still has to pass
the row-name rule of §4. A row hidden by a throw leaves no trace in the BRIDGE's channels either —
`visible` is not wrapped the way a button `action` is, so a failure inside it reaches neither the
notice buffer of §8 nor the `Last failures` block; what the host does with that throw is the host's
business, as §7 records.

The fail-closed sentence is the row contract's, and the only evaluator of it in this repository is the
suite's fake host (`test/fake-host.ts:86-92`: no `visible` means visible, a throw returns `false`),
which models the host's renderer instead of proving it. The renderer itself is not in this workspace,
and no test here makes a `visible()` throw. Nothing beyond those two sentences is promised.

This is not the bridge-owned visibility of a sidebar section (`src/visibility.ts:119-132`), which is
persisted per section id and reaches the user as the generated `Sections` toggle (§11). A row's
`visible()` belongs to the plugin: nothing about it is stored, and its answer is whatever the
plugin's state says when the renderer asks.

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

The renderer draws one line, `Name  ● current  ○ other`, and handles the keys itself: ←/→ moves
the cursor inside the line and applies a value only when that row does not defer, Enter applies
whatever is focused (`lib/visual-customize-view.ts:552-577`). "Consecutive" is literal — a row
between the two values splits them into two lines.

### Moving never applies: every bridge row defers to Enter

A line the bridge contributes is navigated, not switched under the user's fingers: ←/→ moves the
`›` cursor and Enter applies. That is one row field, so it is one rule for every category:

- every row the bridge itself builds — the `Sections` toggle, the card-style values in both modes
  (the host's `Card style` line extended in place, and the fallback `Bridge card style` line)
  including `native`, and every value of a tool design's `Cards` line — carries
  `choice.applyOnMove: false`;
- `buildRows` enforces it for a plugin's own provider rows too, by shallow-copying the row and its
  `choice` (the provider's objects are never mutated, and every other field is the same reference).
  An authored `applyOnMove: true` is overridden: the bridge owns the integration and the design is
  one behaviour for every row it adds, so the field has no author-facing meaning here;
- the host's OWN rows are untouched. `Card style · neon/float` still applies on ←/→ because the
  host wrote it that way, so a line holding both behaves per row — which is exactly the host's rule.

While such a row is focused the host's footer reads `←/→ choose · Enter apply` instead of
`←/→ change` (`lib/visual-customize-view.ts:35-38,751`), and moving costs nothing: no store write,
no persisted value, no repaint request. Enter runs `action()` exactly once, which is where the
bridge's write path (persist first, repaint second) lives.

Other row kinds follow from the same shape:

- **Command row** — no `choice`, only `action`: one line, Enter runs it.
- **Gated row** — `visible()` returns `false` (or throws) and the row disappears.
- **Preview row** — `preview()` supplies the read-only headline and sample.
- **Inline editor row** — `action` opens `inline.input()`, asks with `inline.confirm()`, or
  captures a key with `inline.capture()`.

### Two kinds of row: toggle and button

A row is one of two first-class kinds. A **toggle** has a `choice`; consecutive rows sharing
`choice.setting` render as one line. A **button** has a `label` and an `action` and NO `choice`; Enter
runs the action, the shape of gentle-shell's own `Profiles` and `Reset` rows. A button's label is its
whole visible text, so the row-name rule below applies to it exactly as to a toggle's label (one to three
plain words, no structural marks; refused and reported, never rewritten). `preview`, `keyhint` and
`visible` pass through untouched, and the bridge injects neither a `choice` nor an `applyOnMove`. Its
one change is the `action`, wrapped so a throw or a rejected promise is contained and recorded once in
`/bridge-status` under `notices`, while the menu and every other row stay usable; the provider's object
is never mutated, so the host receives a copy.

### Row names

`choice.setting` (the line's name) and `label` (the row's text) are what a human reads, so both obey
ONE shape: **one to three plain words**, title case like the host's own rows (`Card style`,
`Card content`), and **none of** `→ ← ↑ ↓ : . | / \ [ ] ( ) { }`. No trailing qualifier — the
category already says where the row lives, and the values already say what the choices are:

```text
Bash design                     OK    a row name: the host's own vocabulary
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
  under `row rejections`. The menu never shows a sanitized version of a name the bridge refused,
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
| Tool designs | every tool with designs: the selection in force (`native` or a design id, `<id> (missing: not registered)` when it no longer exists), whether the one resolver has mounted a card for it (`wrapper mounted on 2 cards` / `wrapper not mounted`), how many cards the post-construction adoption pass reached for it (`adopted 1 card`, S10), each registered design's id, label and description; then the resolver's last outcome and how many designs it registered, and any conflicts or failures. Omitted when the process registered no design |
| Plugin lines | one entry per plugin that registered (`rows`, `section`, `card style`, `transform` or `tool design`): its row name and whether it was `derived from package "@acme/loon-kit"` or an `explicit name`, the registrations `accepted` and `rejected`, any later `name conflict` that declared a different name for the same plugin (with the name kept), and whether the line is `set` or, with the reason, `no line set`. The header also says when the host's `setStatus` was unavailable. Omitted when no plugin registered so far |

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
- **The name is derived, or given once.** The bridge captures the module that registered, resolves
  it to its owning `package.json` and derives one to three plain words from its `name`
  (`@acme/loon-kit` → `Loon kit`). The answer is cached per module. A module with no owning package
  (a single copied file) gets NO row, and `/bridge-status` says why. The Pi installation itself is
  never a plugin identity: a module owned by the package that provides `pi` (the package that owns
  the running `pi` entry point, or one whose manifest declares the `pi` executable) fails closed the
  same way, so a shared extensions directory cannot produce a `Pi coding agent` row.
- **Identity is the plugin, and the name is sticky.** A plugin identity is its owning package root
  (every module in that package is the same plugin), or the registering module when no package owns
  it. It is resolved once and cached; the footer key is hashed from that identity, never from the
  display name, so a rename — of the package or of the name — repaints the SAME key and leaves no
  orphan row. Any registration kind accepts an optional `name`: the first registration that declares
  a usable one fixes the name for the identity, and later registrations inherit it whether or not
  they repeat it. A later DIFFERENT name does not rename and never adds a row; the first name is
  kept and the conflict is reported in `/bridge-status`. A name is attribution, not mutable state;
  a deliberate rename ships as an edit plus `/reload`, a new registration lifetime.
- **The name obeys the row-name shape** (§4, Row names). A derived name is cleaned; when nothing
  usable is left there is no row. An explicit name is validated, never rewritten: a rejected name
  produces no row at all (when it is the first registration's), and a later rejected name is
  reported without discarding the name the plugin already has.
- **The state is derived, never promised.** `ready` means every registration the bridge accepted;
  one rejected registration (an invalid id, a row label that broke the shape rule) repaints the same
  key as `degraded`, and this report names the rejected items.
- **One key, painted in place.** A plugin's key is stable for its lifetime; every later change
  repaints that same key, and `session_shutdown` clears it with `undefined`. A `ctx.ui` without
  `setStatus` skips the whole feature and is reported here instead of throwing into a registration.

The row name is the diagnostic column's label; the key and the module path stay in this report,
because it is read by the plugin author, not by the user reading the footer.

### What the user sees when a registration fails

This report is for the plugin author; the user is told about a failure through Pi's own UI, never
through the terminal. The bridge writes nothing to stdout or stderr (`src/notices.ts:1-19`), and every
message it produces out of band is recorded with `recordNotice(message, level = "warning")`
(`src/notices.ts:77-92`) and delivered as `ui.notify(message, level)` by `flushNotices`
(`src/notices.ts:102-120`).

What that buffer does with a repeated failure:

- **Recorded once.** An identical `message` + `level` pair is stored once, and a blank message is
  dropped (`src/notices.ts:78-81`), so a row that fails on every press is one line, not a stream.
- **Bounded.** At most `MAX_NOTICES = 20` messages are kept (`src/notices.ts:43`). Past that, the
  oldest ALREADY delivered entry is evicted first; only a buffer in which nothing was delivered yet
  drops a pending message, and the loss is counted and printed as `notices dropped`
  (`src/notices.ts:83-90`, `src/status.ts:1028-1029`).
- **Delivered at `session_start`.** The extension calls `flushNotices(ctx.ui)` once per session,
  after the `hasUI` check and before anything is armed (`src/extension.ts:211-222`). A session
  without a UI delivers nothing and marks nothing, so the message waits for the next one; a `notify`
  that throws leaves its message pending instead of losing it (`src/notices.ts:108-118`,
  `test/notices.test.ts:198-228`). A failure that happens DURING a session is therefore not a toast
  right away: it is in `/bridge-status` immediately and appears in the TUI at the next
  `session_start` (the events listed in §9).
- **Kept afterwards.** Delivered entries stay in the buffer (`src/notices.ts:122-129`), and the
  report prints them with `delivered: true` beside the pending ones (`src/status.ts:425-435`,
  `:1019-1031`), so a message the user scrolled past is still readable.

What the bridge itself puts in that channel today: an incompatible API slot, once per process
(`src/api.ts:257-272`); a keymap or palette id registered twice
(`src/plugin-surface.ts:143,177`); a host `Card style` setter that threw
(`src/card-style-rows.ts:292-298`); and a button row's `action` that threw or rejected, at level
`error`, wrapped so the menu stays open (`src/rows.ts:143-159`).

What it does NOT put there: a `register*` call that refuses its argument. That throws into the
caller — the reserved `Keymaps` category does exactly that (`src/bus.ts:135-144`) — so reporting it
is the plugin's own job, through `ctx.ui.notify` or a line of its own. The refusal is still visible
to the author in the plugin's INTEGRATIONS line and in the `row rejections` block above.

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
  VERSION: "0.4.0",                  // the publishing release; informational only
  registerRows,
  registerSection,
  registerCardStyle,                 // since 0.2.0; optional on an older published object
  registerTransform,                 // since 0.3.0; optional on an older published object
  registerToolDesign,                // since 0.3.0; optional on an older published object
  requestRepaint,                    // since 0.3.0; optional on an older published object
  createStore,
});
```

Publication is **first wins**: a compatible object already in the slot is kept and never replaced,
and the slot is never reset. A consumer gates on the schema string, `version === 1` and the three
callable members below — `registerCardStyle`, `registerTransform`, `registerToolDesign` and
`requestRepaint` are NOT part of the gate, so an object published by an older copy is still a usable
bridge for rows, sections and the store; a plugin that needs a later surface checks
`typeof api.registerCardStyle === "function"` (or `registerTransform`, `registerToolDesign`,
`requestRepaint`) before calling it. Anything else — another library's
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

Those rows draw no preview of their own. Every `Sections` row shows the host's ONE shared preview —
the list of the sections that are active (`[changes] [rdd] [agents] [todo] [usageCost]`) — and the
bridge puts the section into that list itself: `issues` appears beside the host's own while it is
shown, and leaves the list when it is hidden. A `shown` row previews the list with the section in
it, a `hidden` row previews it without, on top of the persisted state of the rest. There is nothing
to declare and nothing to opt into: `registerSection` has no `preview` field.

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

### The canonical `session_start` skeleton

The four steps a plugin owns, in the order they happen. `examples/bash-card.ts` is the same shape
without the import — it cannot import the package, so it inlines the gate and the event name — and
its `dispose()` (`examples/bash-card.ts:1421-1432`) is the teardown below.

```ts
import { onBridgeApi, type BridgeApi } from "gentle-shell-bridge";

/** This plugin's one registration lifetime: every disposer the bridge handed back. */
const disposers: Array<() => void> = [];
let stopListening: (() => void) | undefined;

/** Stable ids are what make a second call replace, never stack (§5). */
const register = (api: BridgeApi): void => {
  // The helper already detached its own listener (`src/api.ts:468-475`); keep the state honest.
  stopListening = undefined;
  disposers.push(
    api.registerRows({
      id: "loon.banner-source",
      category: "Cards",
      rows: () => [/* §4: the toggle pair, built from live state */],
    }),
  );
};

/** Every surface this plugin registered, in one teardown. */
const disposeAll = (): void => {
  stopListening?.();
  stopListening = undefined;
  for (const disposeOne of disposers.splice(0, disposers.length)) {
    try {
      disposeOne();
    } catch {
      // A disposer that throws must not strand the others.
    }
  }
};

pi.on("session_start", () => {
  // Immediate when the bridge loaded first, a subscription when it has not, one lookup either way.
  if (stopListening !== undefined || disposers.length > 0) return;
  stopListening = onBridgeApi(register, pi.events);
});

// The end of this lifetime's registrations; the next `session_start` registers again.
pi.on("session_shutdown", () => disposeAll());
```

1. **Reach it.** `onBridgeApi(handler, events)` (`src/api.ts:435`) is the corrected timing rule in one
   call: the handler runs in the same turn when the object is already published, and takes no
   subscription at all (`src/api.ts:445-449`); otherwise it subscribes to
   `gentle-shell-bridge:ready`, runs the handler once and detaches itself (`src/api.ts:468-475`). A
   host with no `pi.events` can never hear a later publication, so the helper returns a no-op
   (`src/api.ts:451-452`) — the honest answer there, and the reason the returned disposer is kept
   even when it does nothing. A handler that throws is contained, because one plugin's failure must
   not break the announcement for the next listener (`src/api.ts:437-443`).
2. **Register, and keep what comes back.** Every `register*` returns a disposer that removes exactly
   that registration, and a registration with the same `id` replaces the previous one in place
   instead of adding a second (`src/bus.ts:146-161`).
3. **Dispose.** The array is the plugin's, and dropping the disposers leaves only replacement by `id`
   as a way out. `session_shutdown` is where this package drops its own footer rows
   (`src/extension.ts:260-262`), and it is the natural end of a registration lifetime.
4. **`/reload` replaces.** Pi fires `session_start` for `reload` too (above), and a reloaded module
   registers the same ids again; with stable ids that is one registration per surface, whether or
   not the previous lifetime's `disposeAll()` ever ran.

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
never touches the rail. The shared preview is part of that promise: every `Sections` row draws the
host's one list of active sections, and the bridge adds a section to it itself — there is no preview
to declare and nothing to opt into.

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
  offending string is reported under `row rejections`. Nothing is rewritten.
- `meta(ctx)` — optional right-aligned text. Read per frame, so a value that changes is drawn on the
  next frame without re-registering. A throw drops that section's body (see below).
- `lines(ctx)` — the body. Evaluated **per frame**, so live state is honest with no redraw API. A row
  is a plain string or a structured row (see below).
- `defaultVisible` — the fallback until the user toggles the section.
- `order` — sections **with** an `order` render first, ascending; sections without one follow
  in registration order. Ties keep registration order. The rule is computed from an explicit
  sort key, never from map iteration.
- `preview` — **not a field**, and there is nothing to opt into. Every `Sections` row draws the
  host's single shared preview, the list of sections that are active, and the bridge adds this
  section to it automatically (see *The automatic `Sections` rows*).

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

## Width discipline on the rail (N17, N18)

The host decides the rail's width from the layout, never from a part's output: the rail is the second
entry of its fullscreen `hstack` with `basis: RAIL_WIDTH, grow: 0, shrink: 0`
(`lib/shell-sidebar-layout.ts:493-496`), so pi-tui allocates those 50 columns without measuring the
child, and the conversation gets `columns - 53`. One decision IS made from a part's rows:

```text
const active = railLines.length > 0 && railLines.every((line) => visibleWidth(line) <= contentWidth);
```
(`lib/shell-sidebar-layout.ts:410`) — a single rail row wider than the content width drops the whole
rail, and the conversation then takes every column: the layout's widths changed because of what a
part returned.

**N17 — a contributed part never asks for more room than it was given.** Every row the bridge
contributes is at most the width the host handed the part, measured the way the host measures it:
`visibleWidth` (`pi-tui/dist/utils.js:212-268`) strips ANSI, expands a TAB to **three** columns
(`graphemeWidth`, `:148-155`) and charges each grapheme cluster as a whole (`:255-258`) — an emoji
cluster two columns, a cluster of marks none. `src/card-style-transform.ts`'s `hostColumns` ports
that model; `src/section-panel.ts` fits and pads with it, and a plain string row is clipped with it
instead of by UTF-16 length. Padding is counted the same way, so the pad never makes the host believe
the column wants to be wider.

**N18 — the host's own rule, matched.** The host's parts PAD: `renderPanelRow(width, left, right,
indent)` is `fitPanelLine("  " + left, right, width)`, and `fitPanelLine` pads `left`/`right` to
`width` (`lib/shell-panel.ts:31-40,78-80`). The bridge therefore pads identically — and to the
HOST-measured width, which is the whole of N17. A plain string row stays unpadded, byte for byte
(`§11`, N10).

**N19 — proved by a test, not by prose.** `test/rail-width.test.ts` models the host's rail path
(the fixed `hstack` basis, the one-column padding at `:414`, the `active` gate) and asserts that a
contributed section leaves the main column where the host put it and that no contributed row exceeds
the given width under the host's own measure — a CJK body row, a row containing a TAB, and an emoji
cluster included.

**N20 — visible without a screenshot.** `/bridge-status` prints `section width: <N> columns given,
widest row <M>` after the section frame block, from the last render's own record
(`getSectionFrameWidth()`); a session whose rail never rendered a section prints no such line.

A plain string row is clipped to the width the host passes and the body is capped at 8 rows with a
visible `… +N more` marker, measured in the host's columns. A structured row is fitted by the panel
builder, which measures **columns** the same way. The bridge never returns a row wider than that
number, so a wide CJK glyph, an emoji or a TAB can no longer slip past the clip.

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
  section is never registered, and the string and the rule appear under `row rejections`;
- `current()` reads the persisted value live, so the `●` never lies;
- `action()` persists **first** and returns; the host's own repaint re-reads `current()`;
- `preview()` is the host's shared `Sections` preview, not a picture of the card: the list of
  active sections with this row's own hypothetical applied — a `shown` row lists the section, a
  `hidden` row leaves it out — on top of the persisted state of the rest. It is never the host's
  "Preview unavailable" default.

The list is the host's own, extended: the bridge reads the sample of the host `Sections` row whose
`current()` is `true` (that row's hypothetical *is* the persisted state), appends the labels of the
bridge sections that are visible right now — the same strings the rows read — and every `Sections`
row previews that merged list. Hiding a section therefore removes it from the preview of every row,
including the host's own.

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
declared is the whole change — and `/bridge-status` reports each
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
  the string and the rule are reported under `row rejections`. An empty one is rejected too.
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
  transform: (lines, ctx) => {
    const rows = lines.filter((line) => line.trim() !== "");
    ctx.report?.({         // optional telemetry: counts only, never a line of the frame
      candidates: lines.length,
      recognised: rows.length,
      rewritten: lines.length - rows.length,
    });
    return rows;
  },
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
card styles use, so it cannot make the frame wider than the terminal. The measure and the cut are
the host's: a TAB is three columns, a grapheme cluster is charged as a whole and never split, and an
OSC-8 hyperlink contributes its text, not its URL. A row that already fits under that measure is
returned byte-identical, escapes included — a transform that did not touch a row must not cost the
host a byte. When a row IS cut, an OSC-8 link left open is closed and an active SGR is reset, so a
shortened row cannot leak a link or a paint into the rows after it; nothing is padded to fit.
- **Isolation.** A transform that throws, or that returns something which is not an array of
strings, loses only its own contribution for that frame: the lines in force are kept, the failure is
recorded with its id and message, and the remaining transforms still run. Nothing a transform does
can throw into Pi's render.
- **Identity.** With no transform registered the wrapper returns the host's own array instance, and a
transform that returns its input unchanged keeps it: a frame nothing changed is the same array.
- **Telemetry.** `ctx.report({ candidates, recognised, rewritten, shapes })` records what the
transform's own grammar did with the frame; `/bridge-status` prints it next to the outcome (§ below).

### Frame telemetry: what a transform saw

The outcome alone cannot tell "the grammar recognised nothing" from "the frame never reached the
plugin" — the difference between a working pipeline and one that silently misses. So a transform
may report, per frame:

- `candidates`: the rows it examined as a possible card head;
- `recognised`: the candidates its grammar accepted;
- `rewritten`: the cards it actually rewrote on this frame (`0` when a setting leaves them alone);
- `shapes` (optional): which of its shapes matched, by name, and how many times.

A shape name is the transform's own word for a frame it knows; it never carries a line. A plugin
that reads `float` cards and the host's `neon` outline reports those two names, so a `/bridge-status`
line names the shape that matched instead of leaving the reader to guess.

The bridge adds the count of lines the transform received and stores the whole record as that
frame's entry — one record per transform, replaced by the next frame, never accumulated.

**Counts only.** A frame carries the user's private output, so nothing of it is stored or shown: no
line, no text, no plugin content. Every number is clamped to a non-negative integer; a shape name is
kept only when it IS a name — lowercase letters, digits, `_`, `.`, `-`, at most 24 characters — so a
space or an escape is dropped rather than recorded (never rewritten and shown); and at most 12 shape
names are kept per frame. A shape name lives in `/bridge-status` beside plugin ids, which is
diagnostics, never a row (§4).

**It cannot cost a frame.** The counts come from the same call that produces the output, with no
second pass, and recording is guarded: a bridge older than the telemetry has no `report` at all (the
member is optional — gate with `typeof ctx.report === "function"`), a report of nonsense records
zeros, and a transform that throws keeps the counts it reached. Telemetry never changes what is
drawn.

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
  - loon.bash-cards (order 10): applied, 13 lines, 4 candidates, 1 recognised, 1 rewritten, shapes: float 1
  - loon.strict (registration order): failed (definitions are missing), 13 lines, 0 candidates, 0 recognised, 0 rewritten
```

`applied` means the frame changed, `skipped` means the transform was called and left the rows as they
were, `failed` carries its message, and `not run` means it was registered after the last frame. The
outcome is the LAST frame's, not a history: a report is about what the user is looking at now. The
counts after it belong to that same frame — lines received, then what the transform reported — and a
`not run` transform has none, because no frame has asked it anything yet.

### A worked transform

One rule, end to end: on a bash card, the user's home directory is printed as `~`. It rewrites rows
in place, only the rows the origin says came from the `bash` child, and it makes a row shorter
rather than longer, so `ctx.width` still holds afterwards.

```ts
import { registerTransform, type TransformContext } from "gentle-shell-bridge";

/** `/home/<user>` or `/Users/<user>`, followed by more path: the part a card can shorten. */
const HOME_PREFIX = /(^|\s)(?:\/home\/[^/\s]+|\/Users\/[^/\s]+)(?=\/)/u;

const dispose = registerTransform({
  id: "loon.tilde",
  transform: (lines: readonly string[], ctx: TransformContext): readonly string[] => {
    // Optional on the context and ALWAYS set by this bridge: an unknown origin is [], never a guess.
    const rows = ctx.rows ?? [];
    let candidates = 0;
    let recognised = 0;
    let rewritten = 0;

    const out = lines.map((line, index) => {
      // The child's toolName, never the words the card draws (src/types.ts:288-295).
      if (rows[index]?.toolName !== "bash") return line;
      candidates += 1;
      if (!HOME_PREFIX.test(line)) return line;
      recognised += 1;
      const next = line.replace(HOME_PREFIX, "$1~");
      if (next === line) return line;
      rewritten += 1;
      return next; // never wider than the row it replaces
    });

    // Telemetry is optional on the context too: gate before calling, and report COUNTS only.
    if (typeof ctx.report === "function") {
      ctx.report({ candidates, recognised, rewritten });
    }
    return out;
  },
});
```

- **The signature is the contract.** `transform(lines: readonly string[], ctx: TransformContext):
  readonly string[]` (`src/types.ts:348`). `id` is the replacement key and the name this report
  prints; `order` decides where it runs (`src/types.ts:337-349`).
- **`ctx.width` is a limit, not a target.** Whatever comes back is clipped to it with the card
  style's own `clipToWidth` before the host draws it (`src/transform-pipeline.ts:259-262`), so a row
  that grew loses its tail — possibly exactly the text that was added. A rewrite that is no wider
  than the row it replaces cannot be cut by its own transform.
- **`ctx.rows ?? []`, only when the origin matters.** The field is optional because a context from an
  older copy has no such member, while this pipeline always sets it and represents an unknown origin
  as `[]` (`src/types.ts:303-314`, `src/transform-pipeline.ts:281-305`). It identifies the host child
  per row (`toolName`, `component`) and never drawn text (`src/types.ts:288-295`); it describes the
  frame the host produced and is handed UNCHANGED to every transform in the chain, so once an earlier
  transform has added or removed rows the indices no longer line up with the array that arrives.
- **Counts only, behind a guard.** `report` is optional for the same reason
  (`src/types.ts:315-323`): gate with `typeof ctx.report === "function"`. What is stored is numbers
  and shape names — a count clamped to a non-negative integer, a name kept only when it matches
  `^[a-z][a-z0-9_.-]*$` and is at most 24 characters (`src/types.ts:262-271`,
  `src/transform-pipeline.ts:96-109`, `:167-191`). A transform that rewrites card text therefore must
  not stash it: no line, no substring, no plugin output in a count, a shape name, a log line or a
  store. The rule the example follows is the one to copy — count what the grammar did, return the
  rows, and keep every character of the user's output inside that call.

## 14. Tool designs

A **design** decides how ONE tool's card is drawn, without owning the frame. It is declared per tool
NAME and composed with the host's own card:

```ts
api.registerToolDesign({
  tool: "bash",
  id: "loon.bash-heading",
  label: "bash heading",                     // the value on the Cards line, not a row name
  name: "Loon kit",                          // optional INTEGRATIONS name (see §8)
  description: "heads the card with bash instead of the host's $ mark",
  preview: () => ({ title: "Cards · bash heading", sample: "╭─ bash npm test ─╮" }),
  apply(lines, ctx) {                        // the host's rows in, the rows to draw out
    return lines.map((line) => rewriteTheMarkOnly(line));
  },
});
```

### The convention: lines in, lines out

`apply(lines, ctx)` receives the rows the HOST's own card produced — ANSI sequences, padding, the
right-aligned hint, the frame's rails, everything — and returns the rows to draw. `ctx` is
`{ width, tool, theme, part, render? }`: the width the host asked its own component to render at, the tool
name the design was declared for, the host's opaque theme object, which half of the card this pass is
drawing (`"call"` for `renderCall`, `"result"` for `renderResult`), and what the host knows about THIS
call (`render`, below).

**`part` is what tells the call from the result.** A card has two components and the host draws both
with the same chrome, so the rows alone cannot distinguish a heading from output: under the `float`
style a result body row that begins with `$ ` (a script echoing its commands) sits exactly where a
heading sits. The bridge wraps the two renderers separately and sets `part` per renderer, so a design
that must not touch the result returns it unchanged when `ctx.part === "result"` instead of guessing
from drawn text. The field is additive: a design that never reads it behaves exactly as before.

**`render` is what tells a design about the CALL, not the drawing.** The rows alone cannot say what the
command was (the host truncates a long heading with `…`), whether the call is still running, whether it
failed, or how long it took. `ctx.render` carries those, copied by value from Pi's render context on
EVERY pass (the context is live: `durationMs` arrives with the result):

```ts
interface ToolDesignRender {
  toolCallId?: string;   // stable across the call's and the result's passes: ties the two halves
  args?: unknown;        // the call's arguments as Pi holds them (bash: { command, timeout? })
  isPartial?: boolean;   // the call is still running
  isError?: boolean;     // the finished call reported an error
  durationMs?: number;   // milliseconds the execution took; absent while it runs
  expanded?: boolean;    // the row is expanded
}
```

- **Every field is optional and typed.** A field is forwarded only when the host provided it with the
  documented type; a `NaN` duration or a non-boolean flag is dropped, never coerced.
- **Three states, all valid.** No `ctx.render` at all (an older bridge, or a host that hands no render
  context), `ctx.render === {}` (a context with nothing usable), or a populated one. A design must draw
  its pre-`render` output in the first two.
- **Nothing else crosses.** `state`, `invalidate`, `lastComponent` and every other host member are not
  forwarded; a design cannot reach the host's live context. A context whose accessors throw yields no
  `render`, never a failed frame.
- **`args` is the host's own object, by reference.** Treat it as read-only: Pi keeps updating it while
  the call streams, and the bridge neither freezes nor clones it. Mutating it is unsupported.
- **Key per-call memory by `toolCallId`.** The bridge offers no eviction, so a design that caches per id
  owns that cache's lifetime.
- **Per-tool shapes differ.** `args` for `bash` is `{ command }`, for `write` `{ path, content }`: a design
  shared across tools branches on `ctx.tool`.

**The frame is the host's, so the card style is preserved by construction.** With `Card style` on
`neon` the card is still neon, with `float` it is still float, because the chrome was drawn before the
design saw a byte of it. The bridge never re-frames, re-measures or clips a design's output (§13's
width rule is the transform pipeline's); a design keeps the rows it was given exactly as wide as the
host made them.

Two rules follow from that:

- **Change only what the design is for.** A bash design that heads the card `bash` changes the
  heading row and nothing else: every other row — every ANSI run, every pad, the hint, the rails —
  comes back byte-identical. The rows it does change stay the host's rows; they are edited, never
  rebuilt from a second grammar.
- **It is declared by tool NAME, not recognised by drawn text.** The bus already knows which tool's
  card it is wrapping; a design that scans a frame for the word it expects is the fragility this
  surface replaces (the host retitled the bash card and every drawn-text grammar went blind).

### Declared per tool name (S7)

A design names a tool (`bash`, `write`, `edit`, `mcp__engram__mem_save`, `lsp_navigation`, …). The bus
keeps one registry per name, no name is special-cased, and a design declared for a tool that has no
card yet applies as soon as Pi builds one: Pi resolves renderers when the card is CONSTRUCTED, and the
bridge's one resolver is installed for the whole session.

### When the bridge is not first in the chain (S10)

Pi composes tool-renderer resolvers in **extension load order** (`runner.js:550-553`) and exposes no
API to reorder them (`loader.js:298-302` only pushes). A resolver loaded before this package decides
first, and one that answers WITHOUT calling `next()` hides the bridge's resolver completely. The
host's own quiet bash resolver does exactly that while `Card content` is `minimal`
(`extensions/quiet-tools.ts:910-914`), which is why a selected design could still leave every card
drawing `$ …`.

The design therefore has a second path: after Pi constructs a card, the bridge adopts it. The
conversation component the bridge already wraps for card styles has Pi's `ToolExecutionComponent`s as
children; each carries `toolName` and the `toolDefinition` Pi resolved for it. On every conversation
render pass, before the host renders its children, the bridge replaces that card's `toolDefinition`
with the same wrapper the resolver path uses (so the frame and the live-selection rule are
identical), marks the wrapper so the two paths cannot stack, and invalidates the card so its stored
renderer re-runs through the design. Cards Pi rebuilds (reload, `/tree`, session switch) are new
children and are adopted on the next pass. A card of a tool with no designs is never touched; a card
whose `toolDefinition` is missing or refuses the assignment is reported in `/bridge-status` and drawn
by the host.

This does not replace the resolver path: when the bridge IS ahead in the chain its resolver wraps the
renderers at construction, and adoption then recognises the marker and adds nothing. `/bridge-status`
counts both per tool (`wrapper mounted on N cards`, `adopted N cards`), so the next failure says
which path ran.

### Selection, and the default

The selected design per tool is a row in `/gentle:customize` → `Cards`: one line per tool, named from
the TOOL (never from the plugin or the id) and prefixed with the category's own word, whose values are

1. `default` — **the host's own card, always first and the default**. It is what the line SHOWS; the stored
   value stays `native`, because the selection is identity and a saved choice must survive the wording; and
2. every design registered for that tool, in registration order, each shown by its `label`.

**The line name is `Card <tool>`**, the vocabulary the `Cards` category already uses for `Card style`
and `Card content`: `Card bash`, `Card lsp navigation`, `Card mem save`. A row name is one to three
plain words (`src/row-names.ts`), so the prefix leaves room for at most two tool words; a longer tool
name keeps its TAIL (`mcp__engram__mem_save` → `Card mem save`, never `Card mcp engram`), a name that
derives to no words reads `Card tool`, and two tools that read the same after that clamp are told
apart with an ordinal (`Card mem save`, `Card mem 2`) that keeps the shape rule. The line's name is
not persisted and is not identity: the store is keyed by the TOOL name (`bridge-tool-designs` →
`selections` → `{ "bash": … }`) and a value is the design's `id`, so renaming the line moves nothing
but the text the user reads.

The stored value is the design's `id`, so renaming a label never loses a user's choice. Changing the
value repaints the cards already on screen: the wrapper reads the live selection on every render pass,
so a design chosen after a card was drawn changes that same card. A selection naming a design that is
no longer registered degrades to the host's own card and is reported as `missing` in
`/bridge-status`.

### What a switch costs (S13)

That repaint is **one differential frame**: `requestRepaint()` bumps the host's terminal-side cache
revision (`invalidateSidebar(tui)`'s one step) and calls `tui.requestRender()` with no argument. It
does **not** call `tui.invalidate()` and does **not** pass `force = true`. The wrapper renders the
host's component and applies the live selection on top of whatever rows it answers with — including
rows the host's own frame cache hands back (`ToolCardRows`, `cards-bash-v2`
`extensions/quiet-tools.ts:612-624`, keys its frame on width, the host's style and whether the card
is running; the design is not in that key), so no cache has to be dropped for a switch to land.

Measured on real pi-tui and Pi's `ToolExecutionComponent` on transcripts of 50, 200 and 600 children
(half Markdown assistant messages with a code block and a list, half bash cards; median of 5 runs;
Node 26; fake terminal that counts the bytes the TUI writes):

| 600 children, one switch | frame | bytes the TUI wrote |
| --- | ---: | ---: |
| `requestRender()` — what a switch does now | 21 ms | 0 (the diff finds nothing else) |
| `tui.invalidate()` + a frame | 730 ms | 0 (every Markdown message re-parsed) |
| `requestRender(true)` — forced | 33 ms | 6.9 MB (whole buffer cleared and rewritten) |
| invalidate + force — before S13 | 753 ms | 6.9 MB |

The invalidate is the cost: it clears every mounted component's frame cache, so 300 Markdown
messages re-parse and re-highlight before the frame can be drawn (`tui.js:585-590`). The force is the
second: `resetRenderState()` throws away the previous frame, so the TUI clears the screen and
scrollback and rewrites every row (`tui.js:658-663`). The host's own `Card style` switch never did
either — it writes its value, bumps the sidebar revision and calls `requestRender()` with no
argument (`extensions/gentle-shell.ts:3409-3412`) — which is why it never froze.

The other candidates were measured and NOT acted on, because the numbers refused them: reading the
persisted selection costs 3.5 µs per card per frame (0.35 ms at 100 cards, ~1 ms at 300 — steady, and
0.1% of the old switch), and adopting a card after construction costs ~0.02 ms and one local
invalidate per card, once. See `test/tool-design-cost.test.ts`, which pins the result by COUNTING
calls instead of timing them: a switch invalidates no component, re-parses no Markdown row, requests
exactly one differential frame, and performs at most one persisted-selection read per card per frame,
whatever the number of Markdown rows in the transcript.

#### What a bridge-owned switch costs (S19)

`requestSurfaceRepaint()` — the path a bridge-owned row takes (a card style such as the example's
`plain`, a section toggle) — used to keep the invalidation and the forced frame. It is now the same two
steps as `requestRepaint()`: the host's sidebar revision and one differential frame. Measured with real
pi components, with and without `tui.invalidate()` + `requestRender(true)`, the rows are byte-identical
on the conversation, on a rail host panel and on a bridge section hidden, collapsed and expanded: the
style is repainted by the wrapper on the host's own already-rendered rows on every pass, and a section
toggle moves `sectionRailDigest`, which the host's rail memo already keys on.

Median of 7, 600 children, one switch: `plain` 697 ms before / 420 ms after, a host style 306 / 19 ms,
a rail section toggle 99 / 3 ms. The control that keeps the zeros honest: a host card whose frame key
omits the style is the only case an invalidation repairs, and it would deserve a LOCAL invalidate on that
card, never the tree. `test/surface-repaint-cost.test.ts` bounds it by call counts (zero tree
invalidations, zero prose re-parses, zero card invalidations, one differential frame, at 3 and at 200
Markdown rows).

Stated residual: switching TO `plain` at 600 children still costs about 420 ms (the style draws 4 rows
where the host's float card draws 7, so the transcript shrinks by ~270 rows and pi rewrites its buffer,
and `transformCardLines` re-scans the transcript per pass); switching back costs about 16 ms. The rail
model in that measurement reproduces the host's memo key (`lib/shell-sidebar-layout.ts:310-350`); it is
a model, not the host's own module.

### Registration discipline

Same rules as every other surface: `tool` and `id` are validated before anything is stored; a second
registration with the same (`tool`, `id`) replaces in place and is REPORTED (never a silent takeover);
two designs of one tool cannot share a visible label; `default` and `native` are reserved. One call may
register several designs — `registerToolDesign([a, b])` — in order, all-or-nothing (a refused design leaves
none of them registered), with ONE disposer that removes exactly that call's designs. Two designs of one
tool from one call, or from two plugins, join that tool's ONE line: the tool name is the join key and
`default` is never duplicated. A design that throws, or
returns something that is not an array of strings, loses only its own card — the host's rows are drawn
— and is reported once per (tool, id, message).

`name` is optional and does the same job as `RowProvider.name` (§2): a single-file extension with no
owning `package.json` gets an INTEGRATIONS line only if it names itself, and a plugin that contributes
ONLY designs is attributed like any other — its registrations are `accepted`/`rejected` in the
report, and its `name` is sticky for the identity (§8).

The bridge registers exactly ONE `pi.registerToolRenderer` resolver for the whole process and fans it
out to these designs. That is why two plugins contributing designs for the same tool do not stack
wrappers, and why a plugin must never call `pi.registerToolRenderer` itself for a design.

## 15. Plugin keymaps and the command palette

The bridge publishes what plugins contributed; the **host reads it per build**. The direction is the
design: there is no registration handshake, no startup cache and no lifecycle in the host, so a
registration made during `session_start` is visible at the next menu or palette open, in any load
order.

```text
Symbol.for("gentle-shell-bridge/plugin-surface/v1") → { schema: 1, keymaps(), commands() }
```

Both getters answer with a **copy**, never the live array, so a host that keeps one cannot mutate
what the bridge owns.

### `registerKeymap(registration): () => void`

One action for the host's Keymaps page: `{ id, label, env?, defaultKey?, command? }`.

- `id` and `label` must be non-empty strings; `env`, `defaultKey` and `command` are optional but,
  when present, must be non-empty strings too. Validation happens here, where the plugin author sees
  the error.
- An `id` starting with `command:` is refused: those name palette command bindings, not plugin
  actions.
- The same `id` registered twice **replaces in place and is reported**, like every other
  registration in this package. A silent takeover would be one plugin stealing another's row.
- The disposer removes exactly the entry it created. A replaced entry is a different object, so
  disposing the old registration never deletes its successor.
- A contributed id can never shadow a built-in action or a `command:<name>` binding: the host keeps
  its own ids.

### `registerCommands(contribution | contribution[]): () => void`

One palette item, or several: `{ id, label, command, section? }`.

- An item joins the section it names, after that section's own entries, or opens a section of its
  own after the host's catalog. Without `section` it lands in the shared `Plugins` page.
- The host lists an item only while its command is registered, so a missing extension leaves no
  dead row, and an own section that would be left empty does not appear at all.
- An `id` twice **in one call** is refused whole: the batch would silently keep only the last one.
  Across calls it replaces in place and is reported, exactly like keymaps.

### `resolveKeymap(id): { key?; unavailable? }`

The key an id currently uses, answered by the shell that owns the file, the environment override
and the defaults — environment variable, then saved binding, then default. It never throws: no
shell, an older shell or a throwing getter is an `unavailable` reason the caller reports.

The plugin then binds the key itself with `pi.registerShortcut`. The bridge never binds for a
plugin, and the shell never binds a plugin's key. That split is what keeps one implementation of the
precedence: the row and the real binding cannot disagree.

**A keymap change applies after `/reload`.** Pi reads extension shortcuts at startup and on reload,
for native actions and contributed ones alike, and it exposes no way to re-register a shortcut while
running. The Keymaps page says so, and its last row offers the reload.

## Limits

- `registerRows`, `registerSection`, `registerCardStyle`, `registerTransform`,
  `registerToolDesign`, `registerKeymap`, `registerCommands`, `resolveKeymap`, `requestRepaint`,
  `createStore`, `bridgeApi`, `isBridgeApi`, `onBridgeApi`
  and the `gentle-shell-bridge:ready` event are the contract; anything a plugin does inside `action()` beyond
  calling inline helpers is the plugin's own business.
- **`Keymaps` stays reserved for row providers.** A provider registered with `category: "Keymaps"` is
  refused before anything is stored, with an error naming the category and why; the refusal is a rejected
  registration in the plugin's INTEGRATIONS line and in `/bridge-status`. A single row whose own
  `category` is `Keymaps` is dropped and reported the same way, and its siblings still render. The
  comparison is trimmed and case-insensitive: ` keymaps ` and `KEYMAPS` are the same page; `Keymap` and
  `Key maps` are ordinary categories. `Profiles` and `Reset` are not reserved: a plugin row there renders
  as an ordinary line. A refusal of one row is listed under `row rejections` but is not counted in the
  plugin's INTEGRATIONS line (a build cannot reach it; only the registration refusal does). The reason
  is unchanged and now has a supported alternative: that page captures keys and claims a footer, so a
  plain row would be advertised as assignable and could never honour it — a plugin uses §15 instead.
- **A new category becomes a page.** The host computes its page list once, in the view's constructor
  (`lib/visual-customize-view.ts:387`), so the rows must be in the array before that `map` runs; see
  [architecture.md](architecture.md) "A brand-new page". The cost is stated there. The one residual
  risk: a host that never derives categories from its menu while another array in the same factory is
  mapped exactly like the host's page derivation would have its rows injected into the wrong array and
  report `injected`; the real host derives them at `:387`, and with that shape a competing array stays
  `ambiguous` and nothing is injected.
- **Sections join the rail after the native cards, never between them.** The host's status
  sections are unreachable (a closure), so "interleaved with `CHANGES`" is not offered; the
  limit is documented rather than faked.
- **Resolver order is not ours.** Pi composes tool-renderer resolvers in extension load order and
  offers no reordering API, so a resolver ahead of this package that does not call `next()` hides the
  resolver path. Adoption after construction exists for exactly that case (S10); it depends on Pi's
  `ToolExecutionComponent` carrying `toolName` and a writable `toolDefinition`, and reports the card
  as an `(adoption)` failure instead of throwing when it does not.
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
  payload and once-per-process rule, and that an early plugin registers every surface it contributes
  from it.
- The announcement is only as good as Pi's bus: a host without `pi.events` gets no event, which is
  why the symbol remains the authority and the example reports that state honestly instead of
  waiting for something that cannot arrive.
- A card style's frame is measured in terminal columns (wide characters count 2, combining marks
  0); a style that mixes in its own images or escape tricks owns whatever the terminal does with it.
- Card styles are proven against a fake conversation component that reproduces gentle-shell's
  `float` output, never in a running Pi TUI; the downstream-override conflict above is a property of
  a real session the fake cannot reproduce.
- `registerCardStyle`, `registerTransform`, `registerToolDesign` and `requestRepaint` are optional
  on the published object: an object published by a copy older than that surface passes the gate but
  lacks it, so a plugin that needs one checks `typeof api.registerCardStyle === "function"` (or
  `registerTransform`, `registerToolDesign`, `requestRepaint`) first.
- A design receives ROWS, a width and the PART it is drawing (`call` or `result`), never a renderer
  object and never the theme's shape. `part` is one of two literals; a design that ignores it is
  byte-identical to one written before the field existed, and a context produced by an older copy of
  the bridge carries no `part` at all — a design reads it as unknown (`ctx.part === "result"` is
  simply false) and keeps working.
- A transform is a per-frame pass, so a slow transform is a slow frame; the bridge isolates its
  failures and clips its width, and can bound nothing else. It sees lines, never tool metadata.
- The API is released (`0.4.0`). The `v1` symbol is the compatibility boundary: a breaking
  change takes a new key instead of mutating this one (§9). The `gentle-shell-bridge:ready` event is
  additive: a plugin that never subscribes loses nothing but the late-load case.
