---
name: gentle-shell-bridge-plugins
description: "Trigger: build or extend a Pi plugin adding a /gentle:customize row or page, sidebar section, card style, transcript transform, per-tool card design or persisted state to gentle-shell through gentle-shell-bridge."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.1"
---

## Activation Contract

Read `src/index.ts`, `docs/contract.md` and `examples/bash-card.ts` before editing; never work from memory.

Not for: a plugin that only touches Pi-native surfaces (its own tools, commands, shortcuts, renderers) or
a plain host theme — neither registers through the bridge.

- Reach it from the package root: `onBridgeApi(handler, pi.events)` in `session_start` — at once when already published, otherwise on `gentle-shell-bridge:ready` (`src/api.ts`).
- `bridgeApi()` answers only what is true NOW: `undefined` means not installed, or not published yet.
- Never patch the host, re-implement the interception, or duck-type its menu, rail or card objects.

## Hard Rules

- **Keep every disposer**, call it on `session_shutdown`: each `register*` returns one; a stable namespaced `id` replaces in place.
- **Registrations are evaluated when the host builds the surface**: read live state in `current()`, persist in `action()`.
- **Failures are reported, never thrown at the menu.** An invalid registration throws at the call site and lands in the plugin's INTEGRATIONS line; a throw while building loses only its own surface.
- **`Keymaps` is RESERVED for row providers** — refused and reported: that page captures keys and claims a footer a plain row could never honour.
- **A card style repaints the host's frame** from measured pieces: `top({width, title, hint})`, `line({text, width, first})`, `bottom({width})`. Never parse a card back.
- **A transform** takes the rows plus `ctx.width`, returns rows. Honour the width; report COUNTS ONLY (`ctx.report?.({candidates, recognised, rewritten})`), never card text.
- **A tool design** transforms rows the HOST's card produced, by tool name. The bridge owns Pi's single `registerToolRenderer`: never call it, never draw a second grammar, keep every byte you do not change, never label a design `default` or `native` (reserved). `ctx.render` is optional; an array registers several. A grouped `{ line, tools, id, label, apply }` paints several tools from ONE `Card <line>` switch; two UNSCOPED claims of one tool are refused whole, and no scope covers EVERY call. Fields, lines, preview: `docs/contract.md` §14.
- **A scope claims CALLS, per tool.** A claim is `(line, tool)`: `scopes: { write: scope }` narrows that tool only, so one line may paint some tools whole and others conditionally; `scope` is the shorthand for the SAME scope everywhere. Scoped claims answer in line-creation order, the unscoped one last; a line storing `default` (`native`) declines. GROUPED shape only, `scope` refused with `scopes`, one scope per tool per line (`===`, the same (`line`, `id`) entry excepted), `description` required (it is the preview), a throw is no match. Without `args` only unscoped claims answer. When every candidate declines the LAST answer stands (`missing`, `not-covered`, stored `native`); no candidate answers `native`, and with NO live claim the historical value answers.

- **Plugin state stays the plugin's**: `createStore(pluginId)`. `createStore` reserves nothing, so never take a bridge id — `bridge-card-style` and `bridge-tool-designs` are the bridge's own files.
- **`placement` names a PLACE.** Rows: `"start"`, `"end"` (default: after the category's host rows) or `{ after: "<provider id>" }` — bridge ids only, never host labels; one provider's rows stay one block, so a `choice.setting` pair never splits. Sections: `{ after: "<section id>" }` or `todo`, `jobs`, `agents`, `footer`. Inside one place: finite `order` first, then the rest, ties by `id`, never load order. Unknown/cross-category ids, cycles and unbuilt pages/parts fall back; `/bridge-status` says why, malformed values are refused at registration, and the hook backend reports host-relative placement as unhonourable. Never persisted.

## Decision Gates

| Need | Call |
| --- | --- |
| Rows in a host category or a page of your own | `registerRows({id, category, rows, placement?, order?})` |
| Toggle vs button row | rows sharing one `choice.setting` vs `action` with no `choice`; names: one to three plain words, none of `→ ← ↑ ↓ : . \| / \ [ ] ( ) { }` |
| Sidebar card (bridge adds its `Sections` toggle) | `registerSection({id, title, lines, meta?, placement?, order?})` |
| Card chrome, conversation and rail | `registerCardStyle({id, label, frame})` |
| A choice that must reach cards on screen | `registerTransform` |
| One tool's card | `registerToolDesign({tool, id, label, apply})` |
| Only some calls of a tool | `registerToolDesign({line, tools, id, label, scopes: {<tool>: scope}, apply})` |
| Several tools behind ONE switch | `registerToolDesign({line, tools, id, label, apply})` |
| What a tool draws now | `resolveToolDesignSelection(tool, args?)` |
| Persistence / repaint after a bridge write | `createStore` / `requestRepaint()` |

OPTIONAL on an older object: `registerCardStyle`, `registerTransform`, `registerToolDesign`, `resolveToolDesignSelection`, `requestRepaint` — gate with `typeof api.x === "function"`.

## Execution Steps

1. Pick the smallest surface; read its contract section.
2. Register from `session_start` through `onBridgeApi`, keeping disposers; copy the handshake from `examples/bash-card.ts`.

```ts
import { onBridgeApi, type BridgeApi } from "gentle-shell-bridge";

export default function plugin(pi: any): void {
  const offs: Array<() => void> = [];
  pi.on("session_start", () => {
    offs.push(
      onBridgeApi((api: BridgeApi) => {
        offs.push(api.registerRows({ id: "acme.banner", category: "Cards", rows: () => [] }));
      }, pi.events),
    );
  });
  pi.on("session_shutdown", () => {
    for (const off of offs.splice(0)) off();
  });
}
```

A Pi extension factory returns nothing: disposal hangs off the events, not a returned closure.

3. Verify with `/bridge-status`: backend, capture outcome, provider/section/tool-design failures.
4. Degrade: with no bridge the plugin still loads — `bridgeApi()` is `undefined`, the handler never fires.

## Output Contract

Return a plugin module that registers only what was asked, from `session_start`, keeping every disposer, gating optional members, using stable ids and legal row names, owning its state. Say which surfaces registered, were absent or refused, and cite `/bridge-status`.

## References

- `../../docs/contract.md` — every call, argument, guarantee (sections: Surface 2).
- `../../examples/bash-card.ts` — canonical worked example: design, style, section, rows, store.
- `../../docs/architecture.md` — why the interception exists (`§12` for the rail).
- `../../README.md` — purpose, quick start, limits.
