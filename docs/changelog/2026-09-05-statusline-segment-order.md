# Statusline moves token and cost readouts to the end

Statusline segment order is now `cwd · ctx · usage(5h) · branch · model · tokens · cost`
— the two money/token readouts moved from the middle to the END, past `model`
(revises entry 47's order). The line's left half is now wholly the "where am I and
how full am I" instruments, with the accounting figures parked together at the tail.
Renderer only; no payload, install, or forwarding change, so no reinstall is needed.

<!-- entry 193 -->
