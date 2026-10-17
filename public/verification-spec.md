# Valiant Verification — Specification

**Version 0.2 (draft).** This specification is published openly and may be implemented freely.
Commercial licensing applies to the reference SDK and the guard/hazard corpus, not to this document.

Morpheus unlocks code verification. This document is the contract: what a toolchain must do for a
build to mean "verified", and what a conformance audit checks.

---

## 1. Purpose

Once generation became cheap, the scarce resource moved downstream — to whether you can trust what
was generated. Most tools optimise for demo velocity and leave verification optional. This
specification defines verification as a **structural gate** rather than a model's choice, so that a
green result means the checks actually ran.

## 2. The five principles

### 2.1 The gate is structural, not a choice

Required checks are matched **by name**. A check that was skipped, or that returned a neutral
result, is a **fail** — never a silent pass. There is no code path from "done" to "shipped" that
does not pass through the named gates.

### 2.2 Prove the check can fail

Every guard is **mutation-tested**: a seeded fault is injected, and the guard must go red. A guard
with no recorded failure proves nothing and does not count. This is the property that separates a
check that works from a check that is merely present.

### 2.3 The reviewer must not grade its own work

Review runs on a **different model** than the coder, against **its own evidence**, not the coder's
whole context. A same-model review grades its own work; that is not a review.

### 2.4 Failures become memory

Every self-inflicted breakage is filed with a **detection rule**, and the ledger is fed back to the
reviewer on every turn. An institutional memory that is never read is not memory.

### 2.5 Evidence carries provenance

Every result must name **who produced it**, **that it ran**, and **what would falsify it**. One
machine proposes; another disposes.

## 3. The named-gate contract

A build claims "verified" only when it presents, for each required gate:

- the **gate name**,
- the **result** (pass / fail),
- the **evidence** (the check's own output),
- the **producer** (who ran it), and
- the **falsifier** (what a failure would have looked like).

A gate that reports nothing is a fail. A gate that reports "pass" without evidence is a fail.

## 4. The mutation-test contract

A guard is **proven** when there is a recorded run in which:

- a **seeded fault** was injected into the thing the guard protects, and
- the guard **went red**.

A guard without such a record is **unproven**, is counted separately, and may not be added silently:
new unproven guards are refused (the ratchet), and the backlog is closed toward zero.

## 5. Certification

### 5.1 Conformance audit

A product earns the **Valiant Verification** mark by passing a conformance audit asserting all five
principles, with the guard and mutation-test contracts above. The audit is **version-scoped** and
**annual**; a lapsed audit or a "green when nothing ran" regression revokes the mark.

### 5.2 Badge scope

The displayed badge states its scope so a customer can check it, not just trust it:

> Valiant Verification Certified — `{product} v{version}` · audited `{date}` · `{N}` guards proven · `{M}` of `{M}` gates structural

## 6. The seed invariant library

The hazard corpus holds 26 documented breakages, each bought with a real incident and filed with a
detection rule. **22 of the 26 are universal** — they name a failure any agent toolchain will meet,
independent of language, stack, or product. They are restated here, without reference to any one
codebase, as the seed an implementation must cover. The other 4 are product-specific (a particular
data model's scoping, a build step that rewrites a particular file, a lockfile policy, and one
product's protected paths); they stay in the licensed corpus, not this open document.

1. **Contract integrity.** Adding an export is safe; removing or renaming one, or changing a return
   shape, must update every caller in the same change.
2. **Silent no-op edits are forbidden.** An edit that matches zero sites or more than one must be
   refused — never applied to the wrong site, never silently dropped.
3. **Bound the model's output.** A call that can produce long output sets an explicit budget; a
   truncated result is an error, not a silent cut.
4. **Schema ships with its migration.** A data-model change carries its migration in the same change;
   the two are never deployed apart.
5. **Sync against the live source of truth.** A push or sync diffs against the current remote, never a
   stale local snapshot; drift is refused, not overwritten.
6. **Verify before depending.** Never code against an external API's shape from memory; make one real
   request first.
7. **Schema drift degrades gracefully.** A column the code expects but the database lacks degrades to
   the old behaviour — it never takes the whole feature down.
8. **A module is not verified until it is loaded.** Syntax and lint do not resolve a specifier or boot
   the module; something must actually load it.
9. **A silent zero is a bug.** A query whose emptiness is indistinguishable from a real empty result is
   bounded and sampled against a known-good item.
10. **Never neutralise a build step.** No swallowed failure on an install or build; the artifact must
    run before it is called verified.
11. **Review behaviour, not just the export surface.** When a shared module changes, diff what it
    *does*; a vanished rationale comment is the signal a behaviour left with it.
12. **Data isolation is a decision, not a default.** A widened read is deliberate and explicit, and can
    never return another account's rows by accident.
13. **"Nothing failed" is not "the gates ran".** Gates are required by name, present and successful;
    skipped and neutral are fails.
14. **A declaration outlives its block.** A name read in a `catch`, `finally`, or after a `try` is
    declared outside that block.
15. **Prove the check can fail.** Break the subject and expect red; strip comments before matching
    source; assert behaviour, not spelling.
16. **Name the machines the output runs on.** One download per architecture; the filename is the fact
    a person can read.
17. **The verdict is the build's.** Nothing downstream overwrites the build's pass or fail; a save
    failure is its own state, never "build failed".
18. **Lint coverage, and render the real surface.** Every file matches a real rule set, and a
    user-visible change is verified by rendering it.
19. **A tool that rewrites the tree owns it.** Before overwriting a file, confirm what is on disk is
    what was left there; a concurrent edit is detected, never destroyed.
20. **Close stdin on spawned subprocesses.** A prompt must get EOF and fail fast, never hang the loop.
21. **Portable filenames.** "Legal here" is not "legal everywhere"; keep reserved characters and a
    trailing dot or space out of committed paths.
22. **The loop survives its own queue.** A worker tolerates an item that vanishes mid-iteration; one
    item's error must not kill the loop.

The five principles in §2 are the *shape* of verification; these 22 are the first *content* — the
failure modes a conforming implementation's guards must demonstrably catch. They grow only by real
incident, never by imagination, which is why each one above is numbered rather than described.

## 7. What is not covered

This specification covers the **verification discipline** — how a build earns the word "verified".
It does not cover model choice, pricing, or the reference implementation; those live in the product
and its commercial licence. Implementations are free to choose their own stack, so long as they
satisfy the contracts above.
