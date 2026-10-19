# Morpheus + Command Deck — Business/Financial Model Digest & Internal Inconsistency Audit

**Sources** (extracted text in `/tmp/morpheus-docs/txt/`), abbreviated throughout:

| Abbrev | File | Prepared |
|---|---|---|
| **BR-v6** | `MORPHEUS-BUSINESS-REPORT-v6.txt` | 31 Aug 2026 (rev. of 29 Aug) |
| **IO-v5** | `MORPHEUS-INVESTOR-OVERVIEW-v5.txt` | 31 Aug 2026 (rev. of 29 Aug) |
| **CP-v6** | `MORPHEUS-COMPETITIVE-POSITIONING-v6.txt` | 31 Aug 2026 (rev. of 30 Aug) |
| **EX-v4** | `MORPHEUS-EXPLAINER-v4.txt` | undated (in-product explainer) |
| **OPS** | `MORPHEUS-OPERATIONS-COST-PLAN.txt` | 31 Aug 2026 |
| **CD-BR** | `MORPHEUS-COMMAND-DECK-BUSINESS-REPORT.txt` | 31 Aug 2026 |
| **CD-INV** | `MORPHEUS-COMMAND-INVESTOR-REPORT.txt` | 31 Aug 2026 |
| **CD-OV** | `MORPHEUS-COMMAND-DECK-INVESTOR-OVERVIEW.txt` | 31 Aug 2026 |
| **CD-CP** | `MORPHEUS-COMMAND-DECK-COMPETITIVE-POSITIONING.txt` | 31 Aug 2026 |
| **CD-EX** | `MORPHEUS-COMMAND-DECK-EXPLAINER.txt` | undated (in-product explainer) |
| **FIN** | `MORPHEUS-COMMAND-INTERNAL-FINANCIAL-REPORT.txt` | 31 Aug 2026 ("master financial doc") |
| **STRAT** | `MORPHEUS-COMMAND-DECK-COMBINED-STRATEGY.txt` | 31 Aug 2026 |
| **GTM** | `MORPHEUS-COMMAND-GO-TO-MARKET-STRATEGY.txt` | 31 Aug 2026 |

Reported below is **only what the documents say**. No independent financial model has been added; arithmetic checks are noted solely where two documents state figures that cannot both be true.

---

## PART 1 — The model

### 1.1 What a user pays (denominations)

| Path | What the user pays | Denomination | Source |
|---|---|---|---|
| Default (pay-as-you-go) | Per action: 1 credit = $0.005; 1,000 credits = $5 retail (reference rate; "not yet finalized into specific block sizes") | Stripe one-off credit/token blocks | BR-v6 |
| Default — realistic active user | $38.55/yr (own-GitHub compile) → $40.35/yr (all Priority Compile); ~$3.21–3.36/mo | as above | BR-v6, CP-v6, FIN |
| Guided Free Setup | $0 — user's own free Gemini API key, "user's own quota, not shared" | n/a | BR-v6, IO-v5, OPS |
| Full BYOK | $0 to Morpheus — "existing Custom mode, unchanged" | n/a | BR-v6 |
| Free subscription tier | **Removed** — "Free 200 credits/mo and Pro $15/mo, 5,000 credits tiers from the prior version are removed" | — | BR-v6 |
| Signup bonus | "includes 200 free signup credits — recouped via first purchase" | one-time credits | FIN, OPS (but see **I-1**, **I-8**) |
| Command Deck (same user) | $21.16/yr retail (2× of $10.58) | same shared token pool | CD-BR, CD-EX |
| Priority Compile | "2× cost"; light ~$0.004/run → medium ~$0.02 → heavy ~$0.04–0.06 → very heavy ~$0.10–0.20 → Mac-only ~$0.10–0.40 | credits | BR-v6 |
| Marketplace | Buyer pays (grossed up for Stripe); platform keeps 20%, seller 80% | Stripe Connect destination charge | BR-v6, FIN, CD-BR |
| Combined (Morpheus + Command Deck) | "$29.68/yr cost / $59.72/yr retail — just under $5/month" | — | FIN, CD-BR, STRAT |
| Removed-line items (illustrative only) | White-label $5/mo; storage overage $0.10/GB; team seats $10/seat | — | BR-v6 §06 |

### 1.2 Per-user cost

