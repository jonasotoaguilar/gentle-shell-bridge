---
name: gentle-shell-bridge-plugins
description: "Trigger: build or extend a Pi plugin adding a /gentle:customize row or page, sidebar section, card style, transcript transform, per-tool card design, keymapped action, palette item or persisted state to gentle-shell through gentle-shell-bridge."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Read `src/index.ts`, `docs/contract.md` and `examples/bash-card.ts` before editing; never work from memory.

- Reach it from the package root: `onBridgeApi(handler, pi.events)` in `session_start` — runs at once when the object is already published, otherwise once on `gentle-shell-bridge:ready` (`src/api.ts`).
- `bridgeApi()` tells you only what is true now: `undefined` means absent right now — not installed, or not yet published.
- Never patch the host, re-implement the interception, or duck-type the host's menu, rail or card objects.

## Hard Rules

- **Keep every disposer**, call it on `session_shutdown`: each `register*` returns one; a stable namespaced `id` replaces in place on reload.
- **Registrations are evaluated when the host builds the surface**, not when they are made: read live state in `current()`, persist in `action()`.
- **Failures are reported, never thrown at the menu.** An invalid registration throws at the call site and lands in the plugin's INTEGRATIONS line; a throw while building loses only its own surface.
- **`Keymaps` is RESERVED for row providers** — refused and reported. A keymapped action is `registerKeymap` + `resolveKeymap` + your own `pi.registerShortcut`; the bridge never binds.
- **A card style repaints the host's frame** from measured pieces: `top({width, title, hint})`, `line({text, width, first})`, `bottom({width})`. Never parse a card back.
- **A transform** takes the rows plus `ctx.width` and returns rows. Honour the width; report COUNTS ONLY (`ctx.report?.({candidates, recognised, rewritten})`), never card text.
- **A tool design** transforms rows the HOST's card produced, per tool name. The bridge owns Pi's single `registerToolRenderer`: never call it yourself, never draw a second grammar, keep every byte you do not change, never use `native` (the reserved default).
- **Plugin state stays the plugin's**: `createStore(pluginId)`. Bridge-owned store ids (`bridge-card-style`, `bridge-tool-designs`) are read-only.

## Decision Gates

| Need | Call |
| --- | --- |
| Rows in a host category, or a page of your own | `registerRows({id, category, rows})` |
| Toggle vs button row | consecutive rows sharing one `choice.setting` vs `action` with no `choice`; names: one to three plain words, no arrow/colon/dot/pipe/slash/bracket |
| Sidebar card (bridge adds its `Sections` toggle) | `registerSection({id, title, lines, meta?})` |
| Card chrome, conversation and rail | `registerCardStyle({id, label, frame})` |
| A choice that must reach cards already on screen | `registerTransform` |
| One tool's card | `registerToolDesign({tool, id, label, apply})` |
| Rebindable action | `registerKeymap` + `resolveKeymap` + own shortcut |
| Palette item, listed only while its command is registered | `registerCommands` |
| Persistence / repaint after a bridge-owned write | `createStore` / `requestRepaint()` |

These members are OPTIONAL on an older object: `registerCardStyle`, `registerTransform`, `registerToolDesign`, `requestRepaint`, `registerKeymap`, `registerCommands` — gate with `typeof api.x === "function"`.

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

A Pi extension factory returns nothing: disposal hangs off the events, never a returned closure.

3. Verify with `/bridge-status`: backend, last capture outcome, provider, section and tool-design failures.
4. Degrade: with no bridge the plugin still loads — `bridgeApi()` is `undefined`, the handler never fires, nothing throws.

## Output Contract

Return a plugin module that registers only what was asked, from `session_start`, keeping every disposer, gating optional members, using stable ids and legal row names, and owning its state. Say which surfaces registered, were absent or refused, and cite `/bridge-status`.

## References

- `../../docs/contract.md` — every call, argument and guarantee.
- `../../examples/bash-card.ts` — canonical worked example: design, style, section, rows, keymap, palette, store.
- `../../docs/architecture.md` — why the interception exists.
- `../../README.md` — purpose, quick start, limits.
