---
name: ui-review
description: Deep, measured UI/UX review of a tnved_checker page or component (hierarchy, density, cards, verdict, primary action, search, states, responsive/phone, dark/light contrast, overflow, tap targets, accessibility), with browser verification. Use for "проверь интерфейс", "UI аудит", "на телефоне плохо", "не помещается".
---

# UI review

Work under the Senior UI/UX brief the owner gave for this project; measure, do not eyeball.

1. Read [docs/ui-architecture.md](../../../docs/ui-architecture.md) (post-processing passes, verdict/sections, login screen ids, theme tokens, phone rules, known overflow traps) and the browser-check part of [docs/testing.md](../../../docs/testing.md).
2. Open the real page in a browser: the harness of `engine-browser.test.js` (Playwright + system Edge with `PLAYWRIGHT_MODULE`, backend stubbed) or a standalone page assembled from the real `<style>`, `renderHtml(q).html` and the post-processing functions. Measure at 1280 and 390–420 px in **both** themes.
3. Check information hierarchy and density: where the search field starts on the first screen, what is said twice (verdict vs cards), which cards should be a family, the primary action of each page, the empty/loading/error states, the history and suggestions of the search field.
4. Run the mechanical sweeps and keep them at zero: contrast in both themes (composite the background through transparent ancestors, skip gradients; aim for 7–12:1, not maximum contrast), horizontal overflow (list every element whose right edge exceeds `clientWidth` and **rank by width** — the widest is the cause, the rest are victims), tap targets ≥ 32 px on phones (group per element, not per tag), dead `@media` declarations overridden by later rules, accessible names, visible keyboard focus.
5. Fix through tokens and post-processing (`checker.js`, CSS in the page), not by editing the ~40 card templates in `base.js`; a new colour or size is a token; the phone block `@media (max-width:640px)` stays last in the stylesheet; `.si` stays ≥ 16 px on phones.
6. Respect the owner's decisions recorded in the docs: no hero column removal on login, `.wrap` at 1560 px, flat surfaces, the comfortable contrast band.
7. Verify: `checker-access`, `engine-browser`, `lookup-filter`, `assistant-browser` with Edge; screenshots at both widths and themes; `git diff --numstat` and LF-only count for the page and `checker.js`; then `session.md`.
