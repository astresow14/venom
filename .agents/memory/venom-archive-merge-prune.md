---
name: Venom archived-citation merge prune
description: Cross-device merge recomputes the retired-citation archive instead of unioning it; rules for keeping merge and local prunes in lockstep.
---

The workspace merge does not union retired-citation archives. It recomputes need from the merged snapshot: an entry survives only while some merged conversation still cites its id AND no merged live source serves that citation id live again. Pruning runs BEFORE the 500-entry cap so a stale pile cannot evict evidence answers still need. When the cap still bites, eviction is cited-first: entries some saved answer still cites survive ahead of uncited ones, oldest evicted first within each group, final order overall newest-first.

**Why:** The archive is a bounded render cache (titles for retired `[source:...]` markers), not a source of truth. A plain union let any device that had not pruned yet re-upload entries another device dropped (refresh-restore, project/source removal), regrowing the archive every sync. Recomputing on the merged state is self-healing in both directions: it drops what nothing needs and keeps titles for markers that genuinely won a merge.

**How to apply:**
- The merge must stay at least as strict as every local prune path, and use the same cited-set definition (conversation messages only — cluster/brain-note markers deliberately do not count, matching the local prunes). If the merge kept more than local prunes drop, local cleanup would be resurrected on the next sync.
- Adding a new retention rule (e.g. "keep entries cited by X") requires updating the local prune paths AND the merge recompute together, or devices will flip-flop.
- "Live" means the citation id appears in any merged live source's citations — mirrors the local refresh prune, which also drops on id-live regardless of project.
- Every client with its own merge implementation must apply the same recompute and carry the field, or one client's sync erases or resurrects the others' archives.
- The mobile refresh path's local drop also accepts an explicit set of remap-restored ids (restore remap's title tier reconnects at a NEW url, so neither the id nor the url set covers those entries). The merge needs no mirror: its uncited-drop is already stricter, and remapped entries are uncited once markers are rewritten.
- The cap's eviction order is part of the lockstep contract: the archive merge takes a required isStillCited predicate in BOTH apps, and every capping path (normalize, merge, refresh, source removal) passes the real cited set. Uncited entries are only deprioritized at the cap, never dropped early — another device's unsynced answers may cite them. Normalize defers the conversation scan until the archive actually overflows (payloads written by current paths never do).
- The server's scheduled-refresh worker neither archives retired citations nor remaps markers; background refreshes are a known gap in evidence-name preservation, separate from the client cap rules.