| Cost | Value | Basis |
|---|---|---|
| Morpheus active user AI cost | **$1.591/mo = $19.10/yr** | 120 code turns × $0.0130 + 14 chats × $0.0010 + 3 diagnoses × $0.0074 (BR-v6) |
| Morpheus all-Priority variant | **$1.681/mo = $20.18/yr** | same profile, 3 Priority compiles at $0.03/mo (BR-v6, FIN) |
| Command Deck active user AI cost | **$0.882/mo = $10.58/yr** | 6 actions; line items sum to $0.882 exactly (CD-BR, FIN) |
| Same user on both | **$29.68/yr cost** | $19.10 + $10.58 (CD-BR, FIN) |
| Guided-Gemini free user | $0.030–0.040/mo ($0.36–0.48/yr) at 1,000 users → ~$0.002–0.003/mo (~$0.02–0.03/yr) at 1M users" | BR-v6 §04 |
| Infrastructure | "roughly flat $30–40/mo → low thousands at 1M users" | OPS, FIN |
| Priority Compile compute | "$0.002–0.20/run, billed 2×" | OPS, BR-v6 |
| Banking connector (Plaid) | "~$0.30–3/account/mo cost, billed at 2× markup" | OPS, FIN |
| Error monitoring | "~$26–80/mo depending on scale" | OPS, FIN |
| Product analytics | "$0 at low scale, scaling thereafter" | OPS, FIN |
| SMTP | "$0 — deferred" to Browser Automation Agent | OPS, FIN |
| Apple Developer Program | "$0 — not needed" (user's own account) | OPS, FIN |
| Domain morpheus.nz | "$16/year" | OPS, FIN |
| Stripe | "~2.9% + $0.30/transaction, grossed up into checkout price" | OPS, FIN |
| 200 free signup credits | "~$0.25–0.35 one-time cost per new account" | OPS, FIN |
| Fixed floor | ~$86/mo (1k) · ~$176 (10k) · ~$701 (100k) · ~$4,001 (1M) | OPS |

### 1.3 Margin

| Claim | Source | Value |
|---|---|---|
| AI token usage markup | BR-v6, IO-v5, CD-BR, CD-INV, STRAT, FIN, CD-OV, CD-CP | "flat 2× markup" |
| Usage-markup gross margin % | IO-v5, CD-BR | "50% — structural, not promotional" |
| Per-action margin (BR-v6 table) | BR-v6, FIN | "1.7×–5× depending on action"; table shows 5.0× (chat no code), 3.1× (chat w/ code), 3.3× (autonomous), 4.1× (diagnose), 3.0× (backend plan), 4.5× (backend generate), 4.7× (test gen), 4.7× (native prototype), "pure margin" (compile own GitHub), 2.0× (Priority) |
| Marketplace | BR-v6, FIN, CD-BR, CD-OV, CD-INV, STRAT | 80/20 split; "20% commission, zero AI cost attached" |
| Profit = underlying spend | BR-v6 | "profit equals underlying spend, dollar for dollar" |

### 1.4 Revenue/profit by user count

| Users | Morpheus AI+compile profit/yr | Morpheus all-Priority y-cost | Command Deck profit/yr | Combined 25% adopt | Combined 100% adopt | Sources |
|---|---|---|---|---|---|---|
| 1,000 | $19,457 | $20,180 | $10,581 | $22,102 | $30,038 | BR-v6, IO-v5, CD-BR, CD-INV, FIN |
| 10,000 | $194,568 (BR-v6) / $194,570 (IO-v5, CD-INV, FIN) | $201,800 | $105,811 | $221,022 | $300,380 | as left |
| 100,000 | $1.95M | $2.02M | $1.06M | $2.21M | $3.00M | as left |
| 1,000,000 | $19.46M | $20.18M | $10.58M | $22.10M | $30.04M | as left |
| IO-v5 revenue line | 10k: $385,570 · 100k: $3.86M · 1M: $38.56M | — | — | — | — | IO-v5 |

### 1.5 Key assumptions behind the numbers

| Assumption | Stated basis |
|---|---|
| DeepSeek V4 Pro blended rate $0.80/M input, $2.40/M output | "verified", "re-checked against multiple independent sources dated 26–29 August 2026" (BR-v6) |
| Active-user profile: 120 code-producing turns, 14 no-code chats, 3 diagnoses, 3 compiles/month | "Recalibrated this pass to a realistic average paying customer" — quantified usage profile is itself **assumed** (OPS calls all such profiles "a stated assumption, not measured data") |
| Command Deck profile: 55 check-ins, 22 deep syntheses, 55 proactive insights, 4 widget builds, 75 connector refreshes, 6 specialist consults/mo | "Qty/month (ASSUMED)" — the column is literally titled ASSUMED (CD-BR, FIN) |
| Command Deck connector refresh = "5–7 connected sources refreshed ~10–15×/month each" | assumption, replaces "original light-usage estimate" |
| Combined user "lands just under $5/month" | "deliberately calibrated to that target" (BR-v6, CD-BR) — a target, not a measurement |
| Cross-adoption 25% / 100% | "Real cross-adoption between the two products is unmeasured — no telemetry exists yet" (CD-INV, FIN) |
| Marketplace commission forecasts ($1,600/$16,000 etc.) | "Adoption assumptions are guesses, not measured data" (BR-v6 §06) |
| White-label / storage / team seats | "illustrative only… unchanged from the prior version" |
| Fixed floor / break-even table | "Illustrative, not a forecast — real conversion rates and per-action net revenue need actual telemetry" (OPS) |
| Infrastructure $30–40/mo → low thousands | "Modeled"; "that scaling curve was estimated before anyone knew what fraction of users would be free-and-unmonetized" (OPS) |
| Competitor prices ($480–$2,508/yr app builders; $8–49/mo assistants) | "sourced from published pricing pages and independent pricing guides, checked against multiple sources" (CP-v6, CD-CP) |
| Morpheus figures "not live production billing" | CP-v6, CD-CP closing notes |

---

## PART 2 — VERIFIED vs ASSUMED, per number

### VERIFIED (document asserts measurement or traceability to real/decided data)

| Number | Document's own wording | Source |
|---|---|---|
| $0.80/M in, $2.40/M out DeepSeek rate | "priced at the verified DeepSeek V4 Pro blended rate"; "re-checked against multiple independent sources dated 26–29 August 2026" | BR-v6, CD-BR, FIN |
| $1.591/mo / $19.10/yr per active user | "the new verified figure is $1.591/mo ($19.10/yr)"; "$1.591/mo — verified, shown working" | BR-v6 |
| The 120/14/3/3 usage profile that produces it | Same paragraph: "Revised again this pass: … the new verified figure" (profile is assumed, figure labelled verified — see **I-10**) | BR-v6 |
| $19.10–20.18/yr Morpheus active-user cost | Presented as recapped "verified per-action cost" | FIN |
| $10.58/yr Command Deck active-user cost | "the recalibrated $10.58/year profit-per-active-user figure"; "same methodology, same verified DeepSeek rate" | CD-BR, FIN |
| Competitor prices ($480–$2,508/yr; $96–588/yr; $8–49/mo; Motion ~$60M Series C; Reclaim $40.2M; Rewind $350M) | "All prices verified against multiple independent sources, checked August 2026"; "real data from the two closest comparable companies" | CP-v6, CD-CP, CD-INV, GTM |
| Lovable $500M ARR / 8M users / 19 months; Base44 $80M / 400K / 6 months; Lovable $6.6B valuation, 8M+ users | "RESEARCHED"; "not theory, their real numbers" | GTM, CP-v6 |
| 2× markup / 80-20 split / Priority Compile / Google-only sign-in / Stripe gross-up / $16 domain / $0 SMTP / $0 Apple | Status column reads "Resolved 2026-08-31", "Decided", "Known" | OPS, FIN, BR-v6 §05 |
| "$0 margin compression… the 2× markup assumption holds exactly as designed" | Resolved by decision | OPS |

### ASSUMED (documents say modelled/estimated/illustrative/guess/unmeasured)

| Number | Document's own wording | Source |
|---|---|---|
| 120 code turns / 14 chats / 3 diagnoses / 3 compiles per month | "scaled up… to reflect a realistic average paying customer"; OPS: "**Every usage profile in this report (40 turns/month …) is still a stated assumption, not measured data**" | BR-v6, OPS |
| $0.532/mo prior estimate; $0.126/mo prior estimate | Both described as superseded estimates (the second "unreconcilable") | BR-v6 |
| Command Deck QTY/MO column (55/22/55/4/75/6) | Column header "**(ASSUMED)**" | CD-BR, FIN |
| $10.58/yr Command Deck **profit** | Derived from the assumed quantities (cost is verified-rate × assumed volume) | CD-BR |
| Combined $29.68 cost / $59.72 retail / "just under $5/month" | "deliberately calibrated to that target" | CD-BR, FIN |
| 25% / 100% cross-adoption scenarios | "unmeasured — no telemetry exists yet… bound the range, not predict it" | CD-INV, FIN |
| Marketplace/white-label/storage/team-seat revenue | "Adoption assumptions are guesses, not measured data — shown to illustrate… not to be treated as forecast" | BR-v6 §06 |
| $86–$4,001/mo fixed floor and the break-even action counts | "Illustrative, not a forecast" | OPS |
| Infra $30–40/mo → low thousands; ~$26–80/mo monitoring; $0.30–3/account Plaid | "Modeled" | OPS, FIN |
| ~$0.25–0.35 one-time cost per 200-credit signup | Modelled estimate; "rounding error against the fixed costs" | OPS, FIN |
| Storage-growth risk / user-choice cloud storage fix | "no real telemetry yet"; fix "on the feature backlog, not yet built" | OPS |
| DeepSeek provider-balance float | "Planned, not yet built" | OPS, FIN |
| Priority Compile revenue | "not yet forecast pending real adoption data"; excluded from all scaling tables | CD-BR, FIN, CD-INV |
| All headline profit figures ($19,457 … $30.04M) | Rest on the calibrated/assumed usage profile and the assumed 2× markup; the docs call the profile "verified" but GTM/FIN concede no telemetry | BR-v6 vs OPS |

---

## PART 3 — INTERNAL INCONSISTENCIES

Ordered roughly by materiality. Each entry quotes both (or all) versions and names the files.

### I-1. "No free tier" vs a free tier that still exists (three different states) — **most material**

- **BR-v6**: "The prior version modeled a Free/Pro/BYOK tier structure. That's superseded — **no free tier, no subscription**, pure pay-as-you-go."
- **BR-v6 §05**: "Free-tier sizing | 200 credits/mo, a guess | **Moot — no free tier exists**"; "Free 200 credits/mo and Pro $15/mo, 5,000 credits tiers from the prior version are **removed**."
- **CP-v6**: "The finalized model has **no free tier** and no subscription."
- **FIN**: "No free tier, no subscription. Default (pay-as-you-go, cheap frontier model, **includes 200 free signup credits** — recouped via first purchase)."
- **OPS**: "**200 free signup credits** don't change this floor — at ~$0.25–0.35 per new account…"
- **EX-v4**: "You start with **200 free credits immediately** — no setup at all — enough to plan, build, and compile a real first app." / "What your first 200 credits actually cover"
- **CD-EX**: "You start with **200 free credits immediately, no setup required**."
- **GTM**: "GENUINELY FREE PATH … **no card, no trial limit**"; "a stronger free story than any competitor in the space."

A free credit grant is simultaneously (a) declared non-existent, (b) 200 one-time signup credits, and (c) in GTM, unlimited ("no trial limit"). The removed item was "200 credits/**mo**"; what remains is 200 **one-time** — six documents do not agree on whether it exists at all.

### I-2. Cost per active user: "<$1/mo" vs $1.591/mo vs $2.47/mo

- **IO-v5**: "COST PER ACTIVE USER **<$1/mo** — even including compile"; "the free path costs me nothing… everyone else is paying for real usage from message one."
- **BR-v6 / OPS / FIN**: Morpheus active user is "**$1.591/mo** ($19.10/yr) in AI cost", rising to **$1.681/mo** on all-Priority — already above $1 before any compile; **OPS** table lists "$1.591/mo per active paid user".
- **CD-BR / FIN**: a user on **both** products costs "$29.68/yr cost" = **$2.47/mo** — roughly 2.5× the investor-facing claim. "Even including compile" does not reconcile $1.591–1.681 to <$1.

### I-3. Command Deck's unit economics stated two contradictory ways in the same family of docs

- **CD-BR / FIN (per-user)**: Command Deck active user = "$0.882/mo … $10.58/yr cost, $21.16/yr retail, $10.58/yr profit."
- **STRAT**: "Since Command Deck adds no new AI pipeline, billing system, or marketplace, its incremental cost to Morpheus is close to whatever AI usage its users actually generate — already priced at the same verified **$1.591/mo ($19.10/yr) per active-user rate as core Morpheus**."
- $0.882/mo vs $1.591/mo for the same actor: a **1.8× discrepancy**. CD-BR's own line items sum to $0.882 (verified), so STRAT's "$1.591/mo for Command Deck" conflicts with the Command Deck report it claims to combine.

### I-4. Priority Compile cost basis: $0.01/run vs $0.03–0.05/run (and a "pure margin" carve-out)

- **BR-v6 §04**: "Compile, Priority instead (3 runs) | **$0.09/mo** | $0.18/mo ($2.16/yr)" → implies $0.03/run cost = 3 × $0.01.
- **BR-v6 §03 / OPS**: "Heavy android-apk, linux-distro … **~$0.02–0.03**" cost/run; "Medium … ~$0.01"; OPS: "$0.002–0.20/run, billed 2×".
- A 3-run month using the §03 tiers (e.g. one heavy = $0.02–0.03) costs $0.03–0.05, making the annual all-Priority delta **$1.80–4.80**, not the stated **$1.08** ("$20.18/yr All Priority vs $19.10/yr own-GitHub"). The report's own tier table contradicts its own active-user table.
- Separately, **BR-v6** says of own-GitHub compile: "Compile (own GitHub) | — | $0.00 | 2 credits | $0.01 **pure margin**", while **FIN** still amortises compile into the annual figure: own-GitHub annual cost "**$19.10**" vs all-Priority "$20.18" — i.e. the "pure margin / $0.00" line is not $0.00 in the roll-up.

### I-5. Profit figures that don't match between documents at the same user count

| Users | BR-v6 | IO-v5 / CD-INV / FIN | Note |
|---|---|---|---|
| 1,000 | **$19,457** | $19,457 (IO-v5, CD-INV), $19,457 (FIN) | agree |
| 10,000 | **$194,568** | **$194,570** (IO-v5, CD-INV, FIN) | $2 gap |
| 100,000 | **$1.95M** | **$3.86M revenue / $1.95M profit** (IO-v5) | agree at 1dp |
| 1,000,000 | **$19.46M** | $19.46M | agree |

BR-v6 wins the 10,000-user figure at **$194,568** ("10,000 USERS $194,568 profit / year") while IO-v5, CD-INV and FIN all say **$194,570**. The per-user derivations also disagree: BR-v6's own tiers imply **$19.457 / $19.4568 / $19.5 / $19.46** per user across 1k/10k/100k/1M — i.e. not one consistent per-user profit; the 100,000 tier is stated as $1.95M (=$19.50/user) while the 1M tier is $19.46/user.

### I-6. Cheaper-than-competitor multiples: 12–65× vs 8–42× vs the documents' own figures (4.5–28×)

- **BR-v6**: "Combined with Command Deck, a user running both lands at just under $60/yr ($5/mo) total — still **12–65× cheaper** than the cheapest single-domain competitor."
- **CP-v6**: "Morpheus — pay as you go … still **12–65× cheaper** than the cheapest competitor."
- **CD-BR**: "Still **8–42× cheaper** than any single-domain competitor."
- **CD-CP**: "COMMAND DECK $0–21/yr … GAP **4.5–28×** cheaper, for strictly more."
- The underlying prices are identical ($0–21.16/yr vs $96–588/yr ⇒ **4.5–27.8×**; $0–40.35/yr vs $480–$2,508/yr ⇒ **11.9–62×**). CD-BR's "8–42×" matches neither its own stated prices nor CD-CP's "4.5–28×". CP-v6's "12–65×" is also applied in **BR-v6** to a *combined two-product* total ($59.72/yr) rather than Morpheus alone, and 65× only appears if the 1M-user-baseline framing is ignored.

### I-7. Per-action token counts that contradict each other

- **BR-v6 §02**: "Chat, code produced | **10,500 / 1,900**" — "input tokens accumulate across a chained planner→coder→reviewer call."
- **CD-BR**: "Widget build (full Morpheus pipeline) | **10,500 / 1,900** | $0.0130", with the note: "'Widget build' reuses the exact same cost as Morpheus's 'Chat, code produced' action (**10,500/1,900 tokens**) since it's literally the same planner→coder→reviewer pipeline."
- **BR-v6 §04**: "Active user … = ~**120 build turns**, 14 light chats, 3 diagnoses, 3 compiles/month." The only "chat, code produced" action (10,500/1,900) is therefore the 120 build turns — but BR-v6 §02 also prices a separate "**Autonomous step | 10,000 / 1,700**", and the §01 marketing line says "**10,500 / 1,900**" for the full pipeline. The same pipeline is priced at both 10,500/1,900 (chat-with-code and widget build) and 10,000/1,700 (autonomous step), with "Chat, code produced" and "Autonomous step" carrying different margins (3.1× vs 3.3×).

### I-8. Value of the 200 signup credits: ~$0.25–0.35 one-time vs $1.00 (and "enough to build a full app")

- **OPS / FIN**: "200 free signup credits… **~$0.25–0.35 one-time cost per new account**."
- **BR-v6 exchange rate**: "1,000 credits = $5 retail (**$0.005/credit**)" ⇒ 200 credits = **$1.00 retail**. At the platform cost basis, the credits' cost is materially above the $0.25–0.35 the Operations plan books for them.
- **EX-v4**: "What your first 200 credits actually cover — … a handful of clarifying chats, **15 real build turns**, a couple of auto-fixes, a backend plan and generate, some test generation, and **3 compiles**." At BR-v6's published credit prices that basket is **~169 credits ($0.845)** — and at BR-v6's *own* usage profile of **120 build turns**/month the 200 credits are exhausted in well under a month, contradicting "enough to plan, build, and compile a real first app" as a durable story and contradicting GTM's "no trial limit".

### I-9. Operating-source version drift: the "master" document is built on the superseded report

- **FIN**: "SOURCE | **MORPHEUS-BUSINESS-REPORT-V5** · COMMAND-DECK-BUSINESS-REPORT · OPERATIONS-COST-PLAN" — but the report it recaps and quotes ("120 code-producing turns… $1.591") is **v6**.
- **STRAT**: "COMBINES | **MORPHEUS-BUSINESS-REPORT-V5** · COMMAND-DECK-BUSINESS-REPORT".
- **BR-v6** states the v5-era per-user figure was "**$0.126/mo (unreconcilable)**" and before that "$0.532/mo". A document whose declared source is the superseded v5 cannot be the authoritative "master financial doc", and both combined documents inherit whichever figures were current at merge time — visible in I-5 and I-3.

### I-10. Same figure labelled VERIFIED and ASSUMED

- **BR-v6**: "the new **verified** figure is $1.591/mo ($19.10/yr) … calibrated so a user running both Morpheus and Command Deck lands at just under $5/month"; decisions table: "AI cost per active user … **$1.591/mo — verified, shown working**."
- **OPS**: same document-family usage profile — "**Every usage profile in this report (40 turns/month**, storage-per-project, etc.) is still a **stated assumption, not measured data**."
  - Note the numeric conflict inside that same sentence: OPS says **40 turns/month**; BR-v6/FIN say "**~120 build turns**" (a 3× difference in the profile behind the $1.591/$19.10 figure).
- **OPS** also books the $1.591 up front as "**Modeled**" ("$1.591/mo per active paid user | **Modeled**") while BR-v6's status column calls the same number verified.

### I-11. Free-user / storage protection status contradictory

- **OPS**: "Every registered user — free or paid — creates projects, stores code, and accumulates chat history in Morpheus's own database. **This does scale with total headcount** regardless of payment status, and **it isn't separately itemized anywhere in current planning**"; the storage table row reads "no real telemetry yet | **Real fix on backlog**"; "If storage costs turn out to scale faster than the current infra estimate assumes… the fixed floor itself needs revisiting upward."
- **FIN** (same date, "master" document): "Database/storage growth | Total registered users | **Protected — user-choice cloud storage (Drive) covers both products' data**"; "**Both major free-tier risks are closed**"; and OPS's open risk is downgraded to an open *question*: "Command Deck connector API costs | Depends on which third-party services get built first."
- **CD-BR** goes further: "Command Deck doesn't introduce a second version of the storage risk; **it's the reason a fix exists at all**" — while OPS says the fix is "**now on the feature backlog, not yet built**". "Closed" vs "on the backlog, not yet built" are not compatible statuses.
- Same tension for connector costs: **CD-BR** calls third-party connector API calls "**The one genuinely new cost line**" not yet itemized; **FIN** already prices banking connectors at "~$0.30–3/account/mo cost, billed at 2× markup."
- Free-tier cost: **FIN** headline says "FREE-TIER COST TO MORPHEUS **~$0** — both products, structurally protected"; **BR-v6** prices the same thing at "$0.030–0.040" per user/month at 1,000 users, and **OPS** adds the unquantified storage headroom. "~$0" is only true at 1M-user scale (~$0.002–0.003/mo).

### I-12. Infrastructure vs fixed floor arithmetic (same document)

- **OPS** table: fixed floor ~$86/mo at 1,000 users, ~$176/mo at 10,000, ~$701 at 100,000, ~$4,001 at 1,000,000.
- **OPS/FIN**: infrastructure is "roughly flat **$30–40/mo**" at 1,000 users and "**low thousands**" at 1M; monitoring is "**~$26–80/mo depending on scale**".
- From 1,000 → 10,000 users the infra line goes $30–40 → $30–60 (per BR-v6 §04) yet the fixed floor approximately **doubles** ($86 → $176); from 100,000 → 1,000,000 the infrastructure estimate rises only to "low thousands" while the floor is stated at **~$4,001/mo** — above the "low thousands" band combined with the stated monitoring ceiling. The tiers are not reconcilable with the stated cost lines.
- Footer reconciliation also fails: "removing SMTP and Apple Developer Program costs lowers the fixed floor at every tier versus the previous version (was $109–4,209/mo across tiers, **now $86–4,001/mo**)". Removing Apple ($99/yr = **$8.25/mo**) and SMTP (stated cost "$0") accounts for ~$8/mo, not the stated **$23/mo** at the low tier or **$208/mo** at the top tier.

### I-13. "-" vs "+" additive treatment of Priority Compile revenue

- **BR-v6 §04 / §06**: "Compile, Priority instead (3 runs) … $0.18/mo ($2.16/yr)" is inside the per-user roll-up, and §06 reads "Priority Compile | DECIDED | see page 4 — **real pricing, not illustrative** | **—** | **—**" (i.e. already counted, nothing extra in the revenue table).
- **CD-INV**: "Both scenarios are AI-usage profit only — marketplace commission from either product **and Priority Compile revenue stack on top**, untouched by these figures."
- **FIN**: "Neither scenario includes marketplace commission… **or Priority Compile revenue — both are additive on top of these figures**" — yet the "Morpheus's own verified AI+compile profit line" ($19.46M/$30.04M combined) is the all-Priority figure.
- Priority Compile revenue cannot be simultaneously *inside* the $19.10–20.18/yr per-user profit line (BR-v6/FIN per-user tables) and *untouched/additive* on top of it (CD-INV/FIN scaling tables). The same set of numbers also appears as "Morpheus-only baseline; Command Deck adds on top" in **STRAT**, which contradicts **CD-BR**'s own ceiling statement that Morpheus + Command Deck ≈ "$30.04M/yr combined".

### I-14. Conflicting "verified" per-user profit bases for Command Deck's own scaling table

- **CD-BR** scaling table: 1,000 → annual revenue **$21,160**, cost **$10,580**, profit **$10,581**; 10,000 → revenue **$211,600**, cost **$105,800**, profit **$105,811**.
- **FIN** same scenario: 10,000 → Command Deck contribution **$105,810** (25% scenario) and **$105,810** (ceiling scenario), i.e. `$21,160 × 0.25 = $5,290` in one place / `$10.58 × 1,000 = $10,580` in another.
- **CD-INV**: "10,000 USERS $105,811 profit/yr."
- Profit at 10,000 users is stated as **$105,811** (CD-BR, CD-INV) and **$105,810** (FIN, twice); at 1,000 users CD-BR states both "$10,581 profit/yr" and a cost of "$10,580" for the same 1,000 users. Each row is a dollar-adrift rounding of a different rounding rule.

### I-15. Prior-version cost figures that the prior documents don't contain

- **BR-v6** describes the superseded v5 figures twice, with two different values: "$0.126/mo" ("**couldn't be reconstructed** from the platform's own per-action pricing or the stated DeepSeek rate") and "$0.532/mo" ("up from the earlier $0.532/mo estimate").
- **BR-v6** also cites a light-usage Morpheus estimate of "the earlier **$13–15/yr** light-usage estimate" and "around $38–40/yr for a realistic active user (up from the earlier $13–15/yr)".
- **CP-v6** cites the superseded figure too: "usage profile scaled up… (was a light-usage estimate)", and the prior report's Morpheus number was "the prior version's flat '**$0/yr**'".
- Neither $0.126/mo, $0.532/mo nor $13–15/yr appears anywhere in IO-v5 or OPS — the documents describe three mutually inconsistent "prior" baselines for their own predecessor, which is how the v5→v6 drift becomes untraceable.

### I-16. Commission on Command Deck: additive line vs "stacks on top" vs excluded from the "master" doc

- **FIN** revenue table lists "Command Deck marketplace commission" as a live revenue line and says commission from either product is excluded from the scenarios as "additive upside, not forecast."
- **FIN** "What's still open": "Marketplace commission forecast, either product | **No real adoption/pricing data yet** — both treated as additive upside, not forecast."
- **CD-BR / CD-INV / STRAT**: Command Deck marketplace commission is presented as a second, already-built revenue line with "20% commission, zero AI cost attached" (CD-BR §05).
- **BR-v6 §06** nevertheless puts a number on marketplace revenue from the Morpheus side ("~$1,600 at 10K users") while calling it illustrative — so the same commission is unpriced-as-too-uncertain in one doc and quantified in another.

### I-17. Assistant-category willingness-to-pay range stated differently

- **CD-CP**: "The category has already proven willing to pay **$8–49/month** for one domain."
- **CD-OV**: "The category has proven willing to pay **$10–50/month** for a single-domain tool."
- Same two documents also disagree on Reclaim.ai's annual range: **CD-CP** "$8–15 | $96–180"; **CD-EX** "$96–264". (CD-CP's own $8–15/mo cannot produce a $264/yr top end.)

