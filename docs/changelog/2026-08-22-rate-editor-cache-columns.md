# Settings rate editor gains a Cache write 1h column

Settings' rate editor gained a "Cache write 1h" column (and relabelled the other to
"Cache write 5m"). Not cosmetic: the save path rebuilds `rates` from that table, so without
the column every save would silently strip the 1h rate back to 5m pricing. A BLANK cell is
meaningful and round-trips as an absent key (the fallback), never as 0.

<!-- entry 139 -->
