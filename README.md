# gentle-shell-bridge

A shared, plugin-facing bridge between Pi plugins and gentle-shell's `/gentle:customize`
menu. A plugin publishes a *row provider*; the bridge owns the single interception layer
and fans out to every provider, so N plugins × M gentle-shell surfaces becomes N providers
and one interception. Plugins stop wrapping `ctx.ui` themselves, and stop colliding with
each other when more than one wants to add a settings row.

**Status: released as `0.3.0`.** The package exists and runs. It is a manifest-backed Pi
package (`pi.extensions` → `./src/extension.ts`) loaded from TypeScript sources through
jiti, so there is no build step and no `dist/`; it registers a `bridge-status` command and
carries a `node --test` suite of 422 tests, 26 of them end-to-end through the public API and
the real extension entry, 8 driving the worked example's transform through a real
conversation wrapper, and 22 pinning the publication announcement in both load orders. The capture
technique was proven in the real TUI by a 76-line
throwaway extension (`loon-customize-probe.ts`); the capture backend implements it, while
the hook backend is implemented but **unverified** — no host has been observed emitting the
registry it looks for. The sidebar surface is proven against a fake rail, not in a live TUI:
what is not proven is listed under **Limits**.

- [PRD.md](PRD.md) — problem, users, requirements, success criteria
- [docs/architecture.md](docs/architecture.md) — how the host menu is reached, with source citations
- [docs/contract.md](docs/contract.md) — `registerRows`, provider and row shapes, diagnostics
- [docs/state.md](docs/state.md) — ADR: stateless composition plus optional per-plugin store

## Worked consumer

[`examples/bash-card.ts`](examples/bash-card.ts) is a standalone Pi extension that demonstrates the
two surfaces this feature exists for: a **tool design** through `registerToolDesign`, and a **`BASH
CARD` sidebar section** through `registerSection`, toggled from **`Sections`** in
`/gentle:customize` with no setting, row or store written by the plugin.

The design is the one the user asked for. gentle-shell draws a minimal bash card with just a `$`
mark; the design heads that same card with the word `bash`, and nothing else:

```
before   ▎ $ npm test (timeout 30s)          ctrl+o to expand
after    ▎ bash npm test (timeout 30s)       ctrl+o to expand
```

The card is still the host's card. A design receives the lines the HOST's own renderer produced and
returns the lines to draw, so whatever `Card style` is selected survives by construction: with
`neon` the card stays neon, with `float` it stays float. The example changes exactly two things on
the heading row — the mark, and the fill it gives back so the row keeps the host's width — and every
other byte of every other row (ANSI, padding, hint, rails, body) comes back identical:
`test/example-bash-identity.test.ts` and `test/example-neon-transform.test.ts` assert that byte for
byte in both styles.

The design is registered for the tool name `bash`, and the `Cards` line it produces appears with no
extra wiring: `bash  ○ native  ○ bash heading`. The first value is the bridge's own `native` — the
host's card, the default — so installing the file changes no rendering until the user picks the
design. Choosing it repaints the bash cards already on screen, not only the next one, because the
bridge reads the live selection on every render pass. A `read` card is never touched: designs are
declared per tool name, and the bus has no bash-specific branch.

The **`BASH CARD`** section is the second surface: the host draws the card and owns the collapse
control, and the section body reports live state — which value is selected for `bash`, and whether
this load's design reached the bridge (`resolver  registered` / `resolver  absent`). It needs no
extra wiring either: registering the section is what adds its `Sections` toggle.

Copy the file into `~/.pi/agent/extensions/` and `/reload` to load it; the `bash` line defaults to
the host's own card, while the section is visible immediately (`defaultVisible: true`). It does not
import the package and does not know where it is installed: the example and the bridge meet on
`globalThis` behind one symbol (see **Reaching the bridge without importing it**). Global extensions
load before configured packages, so the example does not assume the bridge got there first: it tries
the symbol in its own `session_start` handler **and** listens for the bridge's
`gentle-shell-bridge:ready` announcement, whichever comes first registering the same two surfaces
(registration replaces by stable id, so the second one adds nothing). When neither has happened yet,
the notice says which state the load is in — waiting for an announcement on a Pi with an event bus,
or nothing to wait for on one without — instead of claiming the bridge is not installed.

