# Config version 3 backfills cacheWrite1h on unedited rates

CONFIG_VERSION 3 fills in `cacheWrite1h` only on a persisted rate whose four required
classes still equal the shipped default — an entry the user never edited. A CUSTOMIZED rate
is deliberately left alone so its own `cacheWrite` keeps governing both TTLs via the
fallback, which is what that number meant when it was saved; injecting 2x-input there would
silently re-price a deliberate choice.

<!-- entry 138 -->
