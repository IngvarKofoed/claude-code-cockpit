# Model chip colours, by model family

The Live card's model chip takes a colour keyed to the model's **family** — applied as
**border and text only, never fill**, so two cards running different models are tellable apart
at a glance without the chip reading as a status pill. The family→colour assignment is daemon
config (`modelColors`), edited in Settings, validated in `config.js`, and broadcast over SSE
like every other config change. The palette is **eight hues**, generated at the theme's own measured colour character —
see *The palette*.

## Outcome

**What you get:**

- Each Live card's model chip is tinted by model family — opus magenta, sonnet teal, haiku
  orange — as **border and text only**, so the chip never reads as a filled status pill.
- A **Model colours** section in Settings: a master switch plus a per-family picker over the
  eight-slot palette, each row showing a live preview of the chip it configures.
- The assignment lives in daemon config, so it is shared by every browser pointed at this
  daemon and is hand-editable in `config.json`.
- A model the cockpit doesn't recognise — and any family set to `none` — renders exactly the
  chip it does today.

**How to verify:**

- With sessions on two different families live, their model chips differ in border and text
  colour and neither has a coloured background.
- Changing opus to `orange` in Settings repaints the opus chips in an already-open second
  dashboard without a reload, and the preview chip in the picker updates on the same click.
- Switching the master switch off returns every model chip to the neutral chip; switching it
  back on restores the same assignment rather than a default one.
- In both themes, every palette slot measures **≥4.5:1** against the chip's `--surface-2`
  background.
- `node --test` covers `modelFamily()` for a plain id, a `[1m]` variant, a dated snapshot, the
  segment-order outlier `claude-3-5-haiku`, and an unknown id.

## Key decisions

- **Colour is border + text, never background** (extends). `.chip--model` — a new modifier —
  overrides only `color` and `border-color`; the `background: var(--surface-2)` it inherits
  from `.chip` stays. A filled chip would read like `.chip--live`, which uses a 14% wash to
  mean "work happening now". This constraint is what forces the hue to double as the chip's
  *text* colour, which is why every slot must clear WCAG text contrast; see *The palette*.
- **Eight slots at the theme's own colour character** (new). Generated at the L/C measured from
  the existing status/series/session tokens (dark L≈0.69 C≈0.156; light L≈0.58 C≈0.162) rather
  than at maximum chroma, which came out neon and off-theme. The one hard bound is WCAG text
  contrast — the hue *is* the chip's text colour — held at ≥4.5:1 on `--surface-2` in both
  themes. **No green slot:** ΔE 3.5 from `--st-running` would read as the running indicator.
- **Chart-grade CVD/ΔE floors deliberately not applied** (diverges). `dataviz`'s all-pairs
  CVD≥8 and normal-vision ΔE≥15 cap this at three colours, because red-green CVD collapses the
  wheel. They are the wrong bar here and the validator says so itself — *"scope: categorical
  palettes only. For a lone status/text color check WCAG text contrast."* A chart palette must
  survive any assignment the data makes; this is a **picker the user assigns by hand**, over
  marks that permanently spell out the model name. `web/CLAUDE.md` mandates reading `dataviz`
  before a colour-by-series choice, which is how these floors were measured before being set
  aside — not skipped.
- **Keyed on family, not model id** (new). `claude-opus-5` and `claude-opus-4-8` share a
  colour. Fifteen model ids over eight hues would recycle and stop being a signal.
- **Family extraction lives in `scripts/pricing.js`** (extends). That module already owns
  model-id string surgery (`baseModelId`), and it is pure and unit-testable — `web/` has no
  test framework at all (`web/CLAUDE.md`), so a client-side implementation could not be tested.
  `styles.css` owns the slot *names*; `pricing.js` owns the family list.
- **The daemon ships `modelFamily` on the card, the client resolves the colour** (extends).
  `toCard` (`scripts/aggregate.js`) is a shallow spread, so one added string is cheap. The
  family is config-independent and stable; the colour is not, and `onConfigChanged()` already
  calls `renderLive()`, so a config edit repaints without a payload change.
