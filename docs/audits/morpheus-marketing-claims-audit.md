# Morpheus / Command Deck — Marketing Claim Extraction

Scope: every specific, checkable claim in the four named documents only. No assessment of
truth, no claims added that are not in the text.

Sources (shorthand used in every line below):

| Code | File |
|---|---|
| `CP6` | `/tmp/morpheus-docs/txt/MORPHEUS-COMPETITIVE-POSITIONING-v6.txt` |
| `CDCP` | `/tmp/morpheus-docs/txt/MORPHEUS-COMMAND-DECK-COMPETITIVE-POSITIONING.txt` |
| `EX4` | `/tmp/morpheus-docs/txt/MORPHEUS-EXPLAINER-v4.txt` |
| `CDEX` | `/tmp/morpheus-docs/txt/MORPHEUS-COMMAND-DECK-EXPLAINER.txt` |

Classification rule applied consistently:

- **PRODUCT** — a concrete assertion about Morpheus / Command Deck itself, checkable against the codebase, live database or live billing.
- **COMPETITOR** — a concrete assertion about a *named* competitor (or an explicit "competitors"/"these three" set) that is checkable against that competitor's public site, pricing page or documentation.
- **MARKETING** — unfalsifiable, subjective, aspirational, sweeping about "every tool"/"most builders", or an unnamed-aggregate competitor claim with no checkable referent.

---

## PRODUCT — claims about Morpheus / Command Deck itself