### I-18. Stripe gross-up worked example doesn't equal the stated formula

- **OPS / FIN**: "Formula: charge = (intended_net + 0.30) / (**1 − 0.029**)" and "A $5 token block is charged as **$5.46** (Stripe takes **$0.46**, Morpheus nets the full $5.00)."
- Applying the stated fee ("~2.9% + $0.30/transaction", OPS) to $5.46 yields a Stripe take of **~$0.4585** and a net of **~$5.0017**; $5.46 − $5.00 = $0.46 is only reached by rounding the fee to $0.46. Minor, but the worked example and formula are quoted as exact in two documents.
- Relatedly, **OPS/FIN** claim the gross-up means "No margin compression to plan for; the 2× markup assumption holds **exactly** as designed", while **FIN** still lists "Exact Stripe gross-up implementation" as open ("needs live calculation against Stripe's real fee schedule at checkout time, not hardcoded — fee can vary slightly by card type/region").

### I-19. Morpheus retail total stated three ways

- **BR-v6 / CP-v6**: "$38.55–40.35/yr" (and "$3.21–3.36/mo" in CP-v6).
- **EX-v4**: "MORPHEUS, TO START | **$0–40/yr**"; "Morpheus — pay-as-you-go | **$38.55–40.35**".
- **STRAT**: "a fraction of what Morpheus ships **free-to-$40/yr**".
- **BR-v6 §04**: "Morpheus alone now retails around **$38–40/yr**".
- The "$0" end is the BYOK/Guided-Gemini path, not the pay-as-you-go path, but EX-v4/STRAT/BR-v6 present "$0–40" as one Morpheus range against competitors' paid tiers, while CP-v6's table separates them ($0 vs $38.55–40.35) — the comparison basis differs between documents.

