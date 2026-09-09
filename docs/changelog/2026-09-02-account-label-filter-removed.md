# Usage bar guard no longer filters pushes by account label

The usage bars' stale-push guard no longer filters by ACCOUNT LABEL. Claude Code signs in to
one global `oauthAccount`, so an account switch moves every running session at once while
their SessionStart-captured labels stay behind — and matching the pushing session's captured
id against `currentSubscription` discarded exactly the CORRECT readings (216 drops in one
day). Spec: docs/specs/2026-08-18-live-account-usage.md.

<!-- entry 181 -->