- `PRODUCT` [P01] "The finalized model has no free tier and no subscription — three paths instead: pay-as-you-go on a cheap frontier model by default, a guided free setup that walks a user through getting their own free Gemini API key (genuinely free, their own quota, not shared), and full BYOK for anyone bringing a different provider's key." — `CP6`
- `PRODUCT` [P02] "Morpheus — no subscription exists to price." — `CP6`
- `PRODUCT` [P03] "the genuinely-free path (guided setup with the user's own Gemini API key, $0 platform cost)" — `CP6`
- `PRODUCT` [P04] "a realistic pay-as-you-go active-builder cost, computed from Morpheus's own published per-action rates (not a guess)" — `CP6`
- `PRODUCT` [P05] Feature row: "Builds the whole app from a prompt (not manual drag-and-drop)" — Morpheus ✓ — `CP6`
- `PRODUCT` [P06] Feature row: "Multi-agent pipeline — plans, codes, reviews & auto-fixes itself" — Morpheus ✓ — `CP6`
- `PRODUCT` [P07] Feature row: "True native mobile app (not a browser wrapper)" — Morpheus ✓ — `CP6`
- `PRODUCT` [P08] Feature row: "True native desktop app (Windows / macOS)" — Morpheus ✓ — `CP6`
- `PRODUCT` [P09] Feature row: "Linux distro / Raspberry Pi OS image output" — Morpheus ✓ — `CP6`
- `PRODUCT` [P10] Feature row: "Full code ownership — your own repo, no lock-in" — Morpheus ✓ — `CP6`
- `PRODUCT` [P11] Feature row: "Built-in creator marketplace to sell what you build" — Morpheus ✓ — `CP6`
- `PRODUCT` [P12] Feature row: "Model-agnostic — not locked to one AI provider" — Morpheus ✓ — `CP6`
- `PRODUCT` [P13] Feature row: "Flat, predictable pricing — transparent per-action rate, hard stop before overspend" (row marked REVISED) — Morpheus ✓ — `CP6`
- `PRODUCT` [P14] Feature row: "Autonomous build mode — keeps building without live supervision" — Morpheus ✓ — `CP6`
- `PRODUCT` [P15] "every action's cost is published per-action (not opaque)" — `CP6`
- `PRODUCT` [P16] "billing reserves the estimated cost before the call runs — so a user is blocked or informed before overspending, not mid-task or after the fact" — `CP6`
- `PRODUCT` [P17] "On pricing, I ended up in the same metered category as Lovable and Base44 — the difference is I show the meter before it runs, they don't." — `CP6`
- `PRODUCT` [P18] "MORPHEUS — FREE (OWN GEMINI KEY) $0/yr — guided setup, genuinely your own quota" — `CP6`
- `PRODUCT` [P19] "MORPHEUS — PAY AS YOU GO $38.55–40.35/yr — realistic active builder, published rates" — `CP6`
- `PRODUCT` [P20] Morpheus — free (own Gemini key): "Guided setup, own quota", $0 monthly, $0 annual, "nothing in this list" (nothing excluded) — `CP6`
- `PRODUCT` [P21] Morpheus — pay-as-you-go: "Token blocks, no plan", ~$3.21–3.36/mo, ~$38.55–40.35/yr, "nothing in this list" (nothing excluded) — `CP6`
- `PRODUCT` [P22] "AI usage alone is now $3.183/mo ($38.19/yr); own-GitHub compile adds a small flat rate, bringing the floor to $38.55/yr, or $40.35/yr with Priority Compile." — `CP6`
- `PRODUCT` [P23] "Combined with Command Deck, a user running both lands just under $5/month total." — `CP6`
- `PRODUCT` [P24] "A realistic Morpheus builder pays $0–$40/year for the same period" — `CP6`
- `PRODUCT` [P25] "the free path here is a real guided setup — the user gets their own Gemini quota, not a slice of a shared one" — `CP6`
- `PRODUCT` [P26] "Margin comes from usage markup, marketplace commission, and a growing set of optional upsells only relevant once a builder is already shipping real output" — `CP6`
- `PRODUCT` [P27] "Priority Compile (instant native builds without the user's own GitHub) and Native Preview (live, interactive preview of the actual compiled app on a hosted VM) both being built next." — `CP6`
- `PRODUCT` [P28] "Set up your own free AI key and it costs nothing at all." — `EX4`
- `PRODUCT` [P29] "I'll build it, compile it into something real, and it's yours — not mine, not a subscription's, yours." — `EX4`
- `PRODUCT` [P30] "Describe the idea. In your own words, like you're explaining it to a person" — `EX4`
- `PRODUCT` [P31] "Watch it get built. Planned, coded, reviewed, and fixed — automatically" — `EX4`
- `PRODUCT` [P32] "Take it with you. Real code, in your own repository, compiled to a real app" — `EX4`
- `PRODUCT` [P33] "Ask for what's missing. If it's not there yet and enough people want it, it gets built in" — `EX4`
- `PRODUCT` [P34] "You're not getting code snippets to paste together yourself. You're getting the whole process — the part that used to need a team." — `EX4`
- `PRODUCT` [P35] "Breaks the idea into a real build plan — screens, data, logic — before a line of code is written." — `EX4`
- `PRODUCT` [P36] "Writes the code, checks its own work, catches and fixes what's broken — the way a real engineer would." — `EX4`
- `PRODUCT` [P37] "Compiles to something real — Web, Android, desktop, Linux, Raspberry Pi, even Mac/iOS — a real, running app, not a demo in a browser tab." — `EX4`
- `PRODUCT` [P38] "Publish it, use it, or list it on Morpheus's own marketplace and get paid when other builders use what you made." — `EX4`
- `PRODUCT` [P39] "Morpheus compiles for the real target — a phone, a desktop, a device" — `EX4`
- `PRODUCT` [P40] "Sign up with Google — no card required" — `EX4`
- `PRODUCT` [P41] "One Google sign-in covers login and (optionally) connecting your own storage in the same step." — `EX4`
- `PRODUCT` [P42] "You start with 200 free credits immediately — no setup at all — enough to plan, build, and compile a real first app." — `EX4`
- `PRODUCT` [P43] "set up your own free Gemini API key in a couple of clicks (genuinely free, forever, your own quota)" — `EX4`
- `PRODUCT` [P44] "just keep going and pay only for what you actually use, a fraction of a cent per action." — `EX4`
- `PRODUCT` [P45] "Morpheus will ask questions if it needs more detail" — `EX4`
- `PRODUCT` [P46] "set it to build autonomously and come back to a finished first version" — `EX4`
- `PRODUCT` [P47] "'Make the button bigger.' 'Add a login screen.' No code to touch yourself unless you want to." — `EX4`
- `PRODUCT` [P48] "Download it, deploy it, or push it to your own GitHub." — `EX4`
- `PRODUCT` [P49] "The code doesn't disappear if you stop paying — because you were never renting it." — `EX4`
- `PRODUCT` [P50] "Morpheus — free Gemini setup: $0 | Native app? 'Yes — 6 platforms' | You own the code? 'Yes, fully'" — `EX4`
- `PRODUCT` [P51] "Morpheus — pay-as-you-go: $38.55–40.35 | 'Yes — 6 platforms' | 'Yes, fully'" — `EX4`
- `PRODUCT` [P52] "MORPHEUS, TO START $0–40/yr" — `EX4`
- `PRODUCT` [P53] "real desktop app, real Linux build, a marketplace to sell in" (offered by Morpheus) — `EX4`
- `PRODUCT` [P54] "What your first 200 credits actually cover ... a handful of clarifying chats, 15 real build turns, a couple of auto-fixes, a backend plan and generate, some test generation, and 3 compiles. A genuinely finished first project, before you've spent a cent." — `EX4`
- `PRODUCT` [P55] Roadmap item: "A dedicated space for planning docs and reference files — SHIPPED" — `EX4`
- `PRODUCT` [P56] Roadmap item: "A full code editor inside the build panel — IN DEVELOPMENT" — `EX4`
- `PRODUCT` [P57] Roadmap item: "A browser agent that can act on the web for you — REQUESTED" — `EX4`
- `PRODUCT` [P58] Roadmap item: "A community space to see what others are building — REQUESTED" — `EX4`
- `PRODUCT` [P59] Roadmap item: "Instant priority compile, no GitHub account needed — IN DEVELOPMENT" — `EX4`
- `PRODUCT` [P60] "Morpheus isn't a fixed product with a locked feature list waiting for the next paid tier. It's under active development — and the roadmap listens." — `EX4`
- `PRODUCT` [P61] "If enough people ask for the same capability, and it makes sense to build, it becomes part of what I can do for everyone — not a locked add-on, not a higher tier." — `EX4`
- `PRODUCT` [P62] "The same idea that lets you build an app by describing it lets you shape the platform by asking for what's missing." — `EX4`
- `PRODUCT` [P63] "What you build stays yours. No platform holding it hostage to a subscription that never ends" — `EX4`
- `PRODUCT` [P64] "Command Deck — priced against its own finalized unit economics: a guided free path (genuinely $0) and a pay-as-you-go path, both computed from Morpheus's own published per-action rates, not a guess." — `CDCP`
- `PRODUCT` [P65] Feature row: "Calendar/task scheduling" — Command Deck ✓ — `CDCP`
- `PRODUCT` [P66] Feature row: "Email triage/synthesis" — Command Deck ✓ — `CDCP`
- `PRODUCT` [P67] Feature row: "Banking/finance awareness" — Command Deck ✓ — `CDCP`
- `PRODUCT` [P68] Feature row: "Health/fitness awareness" — Command Deck ✓ — `CDCP`
- `PRODUCT` [P69] Feature row: "Cross-domain synthesis (conclusions no single source could produce)" — Command Deck ✓ — `CDCP`
- `PRODUCT` [P70] Feature row: "Builds new custom tools on request" — Command Deck ✓ — `CDCP`
- `PRODUCT` [P71] Feature row: "Built-in creator marketplace" — Command Deck ✓ — `CDCP`
- `PRODUCT` [P72] Feature row: "Flat, credit-metered surprise-free billing" — Command Deck ✓ ("pre-call transparency") — `CDCP`
- `PRODUCT` [P73] Feature row: "Genuinely free path (not a limited trial)" — Command Deck ✓ ("full features") — `CDCP`
- `PRODUCT` [P74] "Command Deck — free setup | Guided free Gemini key | $0 | $0 | Every domain connected" — `CDCP`
- `PRODUCT` [P75] "Command Deck — pay-as-you-go | Token blocks, no plan | ~$1.76 | ~$21.16 | Every domain connected" — `CDCP`
- `PRODUCT` [P76] "COMMAND DECK $0–21/yr — every domain, not one" — `CDCP`
- `PRODUCT` [P77] "connecting five domains" — `CDCP`
- `PRODUCT` [P78] "running on infrastructure Morpheus has already built and paid for once" — `CDCP`
- `PRODUCT` [P79] "Command Deck is Jarvis — an AI that connects everything in your life and work, finds the patterns none of the individual apps can see, and builds you custom tools to act on them." — `CDEX`
- `PRODUCT` [P80] "Free to set up." — `CDEX`
- `PRODUCT` [P81] "Connect the things you already use — email, calendar, banking, health, notes, tasks, messages — and Jarvis synthesizes across all of them into one holistic view of your life and work." — `CDEX`
- `PRODUCT` [P82] "Not a dashboard of separate widgets. One assistant that sees the whole picture." — `CDEX`
- `PRODUCT` [P83] "With just a calendar connected, Jarvis can tell you your week looks busy. Add your banking, and it can tell you why your spending spikes the same weeks your evenings fill up. Add health data too, and it connects that same pattern to your sleep dropping — and flags it before you'd notice yourself." — `CDEX`
- `PRODUCT` [P84] "Each connection doesn't just add a fact. It lets Jarvis draw a conclusion no single app could produce alone." — `CDEX`
- `PRODUCT` [P85] "Say 'add a widget that shows my overall capability against my optimal performance' and Jarvis hands the request to Morpheus, which codes and installs it automatically — pulling from whatever health, calendar, and work data you've connected." — `CDEX`
- `PRODUCT` [P86] Connect list: "Email — only surfaces what actually needs a reply" — `CDEX`
- `PRODUCT` [P87] Connect list: "Calendar — merges every calendar, flags conflicts" — `CDEX`
- `PRODUCT` [P88] Connect list: "Banking — categorizes spending, flags unusual charges" — `CDEX`
- `PRODUCT` [P89] Connect list: "Health & fitness — trends without opening five apps" — `CDEX`
- `PRODUCT` [P90] Connect list: "Notes, tasks, messaging — one prioritized view instead of a dozen" — `CDEX`
- `PRODUCT` [P91] "Sign in with Google ... your data stays yours, not stored on Morpheus's servers." — `CDEX`
- `PRODUCT` [P92] "You start with 200 free credits immediately, no setup required." — `CDEX`
- `PRODUCT` [P93] "Start with one thing — email, calendar, whatever's most annoying to manage right now. Add more whenever you want; nothing is required up front." — `CDEX`
- `PRODUCT` [P94] "Jarvis either does it directly or hands it to Morpheus to build." — `CDEX`
- `PRODUCT` [P95] "Install a Command Deck app — Add it to your home screen like any real app — it's a standalone installable web app, not a browser tab you have to hunt for." — `CDEX`
- `PRODUCT` [P96] "Free to actually use, not free-to-try" — `CDEX`
- `PRODUCT` [P97] "Set up your own free Gemini API key in a couple of clicks — genuinely free, your own quota, not shared with anyone else's usage — and Jarvis costs you nothing." — `CDEX`
- `PRODUCT` [P98] "Or just start talking and pay only for what you use, a fraction of a cent per action." — `CDEX`
- `PRODUCT` [P99] "Command Deck — free setup | Every domain you connect | $0 | Yes" — `CDEX`
- `PRODUCT` [P100] "Command Deck — pay-as-you-go | Every domain you connect | ~$21 | Yes" — `CDEX`
- `PRODUCT` [P101] "COMMAND DECK $0–21/yr — covers every domain, one assistant" — `CDEX`
- `PRODUCT` [P102] "Command Deck flips that: bring whatever you want connected, and one assistant sees all of it at once." — `CDEX`