- **`modelColors` merges per key onto the defaults** (diverges). Deliberately unlike
  `cost.rates`, which *replaces* the default map wholesale so a deleted model stays deleted.
  Families are a closed set nobody deletes, so merging — the `events` precedent — is what makes
  a config saved before this key existed come up with the defaults instead of an empty map.
- **This is daemon config, reversing `2026-09-09-pinned-live-cards`** (diverges). That entry
  rejected daemon-side pins on the grounds that "every comparable Live preference is
  per-browser". Overturned deliberately: a colour scheme is a stable choice you make once, not
  a per-tab view state, and `config.json` being hand-editable matters for it. Note the daemon
  binds `127.0.0.1` only and remote access is an explicit non-goal, so the benefit is
  cross-browser and cross-profile on one machine — not "across machines".
- **No `CONFIG_VERSION` bump, no migration** (reuses). An absent `modelColors` or
  `modelColorsEnabled` already yields the defaults, because `validateConfig` builds from
  `clone(DEFAULT_CONFIG)` and only overwrites keys present in the input.

## Goals

- Tell two Live cards running different model families apart without reading the chip text.
- Offer enough colours to be worth picking from, all legible as 11px text in both themes —
  the chip's text colour is the carrier, so an illegible slot is strictly worse than no colour.
- Let the assignment be changed once and apply to every browser pointed at this daemon.

## Non-goals

- Colouring anything else that names a model. The History by-model charts keep their positional
  `--series-*` assignment. **Accepted cost:** after this, "model" is coloured two different ways
  depending on the view — family hue on Live, positional hue on History.
- Per-model-id colours, and per-generation shades within a family.
- A per-browser override.
- Touching `--series-*` or `SERIES` (`web/app.js`). The chart palette is untouched.

## Design

### Families and extraction

Five families: `opus`, `sonnet`, `haiku`, `fable`, `mythos`. `pricing.js` gains:

```js
const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'];

// The family token's POSITION varies by id generation: "claude-opus-5" carries it second,
// "claude-3-5-haiku" last. So scan the segments for the first known family rather than
// indexing. Returns null for an id with no known family — a model Claude Code ships before
// the cockpit knows it must render as today's neutral chip, not as a wrong colour.
function modelFamily(model) {
  if (typeof model !== 'string') return null;
  const parts = baseModelId(model).split('-');
  for (const p of parts) if (MODEL_FAMILIES.includes(p)) return p;
  return null;
}
```

`baseModelId` first, so `claude-opus-5[1m]` and `claude-haiku-4-5-20251001` resolve like their
base ids — the same identity pricing already relies on.

### The palette

**Where the values come from.** Generated at the **house colour character** measured across the
existing `--st-*`, `--series-*` and `--sc-*` tokens — dark L≈0.69 / C≈0.156, light L≈0.58 /
C≈0.162 — so the chips read as part of the same instrument set. An earlier max-chroma pass
produced neon (`#4ff701`) that did not belong on this theme. The hard bound is **≥4.5:1 on
`--surface-2` in both themes**, because the hue doubles as the chip's text colour.

| Slot | Dark | Light | Contrast (dark / light) | Nearest status token |
| --- | --- | --- | --- | --- |
| `rose` | `#e06fa9` | `#b94383` | 5.39 / 4.51 | ΔE 11.8 / 10.8 |
| `magenta` | `#c778d4` | `#a04dad` | 5.43 / 4.54 | ΔE 11.6 / 13.1 |
| `violet` | `#9f87f2` | `#785ccb` | 5.55 / 4.51 | ΔE 5.0 / 6.4 — near paused |
| `blue` | `#5b9bfa` | `#296dce` | 5.78 / 4.53 | ΔE 6.9 / 2.6 — near `--accent` |
| `cyan` | `#00adce` | `#057a91` | 6.05 / 4.50 | ΔE 11.9 / 7.4 |
| `teal` | `#00b5a2` | `#007d70` | 6.25 / 4.54 | ΔE 7.5 / 7.4 — near running |
| `amber` | `#ca9000` | `#936700` | 5.77 / 4.52 | ΔE 11.3 / 4.5 — near waiting |
| `orange` | `#e9754b` | `#c04815` | 5.47 / 4.52 | ΔE 6.9 / 5.2 — near error |

