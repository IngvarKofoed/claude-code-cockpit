# Repository-name sort now orders sessions by session name

The Live view's "Repository name" sort now orders sessions WITHIN a repo by SESSION NAME
rather than by cwd — the name is what the card actually shows, so the grid reads in the
order you see it. An unnamed session sinks below every named one in its repo instead of
sorting as "" and floating to the top (unknown is not empty, per the context sort).
`repoRoot` sits between repo name and title, so two clones sharing a basename
(`~/work/api`, `~/oss/api`) stay separate groups instead of interleaving under one name.

<!-- entry 194 -->