---

## COMPETITOR — claims about named competitors (checkable against their public sites/pricing)

- `COMPETITOR` [C01] Feature row "Builds the whole app from a prompt (not manual drag-and-drop)": Bubble ✗, FlutterFlow ✗, Adalo ✗, Lovable ✓, Base44 ✓ — `CP6`
- `COMPETITOR` [C02] Feature row "Multi-agent pipeline — plans, codes, reviews & auto-fixes itself": Bubble ✗, FlutterFlow ✗, Adalo ✗, Lovable ✗, Base44 ✗ — `CP6`
- `COMPETITOR` [C03] Feature row "True native mobile app (not a browser wrapper)": FlutterFlow ✓, Adalo ✓, Bubble ✗, Lovable ✗, Base44 ✗ — `CP6`
- `COMPETITOR` [C04] Feature row "True native desktop app (Windows / macOS)": Bubble ✗, FlutterFlow ✗, Adalo ✗, Lovable ✗, Base44 ✗ — `CP6`
- `COMPETITOR` [C05] Feature row "Linux distro / Raspberry Pi OS image output": Bubble ✗, FlutterFlow ✗, Adalo ✗, Lovable ✗, Base44 ✗ — `CP6`
- `COMPETITOR` [C06] Feature row "Full code ownership — your own repo, no lock-in": FlutterFlow ✓, Lovable ✓, Base44 ✓, Bubble ✗, Adalo ✗ — `CP6`
- `COMPETITOR` [C07] Feature row "Built-in creator marketplace to sell what you build": Bubble ✗, FlutterFlow ✗, Adalo ✗, Lovable ✗, Base44 ✗ — `CP6`
- `COMPETITOR` [C08] Feature row "Model-agnostic — not locked to one AI provider": Bubble ✗, FlutterFlow ✗, Adalo ✗, Lovable ✗, Base44 ✗ — `CP6`
- `COMPETITOR` [C09] Feature row "Flat, predictable pricing — transparent per-action rate, hard stop before overspend": FlutterFlow ✓, Adalo ✓, Bubble ✗, Lovable ✗, Base44 ✗ — `CP6`
- `COMPETITOR` [C10] Feature row "Autonomous build mode — keeps building without live supervision": Bubble ✗, FlutterFlow ✗, Adalo ✗, Lovable ✗, Base44 ✗ — `CP6`
- `COMPETITOR` [C11] "Bubble $2,508/yr — Growth plan" (cheapest plan supporting a real production-ready app) — `CP6`
- `COMPETITOR` [C12] "Adalo $1,920/yr — Team, payments req'd" — `CP6`
- `COMPETITOR` [C13] "FlutterFlow $888/yr — Basic + backend" — `CP6`
- `COMPETITOR` [C14] "Lovable $840/yr — Pro + Supabase Pro" — `CP6`
- `COMPETITOR` [C15] "Base44 $480/yr — Builder" — `CP6`
- `COMPETITOR` [C16] "Bubble Growth (web+mobile) $209/mo, $2,508/yr — doesn't include native mobile, code ownership" — `CP6`
- `COMPETITOR` [C17] "Adalo Team (payments req'd) $160/mo, $1,920/yr — doesn't include code ownership, desktop/OS output" — `CP6`
- `COMPETITOR` [C18] "FlutterFlow Basic + backend ~$74/mo, ~$888/yr — doesn't include marketplace, desktop/OS output" — `CP6`
- `COMPETITOR` [C19] "Lovable Pro + Supabase Pro ~$70/mo, ~$840/yr — doesn't include native app of any kind, flat pricing" — `CP6`
- `COMPETITOR` [C20] "Base44 Builder $40/mo, $480/yr — doesn't include native mobile, flat pricing" — `CP6`
- `COMPETITOR` [C21] "still 12–65× cheaper than the cheapest competitor" — `CP6`
- `COMPETITOR` [C22] "Competitors charge $480–$2,508/year just to reach 'production-capable,' and still can't ship a native desktop app, a Linux/Pi image, or a built-in way to sell what gets built." — `CP6`
- `COMPETITOR` [C23] "a gap of one to two orders of magnitude" (Morpheus $0–$40/yr vs competitors $480–$2,508/yr) — `CP6`
- `COMPETITOR` [C24] Bubble: "industry guides put the real monthly cost of an active production app at $300–$1,500/mo once workload-unit overages, plugins, and optimization work are counted — the sticker price is rarely the bill." — `CP6`
- `COMPETITOR` [C25] Bubble "$209/mo entry" — `CP6`
- `COMPETITOR` [C26] FlutterFlow: "True native mobile output is a real strength — closest of the five to Morpheus on that front." — `CP6`
- `COMPETITOR` [C27] FlutterFlow: "it's a visual builder with AI assistance bolted on, not AI-native, and backend hosting is a separate bill." — `CP6`
- `COMPETITOR` [C28] FlutterFlow "~$74/mo entry" — `CP6`
- `COMPETITOR` [C29] Adalo: "No code export at all — stop paying, lose the app." — `CP6`
- `COMPETITOR` [C30] Adalo: "Payment processing is locked behind its most expensive tier. $160/mo for payments" — `CP6`
- `COMPETITOR` [C31] Lovable: "The fastest-growing AI app builder in the market ($6.6B valuation, 8M+ users)" — `CP6`
- `COMPETITOR` [C32] Lovable: "Web-only output" — `CP6`
- `COMPETITOR` [C33] Lovable: "its own pricing guides call credit consumption 'the biggest cost variable,' with real bills routinely landing above the sticker price." — `CP6`
- `COMPETITOR` [C34] Lovable "~$70/mo real total" — `CP6`
- `COMPETITOR` [C35] Base44: "Cheapest AI-native entry point" — `CP6`
- `COMPETITOR` [C36] Base44: "Wix's backing gives it distribution most competitors don't have." — `CP6`
- `COMPETITOR` [C37] Base44: "Primarily web-focused — its own documentation points users elsewhere for native mobile." — `CP6`
- `COMPETITOR` [C38] Base44: "Dual-credit system means live apps can hit errors when integration credits run out, with users seeing the failure, not the owner." — `CP6`
- `COMPETITOR` [C39] Base44 "$40/mo entry" — `CP6`
- `COMPETITOR` [C40] "CHEAPEST COMPETITOR ENTRY $480/yr — Base44 Builder — web only" — `CP6`
- `COMPETITOR` [C41] "MOST EXPENSIVE ENTRY $2,508/yr — Bubble Growth" — `CP6`
- `COMPETITOR` [C42] "Morpheus doesn't need a free tier to win on price — a realistic active builder's real bill ... still lands one to two orders of magnitude below every competitor while covering more ground than any of them." — `CP6`
- `COMPETITOR` [C43] "Motion (AI calendar/task auto-scheduling, ~$60M Series C, repositioned as an 'AI SuperApp for work')" — `CDCP`
- `COMPETITOR` [C44] "Reclaim.ai (AI calendar assistant, acquired by Dropbox for $40.2M in 2024)" — `CDCP`
- `COMPETITOR` [C45] "Rewind/Limitless (screen & meeting memory, raised at a $350M valuation before being acquired by Meta in December 2025 and wound down)" — `CDCP`
- `COMPETITOR` [C46] "What none of them ever did is connect what they know to anything outside their own lane." — `CDCP`
- `COMPETITOR` [C47] Feature row "Calendar/task scheduling": Motion ✓, Reclaim.ai ✓, Rewind/Limitless ✗ — `CDCP`
- `COMPETITOR` [C48] Feature row "Email triage/synthesis": Motion ✗, Reclaim.ai ✗, Rewind/Limitless ✗ — `CDCP`
- `COMPETITOR` [C49] Feature row "Banking/finance awareness": Motion ✗, Reclaim.ai ✗, Rewind/Limitless ✗ — `CDCP`
- `COMPETITOR` [C50] Feature row "Health/fitness awareness": Motion ✗, Reclaim.ai ✗, Rewind/Limitless ✗ — `CDCP`
- `COMPETITOR` [C51] Feature row "Cross-domain synthesis (conclusions no single source could produce)": Motion ✗, Reclaim.ai ✗, Rewind/Limitless ✗ — `CDCP`
- `COMPETITOR` [C52] Feature row "Builds new custom tools on request": Motion ✗, Reclaim.ai ✗, Rewind/Limitless ✗ — `CDCP`
- `COMPETITOR` [C53] Feature row "Built-in creator marketplace": Motion ✗, Reclaim.ai ✗, Rewind/Limitless ✗ — `CDCP`
- `COMPETITOR` [C54] Feature row "Flat, credit-metered surprise-free billing": Motion ✗ ("credit overages"), Reclaim.ai ✓, Rewind/Limitless ✓ — `CDCP`
- `COMPETITOR` [C55] Feature row "Genuinely free path (not a limited trial)": Motion ✗, Reclaim.ai ✓ ("limited"), Rewind/Limitless ✓ ("limited") — `CDCP`
- `COMPETITOR` [C56] "Each one is a single sense with no nervous system connecting it to anything else. Motion sees your calendar. Reclaim sees your calendar. Rewind saw your screen." — `CDCP`
- `COMPETITOR` [C57] "None of them ever combined what they saw with anything happening outside their own domain" — `CDCP`
- `COMPETITOR` [C58] "two of the three were acquired and folded into a bigger company's roadmap rather than expanding on their own" — `CDCP`
- `COMPETITOR` [C59] "Motion | Pro AI / Business AI | $19–49 | $228–588 | Calendar + tasks only" — `CDCP`
- `COMPETITOR` [C60] "Reclaim.ai | Starter–Business | $8–15 | $96–180 | Calendar only" — `CDCP`
- `COMPETITOR` [C61] "Rewind / Limitless | Pro (before wind-down) | $19–29 | $228–348 | Screen/meeting memory only" — `CDCP`
- `COMPETITOR` [C62] "CHEAPEST COMPETITOR $96/yr — Reclaim.ai — calendar only" — `CDCP`
- `COMPETITOR` [C63] "MOST EXPENSIVE $588/yr — Motion Business AI" — `CDCP`
- `COMPETITOR` [C64] "GAP 4.5–28× cheaper, for strictly more" (Command Deck vs competitors) — `CDCP`
- `COMPETITOR` [C65] Motion: "Genuinely strong auto-scheduling engine, now repositioning as an 'AI SuperApp for work' after a ~$60M Series C." — `CDCP`
- `COMPETITOR` [C66] Motion: "it's credit-metered with real overage costs" — `CDCP`
- `COMPETITOR` [C67] Motion: "doesn't import existing tasks" — `CDCP`
- `COMPETITOR` [C68] Motion: "isn't available on Linux" — `CDCP`
- `COMPETITOR` [C69] Motion: "covers calendar/tasks only — no email, banking, or health awareness at any tier." — `CDCP`
- `COMPETITOR` [C70] Motion "$19–49/mo" — `CDCP`
- `COMPETITOR` [C71] Reclaim.ai: "The cleanest single-purpose tool in the category — calendar optimization, habits, smart meetings." — `CDCP`
- `COMPETITOR` [C72] Reclaim.ai: "Acquired by Dropbox in 2024." — `CDCP`
- `COMPETITOR` [C73] Reclaim.ai: "Explicitly calendar-only: 'it doesn't touch your inbox' per independent reviews" — `CDCP`
- `COMPETITOR` [C74] Reclaim.ai: "a 10-seat pricing cliff makes team growth awkward." — `CDCP`
- `COMPETITOR` [C75] Reclaim.ai "$8–15/mo" — `CDCP`
- `COMPETITOR` [C76] Rewind → Limitless: "Raised at a $350M valuation on the promise of a 'trusted home base for all your personal context' — screen and audio memory, searchable." — `CDCP`
- `COMPETITOR` [C77] Rewind → Limitless: "Pivoted to the Limitless pendant, was acquired by Meta in December 2025, and the original product was sunsetted weeks later." — `CDCP`
- `COMPETITOR` [C78] Rewind → Limitless: "No live data synthesis — it only ever remembered, never connected sources." — `CDCP`
- `COMPETITOR` [C79] Rewind / Limitless "$19–29/mo (discontinued)" — `CDCP`
- `COMPETITOR` [C80] "Two of these three got acquired and absorbed into someone else's product line within the last two years." — `CDCP`
- `COMPETITOR` [C81] "Command Deck does it for less than the cheapest single-domain competitor charges to do a sixth of the job." — `CDCP`
- `COMPETITOR` [C82] "The category has already proven willing to pay $8–49/month for one domain, and proven attractive enough to get acquired twice in two years." — `CDCP`
- `COMPETITOR` [C83] "None of them can build you something new. If the tool doesn't have the exact feature you need, you wait for their roadmap or you don't get it." — `CDEX`
- `COMPETITOR` [C84] "No single-purpose tool can do that — because it only sees one piece." — `CDEX`
- `COMPETITOR` [C85] "No other assistant on the market can build you a genuinely new tool on request." — `CDEX`
- `COMPETITOR` [C86] "Motion | Calendar + tasks only | $228–588 | Cross-domain? No" — `CDEX`
- `COMPETITOR` [C87] "Reclaim.ai | Calendar only | $96–264 | Cross-domain? No" — `CDEX`
- `COMPETITOR` [C88] "Rewind / Limitless | Screen/meeting memory only | $228–348 (before Meta acquisition wound it down) | Cross-domain? No" — `CDEX`
- `COMPETITOR` [C89] "TYPICAL COMPETITOR STACK $300–900/yr for 2–3 separate single-purpose tools" — `CDEX`
- `COMPETITOR` [C90] "WHAT COMPETITORS CAN'T DO at any price: build you a new custom tool on request" — `CDEX`
- `COMPETITOR` [C91] "none of them cross domains the way Command Deck does" — `CDEX`
- `COMPETITOR` [C92] "I'm the only one looking at all of them together." — `CDEX`
- `COMPETITOR` [C93] "Bubble | $2,508 | Native app? No | You own the code? No" — `EX4`
- `COMPETITOR` [C94] "Adalo | $1,920 | Mobile only | No" (native + code ownership) — `EX4`
- `COMPETITOR` [C95] "FlutterFlow | ~$888 | Mobile only | Yes" (native + code ownership) — `EX4`
- `COMPETITOR` [C96] "Lovable | ~$840 | No | Partial" (native app + code ownership) — `EX4`
- `COMPETITOR` [C97] "Base44 | $480 | No | Partial" (native app + code ownership) — `EX4`
- `COMPETITOR` [C98] "CHEAPEST COMPETITOR $480/yr" and "MOST EXPENSIVE $2,508/yr" — `EX4`
- `COMPETITOR` [C99] "real desktop app, real Linux build, a marketplace to sell in, all things competitors don't offer at any price" — `EX4`