A bridge that publishes something else — another major version, a partial object, another library's
payload at the symbol — is treated as absent, never as an error: the example never calls an object it
cannot trust, registers nothing, and says so once through `ctx.ui.notify`. An object published before
`registerToolDesign` existed keeps the section and says `resolver  absent`: the member is optional,
and a surface the bridge never promised is never warned about. The bridge reports the version skew
once per process.

## Install

The package is `0.3.0`. Load it from source as a Pi extension package alongside gentle-shell
and Pi discovers `src/extension.ts` through the `pi` manifest. The shipped files are the
TypeScript sources: Pi loads them through jiti, so there is no build step and no `dist/` to
publish.

For a plugin that imports the API, `exports` maps the package root to `src/index.ts`:

```ts
import {
  BRIDGE_READY_EVENT,
  bridgeApi,
  createStore,
  isBridgeApi,
  onBridgeApi,
  registerCardStyle,
  registerRows,
  registerSection,
  registerTransform,
  STORE_SCHEMA_VERSION,
  VERSION,
} from "gentle-shell-bridge";
```

Importing is optional: a plugin can reach the bridge through the runtime handshake below without
resolving the package at all.

`engines.node` is `>=22.18.0` because the test suite runs `.ts` files directly through
Node's native type stripping, with no transpile step.

## Quick start: a sidebar section

The two quick starts below show the call itself. Make it from your extension's `session_start`
handler — or, if your plugin may load before this package, through `onBridgeApi(handler, pi.events)`,
which answers in both orders.

The second surface needs no `Sections` row, no setting name and no store of its own — one call
adds the card to the sidebar and its show/hide toggle to `/gentle:customize` → `Sections`.

```ts
import { registerSection } from "gentle-shell-bridge";

const dispose = registerSection({
  id: "loon.music",             // unique and stable: ordering, replacement, the toggle; internal
  title: "MUSIC",               // card heading, framed by the host like AGENTS / STATS
  rowLabel: "music",            // optional: the text the Sections row reads (derived from title)
  meta: () => "1 playing",      // optional right-aligned count; read per frame, so it is live
  lines: () => [                // per frame, live
    "track  Blue in Green",     // a plain string is drawn byte for byte, exactly as before
    {                           // a structured row is drawn like a native one
      glyph: "▸",
      label: "album",
      meta: "Kind of Blue",
      tone: "muted",
      onClick: () => play(),    // only a row with onClick is clickable
    },
  ],
  defaultVisible: true,
  order: 10,                    // optional; unordered sections follow, in registration order
});

// dispose() removes the card and its toggle; other sections are untouched.
```