### I-20. Combined "just under $60/yr" vs the components' arithmetic

- **CD-BR**: "$19.10/yr (Morpheus active-user…) + $10.58/yr (Command Deck active-user) = **$29.68/yr cost, $59.72/yr retail** — just under $5/month combined."
- **FIN**: same "$29.68/yr cost / $59.72/yr retail".
- $59.72 − $38.55 (Morpheus own-GitHub retail) = **$21.17**, but Command Deck's retail is stated as **$21.16**; using the Priority top end ($40.35) the remainder is **$19.37**, i.e. *less* than Command Deck's stated $21.16. The three figures ($59.72, $38.55–40.35, $21.16) are mutually inconsistent by 1–179 cents, and **IO-v5** additionally rounds the pair to "just under $60/yr ($5/mo)" while **IO-v5**'s own revenue table uses $38.56M at 1M users (=$38.56/user, a third Morpheus retail basis).
- **IO-v5** table check: 10,000 users → $385,570 revenue − $191,000 cost (BR-v6 basis) = $194,570, but $38.55 × 10,000 = $385,500 — a **$70** difference from its own stated per-user retail.

### I-21. INFRA / free-user cost table is internally arithmetically inconsistent at the top tier

- **BR-v6 §04**: at 1,000,000 users "TOTAL INFRA/MO | **low thousands**" → "COST PER FREE USER/MO | **~$0.002–0.003**".
- "low thousands" (say $2,000–9,000/mo) over 1,000,000 users is **$0.002–0.009** per user/month, but the row states ~$0.002–0.003, which corresponds to $2,000–3,000/mo — i.e. the stated per-user figure pins the infra number to the bottom of the "low thousands" band. **FIN** repeats "roughly flat $30–40/mo → **low thousands at 1M users**".
- The free-user cost row at 10,000 users ($30–60/mo, $0.003–0.006/user/mo) implies the infra cost *falls* from $30–40 to $30–60 while per-user cost collapses 10×; the 1,000-user cost ($0.030–0.040 on $30–40/mo) is consistent only with ~1,000 users, so the table silently switches between "free users = all users" and "free users = a subset" between tiers.