Plus `none`, the neutral chip. Cyan and teal carry lower chroma than the rest: both are
intrinsically light hues, so reaching text contrast on a light surface costs saturation.

**What is accepted.** 20–21 of the 28 pairs sit at ΔE≥15; the closest are adjacent wheel
neighbours (rose/magenta 7.5, cyan/teal 5.7). Several slots sit within ΔE 5–8 of a status
token. Both are acceptable because the user assigns these by hand and can simply not pick two
they can't separate — unlike a chart, where the palette must work for whatever the data does.
The chip also always renders the model name, so the colour is never the sole carrier.

**Defaults:**

```json
"modelColorsEnabled": true,
"modelColors": {
  "opus": "magenta",
  "sonnet": "teal",
  "haiku": "orange",
  "fable": "none",
  "mythos": "none"
}
```

The three families anyone actually runs side by side get colours; `fable` and `mythos` default
to `none`, which also means the shipped config demonstrates that value and leaves the five
remaining slots as deliberate user choices.

**Why slots near the semaphore are acceptable.** They are 5–8 ΔE from their nearest status
token — a related family, not the same colour — and the separation is carried by
*form*, not hue: the chip is bordered mono text in the chips row, while status is a filled rail
plus a badge containing the word "running" or "error". Neither instrument is colour-alone in
either direction. The same argument covers the session `/color` dot
(`2026-08-25-session-color-dot`), a 7px filled circle on the name line whose `--sc-*` tokens are
untouched here. Still worth a deliberate look during browser verification: a teal chip on a
green-railed card, and an orange chip on a red-railed one, are the two cases to judge.

### Rendering

At `web/app.js:668`:

```js
const slot = App.cfg && App.cfg.modelColorsEnabled && App.cfg.modelColors
  ? App.cfg.modelColors[s.modelFamily] : null;
```

`App.cfg` is null until the first state frame, so it is guarded like every other reader
(`costEnabled()`, `app.js:114`). A family with **no entry** resolves to `undefined` and must be
treated exactly as `none` — otherwise the renderer would emit `var(--mc-undefined)`, which is
the failure mode if `MODEL_FAMILIES` ever grows without `DEFAULT_CONFIG.modelColors`.

When a slot resolves to something other than `none`, the chip gains a class and a custom
property; otherwise it is emitted exactly as today, same markup, no inline style:

```js
`<span class="chip chip--mono chip--model" style="--model-c: var(--mc-${slot})" title="…">`
```

```css
/* Model family tint: OUTLINE + TEXT only. The inherited --surface-2 background stays;
   a filled chip would read as .chip--live's "work happening now". */
.chip--model { color: var(--model-c); border-color: var(--model-c); }
```

`.chip--model` follows `.chip` in source order at equal specificity, so it wins without `!important`.

### Config validation

`validateConfig` follows the `events` block exactly: iterate
`Object.keys(DEFAULT_CONFIG.modelColors)`, read only those keys, silently ignore unknown ones —
so adding a sixth family later cannot reject an older config. A *value* outside the eight slots plus `none` is an error, following `activityDetail`.
`modelColorsEnabled` joins the existing boolean loop beside `osNotifications` /
`pauseGateEnabled`.

**One seam worth knowing:** rejecting leaves the on-disk config untouched only on
`PUT /api/config`. `readConfig()` returns `validateConfig(migrated).config` and **ignores the
`valid` flag**, so a bad value hand-edited into `config.json` is silently replaced by the
default at boot with nothing surfaced. That is pre-existing behaviour, not introduced here, but
this spec advertises hand-editability, so it is named rather than discovered.