The card behaves like a host card. The HEADER is the host's own header — `▾ MUSIC`, the right-aligned
`meta`, the hover accent — and clicking it folds the section (a folded body is not built at all, and
the fold is remembered in the bridge's own store). A row with `onClick` is clickable and highlights
under the pointer; a row without it is inert and never highlights. `meta` is read at render time and
folded into the rail's digest, so a value that changes is repainted with no re-registration.

The `tone` of a structured row names one of the host's own roles — `text`, `muted`, `dim`, `accent`,
`success`, `error`, `warning` — never a colour, and anything else is rejected and reported.

Where the header and rows are DRAWN is reported, not assumed: the host's own
`renderPanelHeader`/`renderPanelRow` live in a module this package cannot import, so the bridge looks
for them on every object it is handed, uses them when it finds them, and otherwise draws with a
byte-identical port. `/bridge-status` says which it used and what remains unreachable
(`section frame: host` or `section frame: fallback` plus a `section frame gap` line).

The row is a **label**, never the id and never a prefix. The host's own `Sections` rows read
`changes`, `stats`, `usageCost`; a plugin's section reads the same way:

```text
stats             ● shown  ○ hidden     ← the host's own row
music             ● shown  ○ hidden     ← this plugin's section
```

`id` stays internal: it is the replacement, disposer and stored-visibility key, and it never
appears in a row. With no `rowLabel`, the bridge derives one from `title` — lowercase words joined
by spaces, dots and punctuation dropped, at most three words (`"BASH CARD"` → `"bash card"`,
`"MUSIC PLAYER NOW PLAYING"` → `"music player now"`). Two sections whose labels would read the same
are told apart deterministically (`music`, `music 2`, …) and `/bridge-status` says which one moved;
the raw id is never the suffix. An explicit `rowLabel` obeys the same row-name shape described under
"Row names" below — a name that breaks it is rejected and reported, never rewritten.

What the bridge does with those fields, and what it will not do: the card is drawn by the
host's own frame code, a plain string row is clipped to the rail width, and the body is capped at 8
rows (with a `… +N more` marker). A row is measured the way the host measures it — `visibleWidth`:
SGR ignored, a TAB is three columns, and a grapheme cluster is charged as a whole, so an emoji is two
columns and a CJK glyph two. A contributed row is never wider than the width the host handed the
part, padding included, so it cannot make the host drop the rail; `/bridge-status` reports that
width and the widest row the bridge produced. A hidden section is not built at
all (its `lines()`/`meta()` are not called), nor is a collapsed one, and a throwing section loses
only its own body and is reported by `/bridge-status`.
Sections always render **after** the native cards — interleaving is impossible because the
host builds its status sections in a closure. Visibility and the fold live in
`~/.pi/gentle-ai/gentle-shell-bridge/bridge-sections.json` as
`{ "schemaVersion": 1, "values": { "sections": { "loon.music": true }, "collapsed": { "loon.music": true } } }`,
deliberately not in the host's strictly validated `visual-customization.json`.

## Quick start: a card style

A plugin can add a third card style to gentle-shell's cards, on the host's own `Card style` line,
without touching the host. The bridge owns detection; the style owns drawing. A style is one global
choice, so it paints every card surface the host frames — the **conversation** and the fullscreen
**rail** (host sections like `CHANGES` and contributed sections alike) — and `native` restores the
host's own frames on both. The rail is covered by the same `transformCardLines` the conversation
uses, so a plugin registers nothing extra for it.

```ts
import { registerCardStyle } from "gentle-shell-bridge";

const dispose: () => void = registerCardStyle({
  id: "loon.cute",  // unique; the stored value and the replacement key — internal, never a row
  label: "cute",    // the line's value: Card style  ○ neon ● float ○ cute
  rowLabel: "cute", // optional: what this style's row reads (derived from label when absent)
  frame: {
    top: (ctx) => `╭─ ${ctx.title ?? ""} ${"─".repeat(Math.max(0, ctx.width - 6))}╮`,
    line: (ctx) => `│ ${ctx.text.padEnd(Math.max(0, ctx.width - 4))} │`,
    bottom: (ctx) => `╰${"─".repeat(Math.max(0, ctx.width - 2))}╯`,
  },
  preview: () => ({ title: "Cute", sample: "╭─ read ─╮ │ config.ts │ ╰────────╯" }),
});

// The user picks `cute` on the host's own Card style line; pressing neon/float returns to the
// host's rendering. dispose() removes the value and the chrome.
```

Rules the row cannot break: `id` and `label` are unique among the line's values (the host's
`neon`/`float` and the bridge's `native` are taken), the visible text is a label (`label` on the
line, `rowLabel` — or `label` made readable — for the row), the id never appears in a row, and the
style only ever receives text and a width — it parses nothing. Full contract: [docs/contract.md](docs/contract.md) §12.

## Quick start: a tool design

A design decides how ONE tool's card is drawn, composed with the host's own card. You register it for
a tool NAME; the bridge owns Pi's single `registerToolRenderer` resolver and hands your `apply` the
rows the host itself drew:

```ts
import { registerToolDesign } from "gentle-shell-bridge";

const dispose: () => void = registerToolDesign({
  tool: "bash",                 // a tool name, present or future: no bash-specific branch anywhere
  id: "loon.bash-heading",      // unique per tool; the stored value and the replacement key
  label: "bash heading",        // the value on the Cards line: bash  ○ native  ○ bash heading
  name: "Loon kit",             // optional: this plugin's INTEGRATIONS row
  preview: () => ({ title: "Cards · bash heading", sample: "╭─ bash npm test ─╮" }),
  apply(lines, ctx) {           // the HOST's rows in, the rows to draw out
    // ctx is { width, tool, theme }; lines already carry the host's frame, ANSI and padding.
    // Change only the mark the design is for, and keep every other row byte-identical:
    return lines.map((line) => rewriteTheMarkOnly(line));
  },
});

// The user picks `bash heading` on its Cards line; `native` (the host's own card) stays the default,
// and the choice repaints cards already drawn. dispose() removes the value.
```

What the bridge guarantees:

- **the frame is the host's**, so the card style is preserved by construction — `neon` stays neon,
  `float` stays float, and every byte you do not change is returned as drawn;
- the design's `Cards` line appears with no extra wiring, one line per tool, whose values are
  `native` (the host's card, the default) and every design registered for that tool;
- the selection is persisted per tool in the bridge's own store, and changing it repaints the cards
  already on screen, not only the next one;
- a design declared for a tool with no card yet applies as soon as Pi builds one, because Pi resolves
  renderers when the card is constructed;
- a design that throws loses only its own card, and the host's rows are drawn instead.

Full contract: [docs/contract.md](docs/contract.md) §14.

## Quick start: a transcript transform

A tool renderer resolves once, when a row is built. A transform runs on every frame the conversation
component renders, which is the only way a rendering choice can reach rows that were already drawn.

```ts
// The context a transform receives: the host's width, and the optional telemetry channel.
interface TransformContext {
  width: number;
  // Optional because an older published bridge has none: gate with typeof ctx.report === "function".
  report?(counts: {
    candidates: number;   // rows examined as a possible card head
    recognised: number;   // candidates the grammar accepted
    rewritten: number;    // cards actually rewritten this frame
    shapes?: Record<string, number>;  // which shape matched, by name
  }): void;
}

declare const registerTransform: (transform: {
  id: string;
  order?: number;
  transform(lines: readonly string[], ctx: TransformContext): readonly string[];
}) => () => void;

const dispose = registerTransform({
  id: "loon.gutter",   // unique: the ordering/replacement key and the /bridge-status name
  order: 10,           // optional: ordered transforms run first, ascending
  transform: (lines, ctx) => {
    const kept = lines.map((line) => line.slice(0, ctx.width));
    // Counts only — never a line of the conversation. This is what tells "the grammar matched
    // nothing" apart from "the wrapper never ran" when a setting seems to do nothing.
    ctx.report?.({ candidates: lines.length, recognised: kept.length, rewritten: lines.length });
    return kept;
  },
});

// The user sees the new rendering on the NEXT FRAME, for every row — including cards drawn before
// the choice was made. dispose() removes this transform; other plugins' transforms keep running.
```

The pipeline is what the bridge's existing conversation wrapper runs after the card-style repaint:
`lines` is the previous transform's output, and the first transform sees the card-style repaint of
the host's own rows. What the bridge guarantees, and what the contract is:

- what a transform returns is **clipped to `ctx.width`** (the width the host rendered at), so a
transform can never make the frame wider than the terminal. The measure is the host's (`TAB` three
columns, a grapheme cluster as a unit, an OSC-8 hyperlink contributes its text and not its URL), and
a row that already fits is returned **byte-identical** — a transform that did not change a row cannot
make the bridge cut it. A row that must be cut is cut between clusters, with an open hyperlink closed
and an active SGR reset, so nothing leaks into the rows after it;
- a transform that **throws**, or returns anything that is not an array of strings, loses only its
own contribution for that frame; the lines in force are kept and the remaining transforms still run;
- a transform that returns its input **unchanged** is recorded as `skipped` and the frame keeps its
identity — with no transform registered, the wrapper returns the host's own array instance.

`/bridge-status` lists the pipeline in order with the last frame's outcome per transform, then the
counts that same frame recorded — lines received, and what the transform reported:

```text
transforms: 1 registered
  - loon.bash-cards (order 10): applied, 13 lines, 4 candidates, 1 recognised, 1 rewritten, shapes: float 1
```

Those counts are the instrument, not decoration: `skipped` with `0 candidates` means the grammar
found nothing card-shaped, candidates with `0 recognised` means it found the shape and rejected it,
and recognised with `0 rewritten` means a setting decided the output. A shape name is the transform's
own word for a frame it knows — a plugin that reads `float` and `neon` reports those names — so the
report names which grammar matched. They are counts only — no line
of the conversation is stored or displayed, a shape name must be a short lowercase name (anything
else is dropped, never rewritten), and reporting cannot throw into the frame. Full contract:
[docs/contract.md](docs/contract.md) §13.

A tool design reports its own block, because "the design is selected but the card did not change" has
exactly two useful answers: which design resolves now, and whether the one resolver has mounted a
card at all.

```text
tool designs: 1 tools with designs
  - bash: bash-card.bash-heading, wrapper mounted on 2 cards
      bash-card.bash-heading "bash heading" — heads the card with bash instead of the host's $ mark
tool design resolver: registered (1 registered)
```

## Reaching the bridge without importing it

A plugin and the bridge are two independent projects, so a path to one checkout is not a contract.
They meet on `globalThis`, behind one stable symbol:

- `Symbol.for("gentle-shell-bridge/api/v1")` holds
  `{ schema: "gentle-shell-bridge/api", version: 1, VERSION, registerRows, registerSection, registerCardStyle, registerTransform, registerToolDesign, requestRepaint, createStore }`.
  It is frozen, first-wins (a valid object already there is kept, not replaced) and never reset.

**Register at `session_start` if the package loaded first, otherwise when it announces itself.**
The symbol is the authority; the announcement is the timing. Pi does not guarantee that this
package loaded before your plugin: global extensions (`~/.pi/agent/extensions`) load, and receive
`session_start`, before a configured package's module publishes — observed in a real TUI, where the
worked example said "no compatible bridge" while a bridge was about to appear. So a plugin loaded
early listens for one event:

```ts
pi.events?.on("gentle-shell-bridge:ready", ({ schema, version, VERSION }) => {
  // the object is published now: read the symbol again and register
});
```

The bridge emits it **once per process**, after a successful publish, and never when the slot holds
an incompatible payload. It carries identity only — `{ schema, version, VERSION }` — because it is a
notification, not a registry: the listener reads the symbol and applies the same gate. A Pi without
`pi.events` emits nothing, and the symbol still works for anyone who reads it.

Inline the gate (the example does), or import the package and let `onBridgeApi` handle both forms —
handler called immediately when the object is already there, subscribed when it is not, detached
after one delivery:

```ts
const KEY = Symbol.for("gentle-shell-bridge/api/v1");
const isApi = (v: any) => typeof v === "object" && v !== null && v.schema === "gentle-shell-bridge/api" &&
  v.version === 1 && typeof v.registerRows === "function" &&
  typeof v.registerSection === "function" && typeof v.createStore === "function";

const register = (): boolean => {
  const api = (globalThis as any)[KEY];
  if (!isApi(api)) return false;
  api.registerSection({ id: "loon.music", title: "MUSIC", lines: () => ["…"] });
  return true;
};

if (!register()) pi.events?.on("gentle-shell-bridge:ready", register);

pi.on("session_start", (_event, ctx) => {
  if (!register()) {
    ctx.ui?.notify("my-plugin: waiting for gentle-shell-bridge to announce itself", "warning");
  }
});
```

A plugin that imports the package gets both forms in one call — the handler runs immediately when
the object is published and when the announcement arrives otherwise, and the subscription detaches
itself after one delivery:

```ts
import { onBridgeApi } from "gentle-shell-bridge";

const dispose = onBridgeApi((api) => {
  api.registerRows({ id: "loon.banner-source", category: "Cards", rows: () => [] });
}, pi.events); // works in both load orders; `bridgeApi()` alone does not wait
```