---

## MARKETING — subjective, aspirational, sweeping or unnamed-aggregate

- `MARKETING` [M01] "I'm not being compared to toys. These are the platforms serious builders already pay for." — `CP6`
- `MARKETING` [M02] "The difference isn't that I'm cheaper for the same thing — it's that most of what I ship, they can't ship at any price." — `CP6`
- `MARKETING` [M03] "This is a more honest number to publish than the old one, not a worse one" — `CP6`
- `MARKETING` [M04] "That's a materially different experience from an opaque credit meter, even though both are usage-based." — `CP6`
- `MARKETING` [M05] "Every one of these platforms had to pick a lane — visual builder or AI-native, web or native, flat pricing or flexible credits. I didn't have to pick on capability." — `CP6`
- `MARKETING` [M06] "This isn't a story about being the cheapest option in a crowded market. It's that the cheapest option and the most capable option are usually different products — and right now, they're the same one, at a real, defensible price rather than a not-yet-built free tier." — `CP6`
- `MARKETING` [M07] "Why this is investable, not just impressive" — `CP6`
- `MARKETING` [M08] "Every builder Morpheus pulls from a $40–$209/month competitor is a customer already proven willing to pay for this category — just not this much value for it." — `CP6`
- `MARKETING` [M09] "These aren't strawmen — real capital backed all three, and two got bought by companies bigger than most startups ever see." — `CDCP`
- `MARKETING` [M10] "That's not a coincidence — a single-domain assistant is a feature waiting for a platform to swallow it. I'm not waiting to be that feature. I'm already the platform." — `CDCP`
- `MARKETING` [M11] "This isn't a pricing story. It's that connecting five domains is a fundamentally different product from optimizing one" — `CDCP`
- `MARKETING` [M12] "A wider product than the entire category combined, for less than any one of them" — `CDCP`
- `MARKETING` [M13] "Command Deck doesn't compete inside that category — it makes the category's premise (pick one domain and optimize it) obsolete" — `CDCP`
- `MARKETING` [M14] "what none of them can do at any price" (cover framing) — `CDCP`
- `MARKETING` [M15] "Every app builder before this one rents you a small, fenced-off piece of what you're allowed to make." — `EX4`
- `MARKETING` [M16] "right now, if you have an idea for an app, you're offered a deal: hand over $30, $80, $200 a month, forever, to a platform that still owns the ground you're building on" (unnamed platforms) — `EX4`
- `MARKETING` [M17] "Miss a payment and your app disappears. That's not a tool. That's a toll booth." (unnamed platforms) — `EX4`
- `MARKETING` [M18] "I'm not here to rent you a smaller cage with nicer wallpaper." — `EX4`
- `MARKETING` [M19] "The old way" list: "Learn a platform's rules before you can build anything at all"; "Pay every month, forever, just to keep what you already built alive"; "Hit a wall the platform decided on, not you — and pay more to move it"; "Lose the app the day you stop paying" (unnamed platforms) — `EX4`
- `MARKETING` [M20] "Most builders hand you a website wearing an app icon." (unnamed "most builders") — `EX4`
- `MARKETING` [M21] "a business built on a fake app is a business built on a shortcut" — `EX4`
- `MARKETING` [M22] "No install, no setup tutorial, no blank-page panic." — `EX4`
- `MARKETING` [M23] "That's not a token gesture — it's enough to plan, build, iterate on, and compile one complete small app" — `EX4`
- `MARKETING` [M24] "You're not saving money on the same thing. You're getting a different, bigger thing for a fraction of the price." — `EX4`
- `MARKETING` [M25] "Illustrative snapshot of Morpheus's real, active development backlog — not a guarantee of scope or timing." — `EX4`
- `MARKETING` [M26] "You're not waiting for permission either" — `EX4`
- `MARKETING` [M27] "Reality doesn't ask what your plan costs" — `EX4`
- `MARKETING` [M28] "Somewhere along the way, 'build software' became a thing you had to be granted permission to do — a login, a tier, a monthly toll to a system that decides what you're allowed to make and how much of it you're allowed to keep. That was never a law of nature." — `EX4`
- `MARKETING` [M29] "The idea becomes the only requirement. Not the budget, not the bootcamp, not the years of practice first" — `EX4`
- `MARKETING` [M30] "The tool keeps growing toward you. Not toward the next pricing tier — toward what its builders actually ask for" — `EX4`
- `MARKETING` [M31] "Stop describing the app you'd build if you could code. Just describe it." — `EX4`
- `MARKETING` [M32] "Stop asking permission to build." — `EX4`
- `MARKETING` [M33] "Free to set up. Nothing else like it exists." — `CDEX`
- `MARKETING` [M34] "Every AI productivity tool on the market does exactly one job." — `CDEX`
- `MARKETING` [M35] "Each one lives in its own silo, blind to everything happening in the rest of your life." — `CDEX`
- `MARKETING` [M36] "You end up running five subscriptions to cover what one connected brain could do. A calendar app, an email app, a budgeting app, a habit tracker — each charging separately for a fraction of the picture." — `CDEX`
- `MARKETING` [M37] "Every assistant before Jarvis asked you to bring your life to it in pieces — a calendar here, an inbox there, a budget app somewhere else — and then only ever looked at the piece it was built for." — `CDEX`
- `MARKETING` [M38] "Your life has a build team now." — `CDEX`
- `MARKETING` [M39] "Stop checking five apps to understand one life." — `CDEX`

