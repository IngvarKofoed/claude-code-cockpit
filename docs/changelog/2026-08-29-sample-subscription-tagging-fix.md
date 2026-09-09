# Weekly samples tagged by the pushing session's subscription

Two review fixes to the sliding rate. A weekly sample is now tagged with the PUSHING
session's own subscription, not the current-subscription fallback the displayed snapshot
uses: that fallback self-corrects on the next push, but a sample is read back up to a full
lookback later, so an unknown-subscription push would leak a foreign account's percentage
into a real subscription's history for hours. Unknown lands in the null bucket.

<!-- entry 167 -->