Rules worth knowing: an object that fails the gate (wrong schema, `version !== 1`, a missing member)
is **absent**, never an error — `bridgeApi()` returns `undefined`, one warning is emitted per
process, and the slot is left exactly as it was. A breaking change takes a new `v2` symbol key
rather than mutating `v1`. An older bridge publishes nothing at this key, so a newer plugin sees
"absent" instead of being deferred silently; that compatibility cliff is intentional. The full rule
and complete snippets are in [docs/contract.md](docs/contract.md) §9, with the surfaces documented in
§9 (rows, sections, store), §12 (card styles) and §13 (transcript transforms).

## Quick start: rows

```ts
import { createStore, registerRows } from "gentle-shell-bridge";

const store = createStore("loon"); // ~/.pi/gentle-ai/gentle-shell-bridge/loon.json
const read = () => store.get("bannerSource", "activity");

const toggle = (value: string) => ({
  category: "Banner" as const,
  label: () => "Loon banner source",
  choice: { setting: "Loon banner source", value, current: () => read() === value },
  action: () => store.set("bannerSource", value), // persist first; the menu re-renders
});

const dispose = registerRows({
  id: "loon.banner-source",
  category: "Banner",
  rows: () => [toggle("activity"), toggle("output")], // consecutive, same setting → one line
});

// dispose() removes every row this provider contributed; other providers are untouched.
```

### Row names

`choice.setting` (the line's name) and `label` (the row's text) are read by a human, so both obey one
shape: **one to three plain words**, title case like the host's own `Card style` / `Card content`,
and **none of** `→ ← ↑ ↓ : . | / \ [ ] ( ) { }`. No trailing qualifier — the category says where the
row lives and the values say what the choices are:

```text
Bash design                     OK    a row name, in the host's own vocabulary
Bash card → Bash rendering      BAD   an arrow and a repeated qualifier: reads as a breadcrumb
Bash card: rendering            BAD   a colon
Section: bash-card.status       BAD   a prefix plus a dotted internal id
```

The bridge enforces this rather than trusting authors, and it never rewrites a name it refused:

- a provider row whose line name or label breaks the shape is dropped from the menu build, so it
  reaches neither the host's rows nor the rows `/bridge-status` compares;
- a section or a card style whose `rowLabel` breaks it is not registered at all;
- the offending string and the rule it broke are recorded verbatim and listed by `/bridge-status`
  under `row name rejections`.

## Supported row kinds

Every field below is already understood by gentle-shell's own renderer; the bridge carries rows
as authored, with one deliberate exception: it sets `choice.applyOnMove: false` on every row it
contributes, so a toggle is navigated and confirmed with Enter instead of switching as the cursor
passes over it (the host's own rows keep their own field, so `Card style · neon/float` still
applies on ←/→). While a bridge row is focused, the host's footer reads exactly
`←/→ choose · Enter apply` instead of `←/→ change`, and a move writes nothing: no store update, no
persisted value, no repaint. Enter applies once.

| Kind | Shape | Renders as |
| --- | --- | --- |
| Toggle | two or more consecutive rows sharing `choice.setting` | one line `Name ● current ○ other`; ←/→ moves the `›` cursor and the footer reads `←/→ choose · Enter apply`, Enter applies (the bridge always sets `applyOnMove: false`) |
| Action | a row without `choice` | one line; Enter/Space runs `action(inline)` |
| Gated | `visible()` returns `false` | row hidden; a throw fails closed and hides it |
| Preview | `preview()` returns `{ title, sample }` | read-only preview for the focused row |
| Inline editor | `action` calling `inline.input()`, `inline.confirm()`, `inline.capture()` | field, confirmation or key capture drawn inside the card |
| Hint | `keyhint` | per-row footer hint instead of the category default |

`label` may be a string or a function, and is evaluated when the menu is built, so it can
read live state. Full details, conflict policy and failure isolation:
[docs/contract.md](docs/contract.md).

## Diagnostics

