# Dashboard gains a per-browser light theme toggle

Dashboard light theme (v0.29.0): Settings > Dashboard "Light theme" toggle (default dark),
persisted per-browser in localStorage (`cockpit.theme`, like live-sort, not daemon config or SSE).
Synchronous <head> bootstrap prevents dark flash on load. Tokenized dark-assuming colours:
borders/hover/tooltip/toast flip white-alpha↔black-alpha; switch-knob/banner+danger text fixed.
Charts recolour via CSS var() tokens; heatmap/calendar ramp reads new --heat-* and redraws on toggle.
Light categorical palette = dataviz-validated light steps of the same hues.

<!-- entry 79 -->
