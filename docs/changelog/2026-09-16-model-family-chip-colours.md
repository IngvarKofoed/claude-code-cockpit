# Live card model chips are tinted by model family

A Live card's model chip now carries a colour for its model **family** — opus magenta, sonnet
teal, haiku orange by default, from an **eight-hue palette** — as **border and text only, never
a fill**. The map is daemon
config (`modelColors` + a `modelColorsEnabled` master switch), edited in a new Settings ▸ Model
colours section and shared by every browser on this daemon. An unknown family, or a slot set to
`none`, renders the neutral chip exactly as before.
Spec: `docs/specs/2026-09-16-model-chip-family-colours.md`.

## Detail

- **Eight slots, generated at the theme's own measured colour character** — dark L≈0.69/C≈0.156,
  light L≈0.58/C≈0.162, taken from the existing `--st-*`/`--series-*`/`--sc-*` tokens. An earlier
  max-chroma pass produced neon (`#4ff701`) that did not belong on this theme. The one hard bound
  is WCAG **text** contrast, ≥4.5:1 on `--surface-2` in both themes (dark min 5.39, light 4.50),
  because the hue *is* the chip's text colour.
- **Chart-grade CVD/ΔE floors were measured, then deliberately set aside.** `dataviz`'s all-pairs
  CVD≥8 plus normal-vision ΔE≥15 caps this palette at **three** colours — red-green CVD collapses
  the wheel to roughly one axis, so 8 mutually CVD-separable hues do not exist. Those floors are
  the wrong bar here and the validator says so itself: *"scope: categorical palettes only. For a
  lone status/text color check WCAG text contrast."* A chart palette must survive any assignment
  the data makes; this is a **picker the user assigns by hand**, over marks that permanently spell
  out the model name. **Do not re-impose them and shrink the palette back to three.**
- **No green slot, and don't add one.** At ΔE 3.5 from `--st-running` in both themes it would read
  as the running indicator — the loudest and most frequent status on the card. The wheel between
  amber and teal is entirely owned by running-green, so there is no "safe" green to substitute.
- **Accepted:** several slots sit ΔE 5–8 from a status token (violet/paused, orange/error,
  teal/running, blue/`--accent`), and adjacent wheel neighbours (rose/magenta 7.5, cyan/teal 5.7)
  are close to each other. 20–21 of 28 pairs clear ΔE 15. Acceptable because the user picks by
  hand and the chip always spells out the model name, so colour is never the sole carrier.
- **Rejected: aliasing `--series-1..6`** to get light-theme values for free, which is how this
  was first specced. Measured out on two counts: `--series-5` is `#9085e9` against `--st-paused`
  `#8b7bff`, and in light theme `--series-5` `#4a3aa7` is *byte-identical* to `--paused-ink` — so
  the opus default would have been the pause colour. And the chart tokens are validated as fills,
  not text: five of the six measured below 4.5 on `--surface-2` (light `--series-1`, a default,
  at 3.97) against the neutral chip's 6.06. Do not re-introduce the aliases.
- **A stale daemon silently swallows this whole feature.** The dashboard's assets are served
  no-cache, so a browser gets the new Settings UI immediately — but a daemon started before this
  change has no `modelColors` in its schema, and `validateConfig` rebuilds from its own defaults
  and drops the unknown key. The symptom is exact and misleading: "Settings saved" toasts, the
  Live view never changes, and reopening Settings reads "No colour". Restart the daemon (or bump
  the version so `ensure.js` replaces it — it only swaps a daemon whose `/health` reports a
  DIFFERENT version).
- **Verified in the browser, both themes**, against a running (green-railed), waiting (amber) and
  error (red-railed) card. The tightest pair is orange-on-error and it still reads; the form
  difference (a filled badge with a dot and a word vs. bordered mono text) is what carries it.
- **Reverses `2026-09-09-pinned-live-cards`** on one point: that entry rejected daemon-side Live
  preferences because "every comparable Live preference is per-browser". Overturned deliberately —
  a colour scheme is set once, not per tab, and `config.json` being hand-editable matters for it.
  The benefit is cross-browser on **one machine**; the daemon binds `127.0.0.1` and remote access
  stays a non-goal, so this is not "across machines".
- **`modelColors` merges per key like `events`, NOT wholesale like `cost.rates`.** Families are a
  closed set nobody deletes, so a config saved before the key existed comes up fully coloured
  rather than blank — which is what removes the need for a migration or a `CONFIG_VERSION` bump.
  An unknown family key is ignored (a family added later can't fail an older config); a bad
  *value* is an error, so a failed PUT leaves `config.json` untouched.
- **The Settings preview chip is repainted inline by the `change` handler**, not by a re-render.
  A `<select>` change routes to `scheduleSave()`, which never re-renders Settings, and the SSE
  config frame's `maybeRenderSettings()` bails while focus is inside the form — which it is,
  right after a mouse change. Without the inline repaint the preview sits stale until the user
  clicks away *and* another frame arrives. Do not replace it with a re-render.
- **Known gap:** an unmapped family resolves to `undefined` and must be treated as `none` on both
  sides — the client guards it, and a test asserts `DEFAULT_CONFIG.modelColors` keys equal
  `pricing.MODEL_FAMILIES`, because a family added to one and not the other would otherwise emit
  `var(--mc-undefined)` and blank the chip's text.
- **A Settings save passes unknown `modelColors` keys straight through.** The PUT carries the
  whole config and `validateConfig` rebuilds from `DEFAULT_CONFIG`, so a key the browser bundle
  omits is not "left alone" — it is reset to its default. `readModelColoursForm()` therefore
  starts from the live `App.cfg.modelColors` and only overwrites the families that actually have
  a rendered row, so a family (or slot) the daemon knows and a cached page does not survives an
  unrelated settings save instead of silently reverting a hand-edited `config.json`.
- History's by-model charts still colour a model **positionally** from `--series-*`, so "model"
  is now coloured two different ways depending on the view. Deliberate and out of scope; binding
  them to this map is a separate change.