The bridge registers one command, `/bridge-status`. It reports the registered providers (id
and category, in subscription order), the active backend (`hook` or `capture`), the last
capture outcome with the injected row count, the last provider failures, store problems and
duplicate `category` + `setting` pairs across providers, and any row name the shape rule rejected —
the surface, the registration id, the offending string verbatim and the rule it broke, under
`row name rejections` — so a missing row is an answer, not a silent no-op. Duplicates are computed
from the rows the last menu build actually received, so before any build the report says
`duplicate settings: no build yet` instead of claiming there are none. Diagnostics never run a
provider's `rows()`.

The first answer is whether the required host package is there: `gentle-pi: present`, or
`gentle-pi: missing — <reason>` followed by one `bridge: disabled` line, because this bridge needs
`gentle-pi` (it feeds `/gentle:customize`) and arms nothing without it — no rows, sections, card
styles, tool designs or wrappers, and no per-surface block claiming work it is not doing.

It also answers the sidebar question: a `sections` table (id, title, the `row` label the menu
reads plus a collision note when two labels wanted the same text, persisted visibility — and
`collapsed` while the card is folded — and where the position comes from), the most recent frame's
`section failures` (phase `lines`, `meta` or `onClick`), and a `sidebar` line —
`intercepted (rail wrapped)`, `intercepted (rail pending)`, `no-sidebar-state`, or
`not armed` with the reason the wiring could not acquire a `tui`. Three more lines say how the card
is drawn and how the pointer reaches it: `section frame: host` or `fallback` with what was looked
for and whether a theme had arrived, `section interaction:` with the pointer path and the hover
claim, and — in the fallback case — a `section frame gap:` line naming what cannot be reached. Those
blocks appear only when they have something to say, so a row-only install keeps the historical
output. Diagnostics never run a section's `lines()`/`meta()` either; the rail's digest does, during a
frame. The hook backend is reported as
`hook` only when this process pushed its fan-out provider into a host registry. Ids stay in this
report on purpose: it is for the plugin author diagnosing a registration, not for the user picking
a toggle.

For card styles it reports the line mode (`extended` when the host's own line was found,
`separate` when the fallback line was used), the registered styles in order, the live selection
(including a disposed one, as `missing`), what the last frame did (`transformed N cards`,
`pass-through (native | missing | no card)`, or `failed` with the style and message), the per-style
failures, whether the conversation component was wrapped, and the reminder that a downstream
post-processor can override the frame. Per surface it also says whether the style reached it and what
its last frame did there (`card style surface rail: reached (rail wrapped), last frame transformed 3
cards`, or `not reached (no-layout-root)`), and it reports the last repaint a bridge-owned write
requested — `last repaint: rail for section "loon.music" → hidden (repainted)` — including the reason
when no frame could be asked for. A visibility toggle and a card-style selection repaint
synchronously, before the action returns; nothing polls.

For transcript transforms it reports the registered pipeline in order — `order 10` or `registration
order` — and what the last frame did with each one: `applied`, `skipped`, `failed` with the message,
or `not run` for a transform registered after that frame. The block appears only when a transform is
registered, so a session that never used the pipeline keeps the historical report byte for byte.

The bridge also sets **one INTEGRATIONS row per plugin** in Pi's footer, through
`ctx.ui.setStatus(key, text)`, and reports it as a per-plugin list: the name and whether it was
`derived from package "@acme/loon-kit"` or an `explicit name`, the registrations `accepted` and
`rejected`, and whether the row is set — or `no line set` with the reason. The header says when the
host's `setStatus` is unavailable at all. The rules that line obeys:

- **The row text is opaque.** The host renders the whole string as one row, so everything the row
  says is inside it: `Loon kit · ready`. Its `sanitizeStatus` strips ANSI and collapses whitespace,
  so **ANSI is not available** to a plugin, and any glyph must be part of the text
  (`🧠 gentle-pi · ready` is the host's own fixture).
- **Colour belongs to the host.** Every entry is painted with one shared role; a plugin chooses a
  glyph, never a colour.
- **One plugin means one line.** Ten rows, three sections, a card style, a transform and a tool
  design still paint one row; later changes repaint the same key in place, and `session_shutdown`
  clears it with `undefined`.
- **The name is derived, or given once.** The bridge resolves the module that registered to its
  owning `package.json` and derives one to three plain words (`@acme/loon-kit` → `Loon kit`); any
  registration may pass `name`, and the first usable declaration fixes it for the plugin.
- **Identity is the plugin; the name is sticky.** A plugin is its owning package root (or the module
  when no package owns it), resolved once and keyed from that identity — never from the display
  name, so a rename repaints the same row and never adds one. A single copied file with no owning
  package gets **no row** (fail closed, the reason is in `/bridge-status`) unless it passes that
  `name`. The Pi installation is never a plugin identity: a module owned by the package that
  provides `pi` fails closed the same way, so its shared extensions directory cannot add a
  `Pi coding agent` row. A later registration that declares a different name never renames the
  row — the first name stays and `/bridge-status` reports the conflict. A rejected name is never
  shown.
- **`ready` is derived, never promised.** One rejected registration — an invalid id, a row label that
  broke the shape rule — makes the same key read `degraded`, and the report names the rejected
  items.

## Limits

- **No new categories.** gentle-shell's renderer types `category` as a closed union
  (`Animations | Banner | Themes | Editor | History | Notifications | Layout | Cards |
  Sections | Keymaps | Profiles | Reset`, `lib/visual-customize-view.ts:105`). The bridge's
  own `CustomizeRow.category` is a `string`, and it cannot create a category the renderer
  does not know, so pass one that already exists — `Cards`, `Banner`, `Layout` and so on.
- **No upstream hook exists.** The bridge depends on gentle-shell internals; the day
  gentle-shell changes its menu construction, the fix is in one place, but it is still a
  fix against internals rather than a supported extension point.
- **The capture backend patches `Array.prototype.map`** for the duration of one
  synchronous factory call. It is restored in a `finally` block, it never survives the
  call, and it is only installed inside the customize-menu path.
- **The capture is heuristic.** It recognises the row array by shape; a menu that builds
  its rows differently produces no capture. That case is reported by `/bridge-status` instead of
  passing silently.
- **Card styles are a repaint, not a host feature.** The bridge rewrites the `float` frames
  gentle-shell already drew, so it depends on that grammar, and a downstream post-processor that
  re-frames the conversation and strips box chrome can override the result — the bridge
  says so in `/bridge-status` instead of pretending otherwise. Detection is proven against a fake
  conversation built from real `shell-card.ts` output, never in a running TUI, and a card with a
  blank body row is detected as ending at that row.
- **A transform is a per-frame pass, not a host feature either.** It runs inside the wrapper the
  bridge already installs on the conversation component, so it depends on the same Pi tree the card
  styles do, and a downstream post-processor can still override the frame. A transform sees lines,
  not tool metadata: a plugin that needs the call's arguments or the result object still has to use
  `pi.registerToolRenderer` for rows that are yet to be built. A throwing transform is isolated per
  frame; a slow one runs on every frame, which the bridge cannot bound.
- **Tests cover a fake host, not the real TUI.** 422 tests run under `node --test`; 26 of
  them are end-to-end through the public API and the extension entry, against a fake host
  that models `gentle-shell.ts:3550-3562` and a fake sidebar that models
  `lib/shell-sidebar.ts` and the layout's card frame. The capture technique is verified in the
  real TUI only by the reference probe, and the hook backend has never run against a real host.
- **The sidebar has never been seen in a running TUI.** The rail interception, the section
  cards and the automatic `Sections` rows are proven against the fake rail. In particular,
  whether the widget Pi hands the `tui` through leaves the editor area visually untouched is
  **unconfirmed** — the component renders no rows, which is the minimal guess.
- **Sections render after the native cards, never between them.** The host's status sections
  are built in a closure, so interleaving is not offered.
- **The sidebar needs `ctx.ui.setWidget`.** Pi exposes no `tui` getter; without the widget
  factory the rail cannot be reached, and `/bridge-status` reports `sidebar: not armed` with
  the reason while the `Sections` toggle keeps working.
