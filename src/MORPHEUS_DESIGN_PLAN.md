# Morpheus — Design Plan

> Auto-generated from `src/lib/morpheusCapabilities.json` by `scripts/sync-capabilities.mjs`. Do not edit by hand — change the JSON and rebuild.

## Core Principle

**Full-stack software, built by chat. Shipped from your pocket.**

Morpheus turns a phone into a complete software studio. Describe what you want in plain language; Morpheus writes the real code, builds the backend, compiles a native binary, and deploys it — no laptop, no lock-in, no illusions. You own every file. Beside it, in the same account, sits Jarvis: a personal assistant with his own long-term memory, a Command Deck for the rest of your life, and a dock you can put on a website you already run. Both are being built toward a digital possibility engine — everything you tell them, brought together, so it can surface opportunities and possibilities you had not seen.

---

## What Morpheus Does

- **Chat-to-code** — Describe an app in a sentence; Morpheus writes production-ready frontend and backend code you can read, edit, and own. No pseudo-code, no placeholders.
- **Autonomous build pipeline** — A self-correcting loop: compile → run → on failure, an AI agent reads the logs, writes a fix, and recompiles — only escalating to you when it's truly stuck.
- **One chat, every target** — Compile the same project to a web app, Windows EXE, macOS app, Linux binary, Android APK, iOS app, Python package, or Arduino firmware — all from your phone.
- **Bootable OS images** — Bake your app into a Raspberry Pi image or a full PC/server Linux distro (Debian/Ubuntu/Fedora) that boots and runs your software on first start. Customise hostname, timezone, locale, SSH, and packages at build time.
- **Auto-generated backends** — Morpheus plans, writes, and deploys a backend (API, database, auth) for your app, then wires the frontend to it automatically.
- **Marketplace** — Publish your project as a paid template; browse, buy, and install others' templates in one tap. Sellers get a cut, buyers get working code.
- **Network flashing** — Push a finished OS image straight to a Pi or server over SSH — no SD-card swapping, no disk juggling.
- **GitHub, end-to-end** — OAuth in, import existing repos, push new code, and trigger remote builds via GitHub Actions — your code lives in your own account.
- **Live deploy with log-pulling** — Connect Cloudflare, Vercel, Supabase and others; Morpheus deploys and then pulls live logs back so you can watch it run.
- **AI diagnosis** — When a build or deploy breaks, an AI agent analyses the real error logs and either auto-fixes or hands you a precise, actionable next step.
- **Dependency sync** — One tap updates every dependency across npm, pip, Maven, Cargo, Go, Gem, Composer, Gradle, and PlatformIO — nested manifests included.
- **Cost transparency** — Every AI action shows its estimated compute cost in USD up front, so you always know what you're spending.
- **Perpetual project memory** — Every message you type and every file Morpheus writes is stored permanently with the construct. On each build, the full conversation history and the complete file tree are fed back in as context — so Morpheus never forgets a requirement, a decision, or a fix from earlier in the project. The more you tell him, the better he builds.
- **Searchable project history** — An important diagnostics tool. Every chat message, build log, tool action, diagnosis, and file snapshot is stored permanently and searchable end-to-end. When something breaks or a requirement drifts, search the full record to find exactly when, why, and what changed — no scrolling, no guessing.
- **Help mode** — Toggle it on and tap any feature; Morpheus explains what it does and how to use it, inline.
- **Voice** — On demand, Morpheus speaks its replies aloud — for hands-free building on the go.
- **Jarvis — the personal assistant** — Morpheus is the builder; Jarvis is the assistant — a second product in the same account, at /deck, with his own connections, his own long-term memory and his own chat history rather than a view onto Morpheus's. You talk or dictate freely and Jarvis splits what you said into separate thoughts, files each one where it belongs (tasks, money, health, home, people, growth) and keeps your original words instead of replacing them with a summary. Ask him for a synthesis and he reasons across everything he has been told; turn on Voice and he reads the reply aloud as it is being written.
- **Command Deck — a dashboard for your own life** — Jarvis's home: a configurable dashboard at /deck with 15 widgets across business, money, health, home, people and growth, with the brain-dump capture box pinned first and a permanent record behind every one. Each account sees only its own Deck, and which widgets appear, and in what order, is per account.
- **Morpheus Dock — the plugin for a site you already run** — Put Morpheus on your own website. Mint a scoped widget token, paste one script tag, and the site gets the dock: the same chat, tools, shop, SEO and traffic panels, floating over your own pages. It renders inside a shadow root, so the host site's CSS cannot bleed in or out, and it passes the page you are looking at into the chat so answers can be grounded in what is on screen. The Morpheus WordPress plugin ships the same dock and also carries Morpheus's deploys onto the live site, signed with an HMAC the plugin verifies.

---

Morpheus is not a no-code toy. It's a real dev team in your pocket — one that ships standalone, deployable software you fully own.
