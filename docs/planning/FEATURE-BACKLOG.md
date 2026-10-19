# Morpheus — Feature Backlog (not scheduled into BUILD-PLAN phases yet)

Ideas captured for later. Nothing here gets built until explicitly greenlit and slotted into a phase.

---

## Guiding Vision — Universal Connectivity & Customization

This is the underlying holistic concept meant to drive Morpheus and Jarvis's direction across *all* new features, not just Command Deck — worth eventually folding into `MORPHEUS-PRIMER.md` / core vision docs once settled, not just kept here.

**The core idea:** Morpheus/Jarvis should be built as a set of frameworks, interfaces, structures, and systems capable of connecting to *any* data source, across *any* domain — anything that can be connected to and have data pulled from it, should be connectable. On top of that, users get full customization over how that pulled data is used, with the output being **automatable, actionable, and real** — not just a display of information, but something that actually does things.

**Self-extending connectivity.** If a connection doesn't already exist to reach some data source, Morpheus should be able to **research how to connect to it, form a plan, and then write the code/systems/engineering needed to make that connection real** — not blind code generation against an unknown target, but the same research-then-act pattern already established by the model-catalog research pipeline (`lib/ai/modelResearch.ts` — web search + LLM extraction, admin-triggered, kept current rather than hardcoded). Applied here, that means Morpheus looking up how a given service's API/auth actually works before writing a connector for it, the same way it already looks up current model pricing before suggesting one. This extends the "additive connector catalog" already discussed under Command Deck (#9) — that assumed connectors get added by Rob/the team over time; this extends it to Morpheus researching and building new connectors itself, on request, grounded in real research rather than guessing.

**Automated data collection**, hosted according to **the user's own choice**, with data kept **private** — same data-sovereignty principle already captured under Command Deck's privacy design, elevated here to a platform-wide default rather than a Command-Deck-specific decision. **Now operationalized**: see #12, User-Choice Cloud Storage for Project Data — Google Drive as the default connect flow, generalized to cover every Morpheus project, not just Command Deck.

**The one-line pitch:** an app that can be anything and everything — just ask it.

**Needs deciding later**
- Scope/safety of AI-researched-and-generated connectors: even grounded in real research rather than guessing, this still touches real user credentials and third-party services, so it likely needs the same "queue for human review before going live" pattern already used for new AI/hosting providers, applied here too.
- How this principle concretely changes near-term build priorities vs. staying aspirational guidance for now — worth revisiting once Command Deck's connector architecture (#9) is actually being designed, since that's the first place this vision gets tested for real.
- Where this should live long-term as documentation — likely belongs in `MORPHEUS-PRIMER.md` or a dedicated vision doc once the language is finalized, rather than only in this backlog file.

---

## 1. Community Forum — "Zion Forum" (Matrix-themed)

A searchable Q&A forum, styled to match the Matrix aesthetic (neon green monospace, terminal framing), seeded with fake back-and-forth so it's useful on day one instead of an empty shell.

**Core idea**
- Seeded with fake user questions + fake user answers, written as realistic troubleshooting threads (problem → replies → accepted/solved answer), so new users can search and find fixes without needing a live community yet.
- Real users can browse/search without an account; posting a new topic or question requires sign-in.
- When a new user posts a question Morpheus doesn't have an existing thread for, Morpheus auto-replies **in-character as a fake forum user** (not "as the AI assistant") with the correct fix/answer, formatted like a normal forum reply.

**Needs deciding later**
- Search: full-text search over threads (title + body + replies), tag/category filters (billing, compile errors, GitHub, marketplace, deploy, etc.).
- Data model: new Prisma entities — `ForumThread`, `ForumReply`, `ForumUser` (or reuse `User` with an `isSeeded`/`isBot` flag), vote/accepted-answer flag.
- How "answer as fake user" is triggered: on new thread creation, a background job calls the AI pipeline with a persona prompt (random seeded username/avatar) and posts the reply, with a short randomized delay so it doesn't look instant/robotic.
- Moderation/reporting for real user posts.

---

## 2. Download Map (Portable Morpheus) — visual + fake stats seeding

Lives in **Portable Morpheus** (the standalone/Electron-packaged version), not the hosted web app — this is the map showing where people have downloaded the portable build from, globally. Not the rewrite (`morpheus-web`) currently being scaffolded; whoever picks this up needs to be pointed at the `portable-morpheus` codebase (see `claude_PORTABLE-MORPHEUS-REVIEW-2026-08-25.md`).

- **Red dots smaller** — reduce marker size (and likely opacity/glow) so the map reads as data density rather than a mass of blobs at scale.
- **Seed 623 fake users** distributed globally, to give the map/stats a populated, credible look at launch.
- **Counter behavior**: seeded 623 is the starting baseline number. From that point forward, all real downloads increment on top of the seeded base — i.e. displayed total = 623 + real download count, and only real downloads drive future map pins / growth after seeding.

**Needs deciding later**
- Geographic distribution pattern for the 623 seeded points (weighted toward real-world dev population centers vs. even spread).
- Portable Morpheus currently uses a file-based JSON store (not Postgres) — seeded points likely live as a static fixture/seed file bundled with the app, with real downloads tracked separately (e.g. a small counts file or lightweight telemetry endpoint) and added on top at render time, rather than living in the same store as fake rows.
- Whether the map shows individual pins per download or clustered/heatmap-style density at this dot size.
- Confirm whether this same map should also eventually appear on hosted Morpheus (the rewrite), or stays Portable-only.

---

## 3. Browser Automation Agent — Chrome extension + mobile integrated browser

A Morpheus-driven agent that can take control of a browser tab (mouse/keyboard-level input simulation, not just DOM scraping) to carry out multi-step, multi-page tasks autonomously — e.g. "fill out this form across 3 pages," "sign into this dashboard and pull a report," "test my deployed app end-to-end." Two surfaces:

**A. Chrome extension (desktop)**
- User picks which open tab(s) the agent is allowed to control (explicit per-tab opt-in — not silent/background access to every tab).
- Agent drives the selected tab via simulated input (click, type, scroll, navigate) to execute a task plan, with visible on-screen feedback so the user can see what it's doing and interrupt/stop at any time.
- Needs a permission model: which sites are allowed, a kill switch, and a visible "agent is in control" indicator on the tab.

**B. Mobile — integrated in-app browser**
- Since a Chrome extension model doesn't exist on mobile, this needs an integrated/embedded browser view inside the Morpheus mobile app itself that the agent can drive the same way.
- Same task-plan-driven multi-step/multi-page execution, adapted to mobile viewport and touch-style input events.

**Likely use cases inside Morpheus**
- QA/testing a freshly compiled or deployed app by actually clicking through it.
- Automating GitHub/hosting-provider dashboard steps that don't have a clean API (OAuth consent screens, provider console setup).
- General "go do this multi-step web task for me" agent mode.
- **Sending transactional email at $0 cost, decided 2026-08-31**: once this exists, Morpheus can operate its own Gmail account through the browser (compose and send, the same way a human would) for receipts, marketplace transaction confirmations, and build-finished notifications — eliminating the need for a paid SMTP/transactional-email provider entirely. This is now the deciding factor for when Morpheus gets any transactional email at all — see the Operations Cost Plan and `BUILD-PLAN-2.0.md` Tier 1 item 5.

**Needs deciding later**
- Build vs. integrate: whether this is built from scratch (e.g. via CDP / Playwright-style control) or wraps an existing computer-use-style API/tool rather than reinventing input simulation.
- Security model: scoping control to explicitly selected tabs only, per-site allowlisting, credential handling (agent should not have blanket access to logged-in sessions unless the user explicitly hands off a task on that site).
- How task plans are defined/reviewed before execution — does the user see and approve the multi-step plan before the agent starts clicking, or only after (with the ability to stop mid-run)?
- Where this fits relative to Phase 5 (Architect) and the diagnosis agent — likely a distinct, later phase given the scope (browser-level control is a much bigger surface than the existing AI pipeline work).

---

## 4. "Advanced Mode" in Files panel — full-featured manual code editor

An opt-in mode on the Files panel (currently presumably a simpler view/edit surface) that upgrades it into a real, full-featured code editor for manually editing project code directly — for users who want to hand-edit rather than only go through Morpheus chat.

**Core idea**
- Toggle ("Advanced Mode") on the existing Files panel that swaps in a proper editor surface.
- "All the bells and whistles" — syntax highlighting, likely Monaco/CodeMirror-based, multi-file tabs, find/replace, line numbers, probably minimap, keyboard shortcuts users expect from a real editor (VS Code-like feel).
- Manual edits need to reconcile with the AI pipeline's view of the project — i.e. if a user hand-edits a file, Morpheus's next planner/coder/reviewer pass should see the current on-disk state, not a stale version.

**Needs deciding later**
- Editor library choice (Monaco is the natural fit — same engine as VS Code, but heavier; CodeMirror is lighter-weight).
- Scope of "bells and whistles" — does this include things like inline linting/error squiggles, autocomplete/IntelliSense, git diff view, multi-cursor, theming to match the Matrix aesthetic?
- How manual edits interact with the compile/commit pipeline — do they get picked up automatically on next build, or does the user need to explicitly save/sync before triggering a Morpheus action?
- Whether "Advanced Mode" is a per-project toggle, a per-user preference, or a one-off per-file "open in advanced editor" action.
- Undo/version safety — should manual edits be checkpointed separately from AI-driven commits so a bad manual edit doesn't get silently baked into the next reviewer pass?

---

## 5. Logic Capture — reverse-engineer black-box parts of apps imported from other builders

A capability for Morpheus's **import** path specifically: when a user brings in an app that was originally built on another app-builder platform (Bubble, FlutterFlow, Base44, etc.), some parts of that app are effectively black boxes to Morpheus — proprietary runtime behavior, generated code Morpheus can't cleanly read, platform-specific logic with no accessible source. Logic Capture is how Morpheus investigates those opaque parts by observing behavior and derives the underlying logic well enough to faithfully recreate the same functionality natively inside Morpheus's own stack.

**Core idea**
- Triggered during/after import, specifically on the parts of an imported app Morpheus can't directly parse/port from source.
- Morpheus probes the black-box piece — inputs/outputs, UI flows, network calls, state transitions, edge cases — and builds an internal model of "what it does," then hands that model to the existing planner/coder pipeline as if it were a spec, producing a fresh, original Morpheus-native implementation with matching behavior.
- Goal: the user's imported app ends up fully rebuilt in Morpheus's own stack, with no leftover dependency on the original builder's opaque/proprietary pieces.

**Needs deciding later**
- Import pipeline integration: does Logic Capture run automatically whenever import hits something unparseable, or is it a manual "investigate this part" action the user triggers on a specific broken/opaque feature post-import?
- Investigation method per source type: differs by originating platform — some export readable code/config Morpheus can partially parse (narrowing what actually needs black-box treatment), others are fully opaque at runtime only.
- How much of this reuses the existing "Research tool in build pipeline" — **decided: build this as a direct Morpheus capability (its own AI models doing the web-fetch/search work), not a third-party search API like Tavily** — vs. needs new live-probing/instrumentation tooling against the actual imported app instance.
- Output format: does it hand the planner a structured spec ("here's the inferred logic") for user review before rebuilding, or go straight to code?
- Confidence/gaps handling: what happens when behavior can't be fully inferred (hidden server-side-only rules) — should flag assumptions and gaps rather than silently guessing, especially since this is filling in for logic the user may not have written or fully understand themselves.
- Relationship to whatever "import" already does today in Morpheus — worth confirming current import behavior/limits before scoping this as an enhancement to it.

---

## 6. Post-Deployment User Management System — operate/maintain apps users have built

Once a Morpheus user builds and deploys an app, they currently have no ongoing operations layer inside Morpheus for running it day-to-day. This covers giving them a management surface for the *deployed* app itself, distinct from the build/chat pipeline.

**Core idea — two related but separate things worth telling apart:**

**A. Operating the deployed app (Morpheus-user-facing)**
- Dashboard per deployed project: uptime/status, deploy history, rollback to a previous build, logs/errors, basic usage metrics.
- Redeploy/restart controls without going back through the full chat pipeline for a simple restart.
- Alerts if a deployed app goes down or a build fails post-deploy.

**B. Managing the deployed app's own end-users (if the app has accounts/auth)**
- For apps that include user accounts (most real apps will), a way for the Morpheus user (the app's owner) to see and manage *their* app's end-users — list users, reset/disable an account, view basic activity — without having to hand-build an admin panel themselves every time.
- Likely ties into whatever auth pattern Morpheus's Architect/backend generation already scaffolds for generated apps.

**Needs deciding later**
- Where this lives in the product: a new dashboard section per project, or folded into the existing Settings/Files panel area.
- For (B): does Morpheus auto-generate this admin panel as part of every app it builds (so it's baked into the deployed app itself), or is it a separate Morpheus-hosted control surface that talks to the deployed app's database/API from outside?
- Multi-tenant implications: this needs to respect per-project ownership boundaries the same way the rest of hosted Morpheus does — a user should only ever see operations/users for apps they own.
- Relationship to the existing Architect backend generation and deployment work already built — likely builds directly on top of that rather than being a separate system.

---

## 7. "Boring" Theme — light/corporate alternate to the Matrix aesthetic

An alternate theme setting alongside the default Matrix look, for users/contexts where the neon-green terminal aesthetic isn't the right fit (office environments, presenting to non-technical stakeholders, older users who find the Matrix theme harder to read). Ships under that literal name — "Boring" is the actual UI label, not just an internal codename.

**Core idea**
- White/light background instead of the dark Matrix theme.
- Rounded buttons (softer, more conventional UI shapes vs. the sharp/terminal-style edges of the default look).
- Black text as the base, with color-coding still used purposefully (e.g. errors red, success green, links/actions in a consistent accent color) rather than the Matrix theme's heavy green-on-black styling throughout.
- Priority on readability and familiarity over aesthetic distinctiveness — should feel like a normal, professional business app.
- Explicitly aimed at: office/corporate settings, and older or less tech-fluent users who may find the Matrix theme's low contrast or unconventional styling harder to use.
- **Deliberately limited customizability** — this is a straight on/off theme toggle (Matrix ↔ Boring), not a full theming system with granular options. Once picked, the look and flow stay fixed; no per-element customization on top of it.

**Needs deciding later**
- Where the toggle lives — Settings, or a quick theme switcher always visible (e.g. top bar)?
- Scope of what changes: just color/shape tokens (background, text, button radius), or does layout/density also change (e.g. larger text, more spacing, for readability/accessibility)?
- Should apply consistently across the whole app (landing page, dashboard, Files panel, chat) or just the core builder UI.

---

## 8. Owner/Admin Control Panel — full backend control + monitoring surface for Rob's account

A dedicated, high-privilege control panel restricted to Rob's account (`robmitchellengineering@gmail.com`) for running Morpheus itself — distinct from anything regular users see. This is the biggest-scope item in the backlog and touches money, infra, and security directly, so it deserves the most careful design pass before building.

**Core capabilities wanted**

**A. AI model/routing control (ties into the token billing system)**
- Change the default AI model(s) Morpheus uses platform-wide (planner/coder/reviewer/diagnosis roles) without a code deploy — swap providers/models as pricing and quality shift, to keep cost-per-token competitive.
- Visibility into margin: given the current markup model (flat multiplier on underlying LLM cost), show what changing the default model does to profit margin per action/turn before committing to the switch.
- This is the natural home for the two **already-open decisions** flagged in earlier planning: pre-call vs. post-call billing, and how model/pricing data gets kept current (pricing was already noted as "perishable" — DeepSeek repriced mid-project once).

**B. Monitoring**
- Active users / total users.
- Uptime and system health across the hosted infra (Northflank backend, Netlify frontend, Supabase).
- Error/incident feed — surfaced in a way that flags what actually needs attention vs. background noise.
- Usage/cost dashboards (token spend vs. revenue, by model, over time).

**C. General backend control**
- A real admin surface for backend options/config that currently would otherwise require a direct code change or manual env var edit in Northflank — feature flags, provider allowlist management (ties into the existing "new providers queue for review" pattern), toggling things on/off platform-wide.
- Tools to actively maintain/update Morpheus — likely includes things like the currently-open punch-list items (rotating credentials, clearing stale GitHub PATs, running pending DB migrations) eventually surfacing here instead of being ad hoc.

**Needs deciding later**
- **Access control mechanism** — this directly supersedes the earlier open question of "hardcoded owner-exemption constant vs. `billing_exempt` column." Given the scope here is far beyond billing exemption (full backend control), a hardcoded email check is thin for something this powerful. Worth deciding whether this becomes a proper `role` column (e.g. `owner`/`admin`) on the user table, checked server-side on every privileged endpoint, rather than a single hardcoded email string scattered through the codebase.
- **Auth hardening for this page specifically** — given it can change what model everyone's app runs on and see revenue/margin data, this is worth stronger protection than a standard login (e.g. 2FA, session re-confirmation for destructive/financial actions).
- **Audit logging** — every change made through this panel (model swaps, config changes) should probably be logged with a timestamp/who, since it affects every user's app behavior and cost, not just Rob's own account.
- **Scope boundary vs. Northflank/Supabase/Stripe dashboards directly** — decide what actually needs to live inside Morpheus's own admin panel vs. what's fine to keep checking directly in the underlying infra providers' own dashboards (no need to rebuild Stripe's dashboard inside Morpheus, for example).
- **Model change safety — managed swap with warning + countdown.** Rather than an instant platform-wide swap, a default-model change triggers a warning to active users with a countdown before it takes effect, giving anyone mid-build a chance to pause/finish up first. Timing of the actual swap should target the least-disruptive moment globally across the user base (i.e. account for usage patterns across time zones rather than just picking Rob's local off-hours) rather than firing immediately on confirmation.

---

## 9. Command Deck — customizable life-assist dashboard (personal + user-facing version)

Repurposes the "Valiant Command Deck" concept from the Architect reference screenshots (originally a standalone-backend-construct screen) into a second product surface: a customizable personal life-assistant dashboard, powered by an AI persona called **Jarvis** (distinct from Morpheus, which stays the app-building agent).

**Core positioning — cross-domain synthesis is the product's actual superpower.** Jarvis brings a user's whole life together — work, partners, family, friends, health, energy, strategies, plans, dreams, wants, needs — synthesizing across all of it, and with Morpheus's help, turns that synthesis into customizable, feature-rich, actionable apps inside Command Deck. The guiding design philosophy is a **balanced, holistic approach aimed at the user's overall success and happiness**, not just task/data management in isolation. The individual plug-ins (email, calendar, banking, etc.) are just connection points — the differentiator is Jarvis synthesizing *across* all of them into one holistic, at-a-glance picture of a person's life and business, the same way Morpheus itself has a wide connector ecosystem (hosting providers, AI providers, GitHub) for building apps. Command Deck should have that same breadth of connections, but aimed at life/business data sources instead of infrastructure. On top of that synthesis layer, users should be able to **customize how the combined data gets visualized** — build their own views/dashboards/charts out of whatever's connected, rather than getting one fixed layout. This synthesis + customizable-visualization layer is the headline capability the rest of the feature is built around, not an add-on.

**Two versions, same base look/functionality:**

**Rob's version** — stays exactly as-is, unchanged. Includes a section for Rob's Valiant retail consignment business plus a **rental space calendar controller for a space in Murwillumbah** — this is a fixed, personal-business section specific to Rob and not part of what gets genericized for other users.

**Everyone else's version** — same look and core functionality, but:
- Section titles are customizable.
- The section that's retail-consignment-specific in Rob's version becomes, for everyone else, a **customizable system plug-in section for life admin** — connect outside systems (starting with email) and use AI-driven filtering so the user only sees what they actually want surfaced (e.g. "only show me emails that need a reply" rather than a raw inbox). Expandable to other systems people already use (calendar, banking/finance, notes, etc.), synthesizing data across whatever's connected and pushing actions/automation to help organize daily life.

**Candidate plug-ins for the life-sorting section** (starter list — connect once, AI decides what's worth surfacing, rather than the user checking a dozen native apps):
- **Email** — only shows what needs a reply/action; auto-archives newsletters/promos
- **Calendar** — merges multiple calendars, flags conflicts, suggests focus-time blocks
- **Banking/finance** — categorizes spending, flags unusual charges, surfaces upcoming bills
- **Notes/docs** (Google Keep, Notion, Apple Notes) — pulls out unresolved action items buried in notes
- **Task managers** (Todoist, Trello, etc.) — consolidates tasks from multiple tools into one prioritized view
- **Messaging** (WhatsApp, Slack, iMessage) — surfaces messages that actually need a reply vs. group-chat noise
- **Shopping/subscriptions** — tracks recurring subscriptions, flags unused ones, price-hike alerts
- **Receipts/warranties** — photo or email receipt capture, auto-sorted by category/expiry
- **Health/fitness** (Apple Health, Fitbit, etc.) — simple trend surfacing (sleep, steps) without opening the native app
- **Travel** — pulls flight/hotel confirmations out of email into one itinerary view
- **Smart home** — status/controls for connected devices, folded into the same daily-overview feel
- **Cloud storage** (Drive, Dropbox) — AI-tagged "files that need attention" (shared docs awaiting input)

**Differentiator plug-ins/features** — higher-ambition, higher-trust ideas aimed at doing things no existing personal-assistant product does, rather than incremental filtering:
- **Life Autopilot (bill/subscription renegotiation)** — Jarvis actively drafts (or, with permission, sends) renegotiation requests when a bill jumps — e.g. an insurance renewal — surfacing a comparable quote and offering to push back on the user's behalf, not just flagging the increase.
- **Cross-domain "check engine light"** — synthesizes across calendar density, spending patterns, and health/sleep data (where connected) to flag things before the user would notice themselves — e.g. correlating an empty-evening streak with rising takeout spend as an early burnout signal. No existing tool crosses domains like this; everything stays siloed.
- **Silent inbox zero with a veto window** — for routine correspondence, drafts replies in the user's voice and auto-sends after a short no-objection window unless stopped, rather than just triaging what needs a reply.
- **Contract/lease watchdog** — before the user signs a lease, service agreement, or ToS, flags unusual clauses in plain language versus standard terms.
- **Relationship memory** — tracks context about people in the user's life surfaced from messages (a friend's mentioned health issue, a partner's stressful week) and proactively nudges a follow-up.
- **Informal IOU ledger** — auto-detects "I'll pay you back" type mentions across texts/email and tracks who-owes-who without manual entry, with a one-tap settle-up link.

**Trust/autonomy design principle for the differentiator tier**: anything involving autonomous action with real-world consequences (sending money, sending emails/messages on the user's behalf, calling a provider) should start as "draft + confirm" and only earn more autonomy per-user over time — not ship with full autonomy by default. This applies specifically to Life Autopilot and Silent Inbox Zero above.

**Other specifics called out:**
- The **task section** (people you can text) should also support an **email option**, not just text.
- **Contacts**: ability to **import contact lists** and have them **searchable**.
- **Jarvis** should be able to **see all files in Morpheus** (Project Files, project context) so it can factor real project/work context into life planning — not siloed from what's happening in the builder.
- Both **Morpheus and Jarvis run on the same default AI token system** — one shared token/billing pool, not two separate metering systems.
- **Command Deck is installable as a separate standalone web app** (distinct install from the main Morpheus builder — implies PWA-style installability).
- Command Deck includes its own **token usage meter and the ability to purchase more tokens** directly from within it.

**Widget creation — how users turn synthesized data into apps/widgets for the section:**
- **Primary approach: Morpheus builds the widget.** Rather than a separate widget-builder UI, the user describes what they want in plain language to Jarvis, and that request gets handed to Morpheus's existing planner/coder pipeline to generate a small embeddable component bound to the relevant connector data feeds, then automatically installed into the user's Command Deck — no manual build step or separate UI, just the request and the result. The same "describe → build" loop Morpheus already does for full apps, just scoped down to a widget. Iterating on a widget is just talking to Jarvis again, not digging through settings.
  - **Worked example:** user says "hey, add a widget that shows my overall capability as a percentage against my calculated optimal performance." Jarvis hands this to Morpheus, which codes and installs the widget automatically. This example also demonstrates why cross-domain synthesis matters in practice — a "capability vs. optimal" score isn't answerable from any single connected source; it needs to combine things like health/energy data, calendar load, and work output to mean anything real. Good candidate for the in-product example used to explain the connection-breadth value pitch below.
  - **Feasibility check before building.** Before handing a request off to Morpheus, Jarvis should assess whether it's actually achievable given what's connected (e.g. a widget needing health data the user hasn't connected) and tell the user upfront if it isn't possible, rather than letting Morpheus attempt a build that can't work. This may mean Jarvis asks a clarifying question or two first to confirm scope/data availability before triggering the build.
  - **Quality bar on auto-built widgets.** Since these get installed automatically with no manual review step, the build pipeline for Command Deck widgets likely needs a more rigorous test-and-fix pass than a typical Morpheus build before install — catching broken widgets before they land in the user's Command Deck, not after.
  - **Revert/undo.** If an installed widget doesn't work (or the user just doesn't like it), there should be a clear, low-friction revert operation — a message with an explicit undo/uninstall button right in the chat where it was created, not a separate settings screen hunt.
- **Command Deck Marketplace (built on top of the primary approach).** Reuses the existing marketplace infrastructure (Stripe Connect, 80/20 split) already built for app templates, but scoped to **widgets and new tools for the tool section** — users can publish a widget/tool they've had Jarvis build, and other users can install or delete it from their own Command Deck to customize their setup, the same install/remove pattern as any other marketplace item.
  - **UI placement:** a dedicated marketplace button at the bottom of the main app screen, specifically for Command Deck software — this marketplace view shows **only Command Deck-compatible widgets/tools**, kept fully separate from Morpheus's main app-template marketplace so the two listings never mix.
- **"Build for Command Deck" mode in Morpheus's construct creation flow.** When starting a new construct, Morpheus should offer a Command Deck widget/tool setting/mode so it builds within the right confines from the start — i.e. Morpheus already knows the widget's expected shape, size constraints, and how it needs to bind to Command Deck's connector data, rather than generating a generic app and having to retrofit it. Once built, the user should be able to **deploy directly to their own Command Deck** (no separate manual install step) or **publish straight to the Command Deck Marketplace** for others to install.

**Why breadth of connections matters — needs explaining in-product, not just assumed.** The core pitch: *the more connections a user adds, the more powerful their life data synthesis becomes* — each new connector isn't just one more data source, it's another dimension Jarvis can cross-reference against everything else already connected. This compounding value needs to be surfaced clearly to users (e.g. in onboarding or on the connections screen itself), not left implicit.
  - **Illustrative example to use for this explanation:** with only a calendar connected, Jarvis can tell you your week looks busy. Add banking/finance on top, and it can tell you *why* your takeout spending spikes on weeks with back-to-back evening meetings. Add health data too, and it can connect that same busy-week pattern to your sleep dropping and flag it before you'd notice yourself. Each additional connection doesn't just add a fact — it lets Jarvis draw a conclusion none of the individual sources could produce alone. That's the "power" the product needs to demonstrate, ideally with a real example like this shown early rather than described abstractly.

**Jarvis uses this same synthesized dataset for its own proactive suggestions** (see the differentiator features above — Life Autopilot, cross-domain "check engine light," relationship memory, etc.) — the widgets/dashboards and Jarvis's own suggestions both draw from the same underlying synthesis layer, not two separate systems.

**Data privacy principle: minimize what Morpheus itself hosts.** This applies to the whole Command Deck/Jarvis system, not just the connected external data sources — Jarvis's own conversational memory, preferences, and working state fall under the same principle. Given the sensitivity of this data (email, banking, health, contacts, plus Jarvis's own memory of the user), the design goal is to avoid Morpheus becoming a central store of all of it. Current thinking: **Google Drive is doing the persistent-memory/storage job for now** — i.e. synthesized state and Jarvis's working memory get stored in the user's own Google Drive rather than duplicated into Morpheus's own database. Over time, users should be given **more choices of where their data lives** (other cloud storage providers, or fully local/self-hosted options), rather than being locked into one storage backend. This is a first-class design constraint for the whole product, not a detail to bolt on later — connectors and Jarvis's memory both should be designed from the start to read/write against the user's chosen storage rather than assuming a Morpheus-hosted datastore.
  - Needs deciding: exact split between what has to transiently pass through Morpheus's own infra (e.g. to call an AI model for synthesis) versus what's genuinely never stored there — likely some data has to be read into memory briefly to generate a synthesis/response even if it isn't persisted, and that distinction needs to be clear and honestly communicated to users.
  - Needs deciding: which storage providers to support first after Google Drive (Dropbox, iCloud, a local/self-hosted option) and whether this ties into the existing "new providers queue for review" pattern the same way AI/hosting providers do.

**Memory mechanism: summaries persist, full data is pulled on demand.** To keep data-hosting minimal, the pattern is: accurate summaries of connected data/context get generated and stored as the persistent memory layer (in the user's chosen storage, e.g. Google Drive), rather than full raw data being kept persistently. Morpheus and Jarvis both work primarily off these summaries day-to-day, but can pull the full underlying files/data back in for deeper context when a task actually needs it. This mirrors the pattern already used for Project.context_summary in the main Morpheus builder (a rolling summary field that avoids needing to re-process full chat history every time) — same idea, applied to Command Deck's connected life/business data.

**Needs deciding later**
- Connector breadth/architecture for the synthesis layer: mirroring Morpheus's own provider/connector pattern — additive only, same as Morpheus's provider system (new integrations get added to the list over time via an admin-reviewed step before going live; nothing already available gets removed to make room for a new one) — rather than one-off bespoke integrations per plug-in.
- Plug-in architecture for the customizable life-systems section: how new integrations (email, calendar, banking, etc.) get added over time — a defined plug-in framework vs. one-off integrations built as requested.
- Security/privacy model for connecting personal accounts (email inbox access, contact lists, financial systems) — this is a much more sensitive data surface than anything else in Morpheus so far; needs its own permissions/consent model, likely OAuth-based per service rather than storing raw credentials.
- AI filtering behavior: is the "only show what you want" filter a user-configured rule set, a natural-language preference Jarvis interprets, or both?
- Relationship between Jarvis and Morpheus at the product level — same underlying chat pipeline with a different persona/system prompt and tool access, or a genuinely separate pipeline? (Likely the former, reusing existing chat infra with a different persona + expanded tool access to Project Files.)

**Morpheus ↔ Jarvis inter-agent communication.** The two personas should be able to talk to each other directly — not just share a token pool and file access, but actually converse, with personality (witty repartee, in-character banter between the two distinct personas), and that conversation should be able to trigger real actions on either side. E.g. Jarvis notices a life-calendar conflict caused by a Morpheus build deadline and "asks" Morpheus about status; Morpheus finishing a deploy could prompt Jarvis to add a calendar entry or notify the user. The banter is the visible/fun layer; the underlying capability is cross-agent action-triggering, not just information-sharing.
  - Needs deciding: whether this is a real agent-to-agent message exchange (each persona actually invoking the other via a tool call) or a shared-context illusion (one pipeline, two personas, giving the appearance of a conversation) — the former is more powerful (real cross-triggered actions) but a meaningfully bigger build than the latter.
  - Needs deciding: how much personality/banter is user-facing vs. just flavor text around an otherwise functional handoff — worth keeping fun without it getting in the way when the user actually needs a fast answer.
  - **UI behavior confirmed:** when the two personas talk to each other, that exchange should be visible directly in whichever screen the user is currently on — i.e. if the user's in the Jarvis/Command Deck chat, the Morpheus↔Jarvis exchange shows up there; if they're in the Morpheus builder chat, it shows up there instead. Not a hidden background process — the user sees the banter/handoff happening live in whichever surface they're already looking at.
  - **Personality toggle.** Both Command Deck and Morpheus should have a setting to turn personality off — for users who want straight, functional responses (from either persona, and in their exchanges with each other) without the banter/character layer. **On by default**; users opt out rather than opt in.
- What "installable as a separate standalone web app" means technically — a PWA manifest for Command Deck specifically, separate from however the main Morpheus app is packaged/installed.
- How token usage/purchase in Command Deck reconciles with the account-level token system and billing work already planned for Morpheus proper (shared pool, so this is a UI surface onto the same balance, not a separate wallet).

---

**Integration review (2026-08-31) — reconciling this spec against everything decided since it was written.** Command Deck was speced incrementally across several sessions, before a few platform-wide decisions landed. Closing the gaps:

- **Google-only sign-in (#13) simplifies the connector list, but this was never reconciled.** Several of the "candidate plug-ins" above are Google services by default for most users — email (Gmail), calendar (Google Calendar), notes (Google Keep), cloud storage (Drive). Since sign-in is now Google-only, these can **piggyback on the same OAuth consent grant as login and the Drive storage connection (#12)** — no separate connect step for the Google-ecosystem versions of these plug-ins. Only non-Google services (banking, WhatsApp, Notion, Outlook, a second calendar provider, etc.) need their own distinct OAuth/API-key connection, the same additive pattern as everything else. This meaningfully shrinks the connector engineering for the most common starter plug-ins.
- **Command Deck's storage principle IS #12, not a parallel system — this needs to be the same mechanism, explicitly.** This section's "Data privacy principle" (Google Drive doing the persistent-memory job, summaries-persist/full-data-on-demand) was written independently and later became the basis for #12, User-Choice Cloud Storage for Project Data, generalized platform-wide. These must share **one Drive connection and one summary/pointer table**, not two separately-built storage systems that happen to look similar. Command Deck's connected life data and a user's app-building projects should live under the same storage architecture and the same connected account — worth stating this explicitly in engineering scope so it isn't accidentally built twice.
- **Jarvis inherits the exact same three-path access model as Morpheus — no separate rules.** Line 236's "shared token pool" claim now has a concrete basis: Default (pay-as-you-go), Guided Free Gemini Setup, and Full BYOK all apply to Jarvis identically. A user on the free Gemini path talking to Jarvis costs Morpheus the same $0 AI cost it costs for Morpheus-the-builder — this wasn't explicitly confirmed before and is worth stating outright rather than leaving implicit.
- **Command Deck widgets don't go through the native compile pipeline.** Priority Compile (#11's dependency) and Native Preview are about compiling/previewing real native app targets (Android, Mac, Pi images, etc.) — Command Deck widgets are lightweight embedded web components rendered inside the Command Deck shell, not standalone native apps. Worth stating explicitly so this doesn't get scoped into the compile-pipeline work by mistake; widgets stay on the same web-component build path Morpheus already uses for rapid prototypes.
- **Admin Control Panel (#8) governs Jarvis's model routing too — no separate admin surface needed.** Since AI calls run through the same shared pipeline/pool, the Admin Panel's model/margin controls apply to Jarvis's calls the same way they apply to Morpheus's. Nothing separate to build here, just worth confirming so it isn't assumed to need its own settings page.
- **New-connector research uses Morpheus's own direct capability, not a third-party API** — consistent with the Tavily-removal decision elsewhere. When Jarvis or an admin needs to research how a new life/business connector's API works before building it, that's the same in-house research capability, not a second integration with an external search service.
- **Storage-scaling risk is already closed for Command Deck's own data, by the same fix as #12.** The Operations Cost Plan flagged database/storage growth as the one real unprotected free-tier cost risk. Since Command Deck's connected data and Jarvis's memory already live in the user's own Drive (per this section's own privacy principle, now unified with #12), Command Deck doesn't introduce a *new* version of that risk — worth confirming this explicitly rather than treating it as a separate open question.

---

## 10. Jarvis Specialist Modes — profession-based advisory personas

Selectable, customizable specialist modes for Jarvis across professions — each one framed as Jarvis having lived a previous, world-class career in that field, combining strict adherence to industry-standard practice with the ability to think laterally, spot connections, and find loopholes/edge cases, blended together for optimum actionable advice. Covered by legal terms and conditions accepted at sign-in.

**Scope for now: doctors and lawyers excluded.** Medical and legal specialist modes are deliberately held back until the legalities are properly worked through (see the trademark/legal follow-up doc — worth adding this to that same conversation). Every other profession is in scope and can be built now.

**Core idea**
- Profession examples in scope: tradespeople (all trades), engineers, scientists (all types), software dev team, business/strategy, and open-ended beyond that — essentially any non-medical, non-legal profession, selectable as a mode.
- Each mode is framed as pulling from one of Jarvis's own previous world-class careers — a specialist persona Jarvis draws advice and answers from, synthesized with the user's own Command Deck data (the same synthesis layer from #9) to produce advice that's genuinely personalized to the user's actual situation, not generic professional guidance.
- Data collected through specialist-mode requests should feed back in to make Jarvis progressively better at advising that user specifically over time.
- Output should end in clear, actionable steps — not just information/analysis.
- **Focus confirmed: full step-by-step plan, always framed as "confirm before acting."** Specialist modes should give the complete, real, step-by-step plan — every step spelled out, not summarized or held back — prioritizing the best free or cheapest path where relevant, phrased in the pattern "you could do X, Y, and Z — but you must run this plan through a relevant professional before acting on it." Nothing about the plan's completeness or specificity gets softened; the professional check-in gates *acting* on it, not what Jarvis is willing to say.

**Needs deciding later**
- **Medical/legal modes remain a future decision, not a current one.** Once legal review (already flagged elsewhere) is done, revisit whether/how to add doctor and lawyer specialist modes — including the loophole-framing and liability questions already raised — rather than assuming they'll simply slot in the same way as the other professions.
- **"Find the loopholes" framing** still needs some domain-by-domain judgment even among the professions now in scope — e.g. an engineer or tradesperson mode finding a genuine edge-case/workaround is exactly the value-add, but should stop short of anything that reads as encouraging safety-code violations or regulatory circumvention.
- Mode selection UI: how a user picks/switches specialist modes, and whether multiple can be blended for one question (e.g. a question that's part-engineering, part-financial).
- How the "gets better over time from collected data" mechanism actually works technically — likely an extension of the same summary-based memory pattern already established for Command Deck (#9), scoped per specialist domain.

---

## 11. Native Preview (paid) — live preview of the real compiled build, not just the web prototype

Builds directly on top of Priority Compile (`TOKEN-SYSTEM-BUILD-PLAN.md` Step 5): once a compile runs on a Morpheus-owned VM/GitHub-org, the natural extension is letting the user **see and interact with the actual native build live**, streamed from that hosted environment — not just the existing web-based rapid-prototype preview in the workspace.

**Core idea**
- Especially valuable for targets most people can't test locally at all: a Mac app without owning a Mac, a Raspberry Pi OS image without the hardware, an Android APK without a device, a Linux distro without a spare machine.
- Paid, since it needs a live VM/emulator kept running for the duration of the preview session — a different, ongoing cost shape from a one-off compile run.
- Natural pairing with Priority Compile: a user who just paid to compile natively is the most likely person to also want to immediately see it running, rather than downloading the artifact and testing it themselves.

**Needs deciding later**
- Implementation shape by target: desktop (Windows/Mac) likely needs a streamed remote-desktop-style session to a VM; Android likely an emulator instance; Pi/Linux distro likely a VNC-style session to a container/VM running the image. Each target type needs its own preview mechanism — this isn't one uniform solution.
- Billing shape: per-minute of active preview session (mirrors real VM cost) vs. a flat per-preview-session credit charge — per-minute is more accurate to cost but adds metering complexity; flat-per-session is simpler to bill and predict.
- Session limits: auto-timeout for idle preview sessions so a forgotten-open session doesn't run (and bill) indefinitely.
- Relative priority: this is meaningfully more infrastructure than Priority Compile itself (that's a one-shot build job; this is a live, interactive, ongoing VM session) — worth treating as its own later build phase rather than bundling into the same initial Priority Compile work.

---

## 12. User-Choice Cloud Storage for Project Data — the real fix for storage-scaling risk

Generalizes the data-sovereignty pattern already agreed for Command Deck (#9) into a **platform-wide storage architecture** for all Morpheus projects, not just Command Deck's personal life data. Directly closes the one unprotected risk flagged in the Operations Cost report: database/storage growth scaling with total registered users, free and paid alike.

**Core idea**
- Users connect a cloud storage account of their choice — **Google Drive as the default flow**, other providers addable later the same additive way as the AI/hosting connector catalogs. **Simplified further, decided 2026-08-31**: since Morpheus now uses Google as the only sign-in method, the Drive connection can piggyback on the same OAuth consent screen as login itself — one Google sign-in, one consent flow, both auth and storage access granted together, rather than a separate connect step after the fact.
- Actual project data (code files, build artifacts, chat/history logs) lives in the **user's own connected storage**, not Morpheus's database — the same principle already decided for Command Deck, now applied to every project a user builds.
- Morpheus keeps only a **lightweight summary + pointer** per project in its own database — where the data lives (folder/path reference) and a working summary of its contents/state — not the full raw files. This mirrors the same summary-persists/full-data-on-demand mechanism already specced for Command Deck (`Project.context_summary` pattern) and for Command Deck's connected life data.
- When Morpheus actually needs full context (resuming a build, running the AI pipeline on a project), it pulls the real files from the user's connected storage on demand, using the summary as an index of what's there and where to look — not a blind full re-fetch every time.

**Why this matters — it doesn't just reduce a cost, it removes it the same way Guided Free Setup did for AI cost.** The Operations Cost report identified storage/database growth as the one cost line that scales with total headcount regardless of free/paid status, with no existing structural protection (unlike AI cost, which is already immune via BYOK/Guided Gemini). This closes that exact gap: if project data lives in the user's own Drive rather than Morpheus's Postgres instance, mass free-tier adoption stops being a storage-cost risk the same way it already isn't an AI-cost risk.

**Needs deciding later**
- **Simplified by the Google-only sign-in decision**: since every user now signs in with Google, Drive access can be requested in the same consent screen — but a user could still technically decline the Drive scope specifically while granting basic login access. Still need a fallback for that narrower case: does declining Drive block project creation, or is there a small default on-platform storage allowance (with the same soft quota idea from the Operations Cost recommendations) for that scenario?
- Sync/consistency: what happens if the user's Drive access is revoked, storage quota fills up, or the connection breaks mid-build — Morpheus needs a clear failure mode, not a silent break.
- Whether this becomes the default for *all* new projects going forward or an opt-in migration path for existing on-platform projects too.
- How this interacts with the compile/GitHub-push pipeline — compiled artifacts and the GitHub repo are already somewhat separate from raw project storage; worth clarifying whether Drive storage covers the working project files specifically, versus compiled outputs which already have their own home (GitHub, downloads).
- Connector breadth: same additive, admin-reviewed pattern as every other connector catalog in Morpheus — Google Drive first, others (Dropbox, OneDrive, self-hosted) added the same way over time, not built as one-off special cases. Note these alternate providers won't get the same one-consent-screen convenience Drive gets from riding on the mandatory Google sign-in.

---

## 13. Google-Only Sign-In — decided, simplifies auth (SMTP still needed for other reasons)

**Decided 2026-08-31**: Morpheus drops email/password signup entirely and uses **Google as the only sign-in method**. This removes the OTP-email problem outright, since there's no longer an email-verification flow that needs SMTP for that specific purpose — but see the resolved item below for why SMTP itself stays.

**Why this pairs well with the rest of the current build**
- Sign-in and the Drive storage connection (#12) can share a single Google OAuth consent screen — one login, both auth and storage access granted together, rather than sign-in now and a separate "connect your storage" step later.
- Consolidates identity around one provider Morpheus already needs good OAuth handling for, rather than maintaining two auth paths (Google + email/password) with different security postures.

**One real limitation, not automatable away**: Gemini API keys aren't issued through OAuth scopes — Google doesn't expose "grant this app a Gemini key" as something a consent screen can hand over. So even with Google-only sign-in, **Guided Free Setup stays a distinct, separately-guided step** (visit AI Studio, generate a key, paste it in) — sign-in and Drive get to piggyback on one flow, Gemini setup doesn't.

**Needs deciding later**
- Existing accounts that signed up via email/password before this change — migration path or grandfathering needed, not just a cutover for new signups.
- ~~Whether any account-recovery path still needs email at all...~~ **Resolved, then revised, 2026-08-31**: briefly restored as a paid SMTP need (receipts, confirmations, notifications), then resolved differently — see backlog #3, which now covers sending that email for free via browser automation on Morpheus's own Gmail account, once built. No SMTP provider needed either way.
- Countries/contexts where Google sign-in isn't accessible (e.g. blocked, or the user simply doesn't have a Google account) — worth deciding if this is an acceptable trade-off or if a second provider eventually needs adding, later, the same additive way as everything else.

---

*Add all thirteen to BUILD-PLAN.md as new phases (or fold into Phase 6/7) once ready to schedule.*