---

## Cross-document and internal inconsistencies (descriptive only — reported, not judged)

These are places where the four documents state different numbers or statuses for the same thing.
They are listed because they are the first things a verification pass will trip over, not as a
verdict on which is right.

1. **Reclaim.ai annual cost** — `CDCP` says `$96–180/yr`; `CDEX` says `$96–264`. (Monthly `$8–15` is the same in both.)
2. **Code ownership, Lovable** — `CP6` marks Lovable ✓ for "Full code ownership — your own repo, no lock-in"; `EX4` marks Lovable "Partial".
3. **Code ownership, Base44** — `CP6` marks Base44 ✓ for "Full code ownership"; `EX4` marks Base44 "Partial".
4. **Compile targets** — `EX4` claims "Yes — 6 platforms" and lists "Web, Android, desktop, Linux, Raspberry Pi, even Mac/iOS" (6). The repo is described elsewhere as compiling to 11 targets; the documents never state a number other than 6.
5. **Free credits vs "no free tier"** — `CP6` states "The finalized model has no free tier and no subscription"; `EX4` and `CDEX` both state "You start with 200 free credits immediately." (One-time onboarding credits vs. a recurring free tier, but the documents do not reconcile the wording.)
6. **"Flat pricing"** — `CP6` marks Morpheus ✓ for the row "Flat, predictable pricing", yet the same document's callout concedes "with no free tier, Morpheus now runs on pay-as-you-go token blocks, the same structural category as Lovable and Base44's credit systems".
7. **Priority Compile status** — `CP6` lists Priority Compile as an existing priced upsell ("$40.35/yr with Priority Compile") and in the same document says it is "being built next"; `EX4` lists "Instant priority compile, no GitHub account needed — IN DEVELOPMENT".
8. **Rewind/Limitless currency** — `CDCP` benchmark set describes the three names as "the most-funded, most-adopted names" while also stating Rewind/Limitless was "wound down" and listing its tier as "discontinued" ($19–29/mo); `CDEX` carries the same discontinued pricing in its comparison table.
9. **Discount ratio** — `CP6` claims Morpheus is "12–65× cheaper than the cheapest competitor" (computed against $480–$2,508) and "a gap of one to two orders of magnitude"; `CDCP` claims "GAP 4.5–28× cheaper" for Command Deck ($96–$588 vs ~$21.16).
10. **Command Deck delivery form** — `CDEX` states Command Deck is "a standalone installable web app"; no document claims a native or desktop build for Command Deck itself.