### I-22. "Three cost lines" vs the itemized cost stack

- **BR-v6 §01**: "Morpheus runs on **three cost lines — infrastructure, LLM spend, and Priority Compile compute**."
- **OPS §01 / FIN §05**: itemized lines include Stripe fees, domain ($16/yr), error monitoring, product analytics, banking connectors (Plaid), SMTP ("$0"), Apple Developer ("$0"), 200-signup-credit cost, database/storage growth, and web-search/research — i.e. at least ten lines, several of which are real cash costs.
- **BR-v6 §04** concedes the point but does not fix the summary: "Not the full 'cost of running Morpheus' — real operating cost also includes Stripe fees, domain/hosting line items not itemized here, and SMTP once configured."

### I-23. Fixed-floor break-even contradicts the headline profit at 1,000 users

- **OPS §03**: at 1,000 total users the fixed floor is "**~$86**" /mo (≈$1,032/yr) and the table says covering it needs "~4,300 actions" = "**430% — still needs real average paid engagement at this scale**."
- **BR-v6 / IO-v5 / CD-INV / FIN**: at 1,000 users Morpheus "profit / year" is **$19,457** (AI + compile markup only) — i.e. the headline profit figure is presented on the same slide set as a fixed floor that the documents say is not covered at that scale. Both documents label the 1,000-user number "profit", but only OPS treats the ~$1,032/yr fixed floor as a deduction; the headline tables deduct no infra, monitoring, domain, analytics or Stripe cost.

