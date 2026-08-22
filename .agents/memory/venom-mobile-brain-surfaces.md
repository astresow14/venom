---
name: Venom mobile Brain surfaces
description: The phone app has TWO knowledge surfaces — the pager Brain tab and the /knowledge route — and which features belong to which.
---

# Venom mobile Brain surfaces

**Rule:** The phone app renders knowledge in two places. The workspace pager's Brain tab mounts `components/knowledge/KnowledgeWorkspace.tsx` (goo graph scoped to the active project, org/company + network layers, merge/rename/promote). The `/knowledge` expo-router route (`app/knowledge.tsx`) is the full ontology page: all-projects map, sources view, exports, citation-jump target, and the Personal/workspace/Unsorted scope filter (`?scope=unsorted` deep-links into the holding area).

**Why:** A change made on one surface silently misses the other — the Brain filter work initially landed only on `/knowledge` while the tab kept showing every cluster, letting unsorted holdings bleed into the personal graph. Settings and chat citation links route to `/knowledge`; e2e brain-*.spec files mostly drive the tab.

**How to apply:** When touching mobile knowledge UI, check both surfaces. Cluster-visibility rules (e.g. `unsorted !== true` for personal views) must hold in the tab's `visibleClusters` AND search pool; the tab shows an `brain-unsorted-pill` chip that deep-links to `/knowledge?scope=unsorted` instead of duplicating review UI. Node testids differ: tab `knowledge-cluster-<id>`, route `knowledge-map-node-<id>`.