### Settings

A new `section("Model colours", …)` directly below Dashboard. Its own section on size and
grouping grounds — five family rows is too much to hang off one Dashboard row — *not* because
Dashboard is per-browser only: that section already holds six daemon-config controls
(`set-browserSounds`, `set-usagePace`, `set-activityDetail`, `set-pauseGateEnabled`, both
auto-pause fields, `set-subscriptionLabelPattern`).

A master `sw("set-modelColorsEnabled", …)` switch gates the feature, mirroring how
`cost.enabled` gates the cost column: switching it off preserves the assignment underneath.
Below it, one `fieldRow(…, wide)` holds five family rows, reusing the `field--stacked` flag
`2026-09-16-live-card-stat-visibility` added for the stat-column checkboxes. Each row is a
family name, a `<select>` of the nine values, and a **live preview chip** rendered with the real
`.chip--model` markup.

**The preview must be repainted inline by the `change` handler** — by setting `--model-c` on
that row's chip directly. It cannot rely on a re-render: a `<select>` change falls through to
`scheduleSave()`, and `saveSettings()` never re-renders Settings; the SSE `config` frame's
`maybeRenderSettings()` then bails while focus is inside the form (`app.js:3349`), and after a
mouse change the `<select>` still holds focus. Without the inline repaint the preview stays
stale until the user clicks away *and* another config frame arrives — the feature's headline
affordance silently not working.

`readSettingsForm()` must include both `modelColorsEnabled` and `modelColors`. It sends the full
config and `validateConfig` rebuilds from defaults, so a key left out is reset to its default on
the next save of any unrelated setting.

## Alternatives considered

- **A per-browser `localStorage` pref.** What `2026-09-09-pinned-live-cards` points at, and
  rejected here — see the Key decision for why, and note it is a real reversal of that entry.
- **Aliasing `--series-1..6` instead of new tokens** (`--mc-blue: var(--series-1)`), for free
  light-theme values. Tried and measured out: `--series-5` is `#9085e9` against `--st-paused`
  `#8b7bff`, and in light theme `--series-5` `#4a3aa7` is *byte-identical* to `--paused-ink`.
  Worse, the chart tokens are validated as fills, not text — five of the six measured below 4.5
  on `--surface-2`, including `--series-1` at 3.97 in light, versus the neutral chip's 6.06.
- **A palette clear of every status token.** Does not exist at any useful size — only magenta
  and rose sit clear of all of them. Accepted rather than designed around.
- **A low-alpha wash carrying the hue** (the `.chip--live` pattern) with the text left near
  `--ink`. This decouples legibility from hue and would reopen most of the wheel — it is the
  single change that would buy more slots. Rejected to keep the chip visually distinct from
  `.chip--live`, whose wash means "running now".
- **Per-model-id colours.** Fifteen default ids over eight hues still recycle.
- **A green slot.** ΔE 3.5 from `--st-running` in both themes; it would read as the running
  indicator, which is the most frequent status on the card. Do not add one.

## Implementation strategy

*Not part of the design — a starting point for whoever builds this.*

- **Single agent, Opus 5.** Five source files on one dependency chain —
  `pricing.modelFamily()` → `aggregate.toCard` → `web/app.js` render → Settings →
  `config.js` schema — plus `docs/ARCHITECTURE.md` and a changelog entry. Nothing splits into
  independent streams, and the `(diverges)` merge-vs-replace rule and the inline preview
  repaint both need interpreting rather than transcribing.
- **The palette values are settled** — they passed `validate_palette.js --pairs all` in both
  modes and are measured against every status token. Don't re-derive or "tidy" them; changing
  one means re-running that validation.
- Verification is the usual three: `node --test` (including the new `modelFamily` cases), the
  `emit.js` stdin smoke test, and browser verification per `web/CLAUDE.md` — with a deliberate
  look at a teal chip on a green-railed card and an orange chip on a red-railed one.