### I-24. Compile on the platform cost table vs the Priority table (same document)

- **BR-v6 §02** table: "Compile (own GitHub) | — | **$0.00** | 2 credits | $0.01 | pure margin"; "Compile (Priority) | NEW — | **$0.002–0.20** varies by target | 2× cost | 2.0×."
- **BR-v6 §04** table charges the same own-GitHub compile at "$0.00/mo" but then totals the year at "$38.55" against AI tokens of "$38.19/yr" — a **$0.36/yr** compile charge, i.e. the compile line is $0.00 in the per-action table and $0.36/yr in the annual table (FIN likewise rolls own-GitHub into the $19.10 vs $20.18 comparison). The phrase "pure margin" is applied to a line that is charged, not free.

### I-25. Prior-report decision log vs current state for two "closed" decisions

- **BR-v6 §05**: "Pre-call vs. post-call billing | open | **Pre-call reserve + reconcile**" and "Owner fee exemption | hardcoded constant vs. column | **Real role column** (ties to Admin Panel)."
- **CP-v6**: "billing **reserves the estimated cost before the call runs** — so a user is blocked or informed before overspending."
- **FIN** "What's still open": "**Exact Stripe gross-up implementation** … needs live calculation against Stripe's real fee schedule at checkout time" and "**Transactional email timing** … Deferred to the Browser Automation Agent (backlog #3) — **no receipts/notifications exist until that ships**", while **OPS** lists SMTP as "$0 planned — decided 2026-08-31". OPS also calls email-via-browser "**a real dependency to track, not a guarantee**" — the same decision is "Decided/Resolved" in FIN's status column and "not a guarantee" in OPS's recommendations.

