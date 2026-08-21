---
name: Drizzle correlated subqueries
description: A raw sql`(SELECT COUNT(*) ...)` correlated against the outer table silently returned wrong counts; use a second grouped query instead.
---

A correlated scalar subquery written with drizzle's sql template — `sql`(SELECT COUNT(*) FROM ${childTable} WHERE ${childTable.col} = ${parentTable.col})`` inside a `.select()` — executed without error but did not correlate: it counted ALL of the owner's child rows for every parent row.

**Why:** drizzle's rendering of column refs inside a raw subquery is not guaranteed to preserve outer-query correlation; the failure is silent (plausible numbers, no SQL error), so tests on exact counts are the only thing that catches it.

**How to apply:** for per-row aggregates, run a second query — `select({ id, count }) 
 ... where(inArray(child.parentId, ids)).groupBy(child.parentId)` — and join in JS. Assert exact aggregate values in integration tests rather than `>= 1` shapes.
