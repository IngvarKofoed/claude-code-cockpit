# Config version 2 adds Opus 5 rate to persisted maps

CONFIG_VERSION 2 adds a rate key that first shipped as a v2 default to a persisted `rates`
map. A saved map REPLACES the defaults (entry 5), so anyone who had touched Settings would
price Opus 5 as "—" forever. Re-adding is safe only for never-before-shipped keys: their
absence can't be a deliberate Settings removal, which is why the v0→v1 step still never
re-adds a missing key. An existing entry, at any value, is left untouched.

<!-- entry 135 -->