### I-26. Smaller cross-document drifts (each individually minor, collectively showing an un-reconciled set)

| Figure | Version A | Version B |
|---|---|---|
| Morpheus 10k-user profit | $194,568 — BR-v6 | $194,570 — IO-v5, CD-INV, FIN |
| Command Deck 10k-user profit | $105,811 — CD-BR, CD-INV | $105,810 — FIN (×2) |
| Command Deck 1k: profit vs cost | "$10,581 profit/yr" — CD-BR §03 | "$10,580" cost for the same 1,000 — CD-BR §03 table |
| Assistant WTP range | "$8–49/month" — CD-CP | "$10–50/month" — CD-OV |
| Reclaim.ai annual | "$96–180" — CD-CP | "$96–264" — CD-EX |
| Command Deck annual retail | "$21.16" — CD-BR/FIN | "~$21" — CD-EX, CD-CP |
| Morpheus annual retail | "$38.55–40.35" — BR-v6/CP-v6 | "$0–40/yr" — EX-v4; "$38–40/yr" — BR-v6 §04 |
| Usage profile | "120 build turns" — BR-v6/FIN | "40 turns/month" — OPS |
| Free-tier cost | "~$0 — structurally protected" — FIN | "$0.030–0.040/user/mo at 1k users" — BR-v6 |
| AI-tokens monthly retail | "$3.183/mo" — BR-v6 §04; "$3.183/mo ($38.19/yr)" — CP-v6 | 2 × $1.591 = $3.182 (stated 2× rule) |
| Per-action margins vs stated markup | "flat 2× markup" — BR-v6 §01 | "margin **1.7×–5×** depending on action" — BR-v6 §02 same report; gross margin "**50%**" — IO-v5/CD-BR |
| Lowest stated margin | table's lowest is **3.0×** (backend plan) — BR-v6 | range claims **1.7×** — BR-v6 §01; 1.7× appears nowhere in the table |
| Source of "master" doc | FIN/SOURCE "MORPHEUS-BUSINESS-REPORT-**V5**" | the report it recaps is **v6** |
| Cost drivers count | "three cost lines" — BR-v6 §01 | 10+ itemized lines — OPS §01, FIN §05 |
| 200 credits as value | "~$0.25–0.35 one-time" — OPS/FIN | "$0.005/credit" ⇒ $1.00 retail — BR-v6; "15 real build turns… 3 compiles" — EX-v4 |
| Memory/history storage of user data | "stored in Morpheus's own database… isn't separately itemized" — OPS | "your data stays yours, not stored on Morpheus's servers" — CD-EX; "Protected" — FIN |
| Ollama/other: n/a | — | — |

