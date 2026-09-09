# One-shot marker records when switch tracking began

A one-shot `AccountSwitchTrackingStarted` marker records when this store began watching, so
a day before it reads UNKNOWN, never a confident 0 (nothing consumes it yet — a History
chart stayed out of scope). The EARLIEST marker in the log is the answer; the snapshot only
suppresses re-writing, keyed on the marker's DATE so a boot re-marks once
`/api/data/cleanup` unlinks that day — a bare flag would suppress forever, marker gone.

<!-- entry 201 -->
