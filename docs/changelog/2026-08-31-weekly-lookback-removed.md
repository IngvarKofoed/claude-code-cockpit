# Configurable weekly burn-rate lookback dropdown removed

`usageWeeklyLookbackHours` and its sliding multiplier/limit paths are REMOVED (entries 161–170,
v0.48.0). They REPLACED the stable readouts, so enabling it swapped a number the user trusted
for one that often refused to read — it went unused. Reducing the same computation to a sign
keeps what worked. A persisted key falls out as an unknown key to `validateConfig`; no
migration, per entry 27's `retentionDays` precedent. Do not re-add the dropdown.

<!-- entry 176 -->