### I-27. Free-tier explainer copy vs the finalized model it is supposed to reflect

- **EX-v4 / CD-EX** (user-facing, and EX-v4 is labelled "REVISED") promise "200 free credits immediately — **no setup at all**"; **CP-v6** says explicitly that the prior "planned 'Default tier: free, 200 credits/month' … **has been superseded**", and the **Guide Free Setup** is described in BR-v6 as requiring the user to "get own Gemini API key".
- **GTM** characterises the free path as "no card, no trial limit — a stronger free story than any competitor", while **CP-v6** claims for Morpheus the feature "Flat, predictable pricing — transparent per-action rate, **hard stop before overspend**" and simultaneously concedes "Claiming 'flat' wouldn't survive scrutiny… Morpheus now runs on pay-as-you-go token blocks" — the feature table still shows a ✓ for that row.

---

## Bottom line

The **model is consistent in its foundations** (2× markup, 80/20 marketplace, $0.80/$2.40 DeepSeek rate, $1.591/mo Morpheus, $10.58/yr Command Deck) and **inconsistent in its reporting layer**. The material items, in order, are:

1. **I-1** — the free tier exists in four documents and is denied in three (and GTM calls it unlimited).
2. **I-2** — the investor-facing "<$1/mo cost per active user" contradicts the $1.591–1.681/mo (Morpheus) and $2.47/mo (both products) figures used everywhere else.
3. **I-3** — Command Deck's incremental cost is $0.882/mo in its own report and $1.591/mo in the combined strategy.
4. **I-4 / I-24** — Priority Compile's own tier table ($0.01–0.03 median) contradicts the active-user table ($0.01/run) and the "pure margin / $0.00" compile line.
5. **I-6** — "12–65×" vs "8–42×" vs the same docs' own 4.5–28×, applied to identical prices.
6. **I-11 / I-23** — storage risk is "Protected/closed" in FIN while OPS says it is un-itemized, unmeasured and on the backlog; and the 1,000-user "profit" ignores a fixed floor OPS says is not covered at that scale.
7. **I-9 / I-10 / I-15** — the "master" and combined documents are sourced from the superseded V5, and the same usage figure is labelled verified and assumed.

Every inconsistency above is a reporting/derivation conflict between stated figures; none required an external model to detect.
