# Sliding rate reads after thirty minutes, not the full span

The sliding rate no longer waits for the FULL span before it will read. It now measures over
whatever the buffer covers, once that is at least 30 minutes — a fixed floor, not a fraction:
the point is to come back quickly after a subscription switch or a fresh daemon, and a
fraction would make the long spans (chosen precisely for a steady number) the slowest to
recover. Before this, a 24h span meant 24h of silence after every switch.

<!-- entry 169 -->
