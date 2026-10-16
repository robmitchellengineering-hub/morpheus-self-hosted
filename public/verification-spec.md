# Valiant Verification — Specification

**Version 0.1 (draft).** This specification is published openly and may be implemented freely.
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

## 6. What is not covered

This specification covers the **verification discipline** — how a build earns the word "verified".
It does not cover model choice, pricing, or the reference implementation; those live in the product
and its commercial licence. Implementations are free to choose their own stack, so long as they
satisfy the contracts above.
