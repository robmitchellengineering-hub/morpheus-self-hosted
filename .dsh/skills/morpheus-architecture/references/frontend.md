# Frontend: React SPA and the Command Deck PWA

Provenance note: the audit artifact for this area was lost to a harness truncation, so this file
was written from **direct source review** of `morpheus-self-hosted` at commit `509d2ce`
(2026-09-19), not from the audit. Line numbers are from that commit.

## App structure

- Entry `src/main.jsx` imports `@/App.jsx` and `@/index.css`; there is **no** `React.StrictMode`
  wrapper. Before paint it applies the theme from localStorage keys `morpheus_theme` and
  `morpheus_boring_mode` onto `<html>` (`main.jsx:12-17`).
- `src/App.jsx` (default export `App`, :190-227) nests providers in this order, outer to inner:
  `ThemeProvider` → `AuthProvider` → `HelpModeProvider` → `QueryClientProvider` →
  `GithubConnectionProvider` → `GoogleDriveConnectionProvider` → `Router` → `ScrollToTop` +
  `RootErrorBoundary` → `AuthenticatedApp` (:204-213). `Toaster` and `InsufficientCreditsModal`
  sit inside `GoogleDriveConnectionProvider` but **outside** `RootErrorBoundary` (:216-217).
- Router is `BrowserRouter` with `react-router-dom` `^6.26.0` (`App.jsx:5`, `package.json:73`) —
  no `createBrowserRouter`/data router.
- `AuthenticatedApp` (:54-93): `isEmbed = pathname === '/embed'`, `isDeck = pathname.startsWith('/deck')`;
  a full-screen spinner while auth/public-settings load (suppressed for `/embed`); renders
  `AnimatedRoutes` plus `MobileTabBar` unless embed or deck.
- `AnimatedRoutes` (:122-187) is one `<Suspense>` around `<Routes>`, with a `key={location.pathname}`
  wrapper carrying `.route-fade`. 23 pages are `React.lazy`-loaded (:21-47); `ProtectedRoute` and
  the auth pages are eager.
- `RootErrorBoundary` (`src/components/RootErrorBoundary.jsx:12-66`) is a class component with an
  inline-styled fallback and a Reload button.
- There is **no `src/Layout.jsx`** even though `jsconfig.json:19` and `eslint.config.js:18`
  reference it — dead config path.

## Routing

The route table is `App.jsx:132-183`.

Unguarded: `/` Landing, `/market` Market, `/store/:templateId` StoreItem, `/terms`, `/privacy`,
`/refund-policy`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/auth/callback`,
`/embed` (widget surface), `/stats/alice`, and `/connect` (deliberately outside `ProtectedRoute` —
see the comment at :147-150).

Authenticated group — `<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />}>`
(:152): `/workspace`, `/workspace/:projectId`, `/architect`, `/portable-morpheus`, `/settings`, and
the nested Deck group `/deck` with children `index` (DeckHome), `jarvis`, `tools`, `settings`
(:164-168).

Admin group — `<ProtectedRoute unauthenticatedElement={<Navigate to="/" replace />} adminOnly>`
(:171): `/backend-docs`, `/rebuild-blueprint`, `/screenshots`, `/flow-diagram`, `/ai-docs`,
`/updates-plan`, `/cost-tracker`, `/self-dev`, `/admin`.

Catch-all `*` → `PageNotFound` (:182).

`src/pages/OAuthConsent.jsx` exports a component that **no file imports and no route references** —
an orphan (possibly a leftover Base44 surface).

## `ProtectedRoute` (`src/components/ProtectedRoute.jsx`)

Props `{ fallback = <DefaultFallback/>, unauthenticatedElement, adminOnly = false }` (:12).
Order of decisions:

1. While `isLoadingAuth || !authChecked` → render `fallback` (a non-theme-aware spinner, :6-10, 21-23).
2. `authError` → `UserNotRegisteredError` when `type === 'user_not_registered'`, else
   `unauthenticatedElement` (:25-30).
3. Not authenticated → `unauthenticatedElement` (:32-34).
4. `if (adminOnly && user?.role !== 'admin') return unauthenticatedElement` (:36-38).
5. Otherwise `<Outlet/>` (:40).

It never redirects imperatively and never toasts — it just renders whatever `Navigate` the caller
passed. So "unauthorized" for a non-admin route lands on `/login`, and for an `adminOnly` route
lands on `/`.

`MobileTabBar` (`src/components/matrix/MobileTabBar.jsx`) hides itself on `/`, `/login`,
`/register`, `/forgot-password`, `/reset-password` (:37) and remembers the last path per tab in
`morpheus.tab.<to>.lastPath`.

## Auth

`src/lib/AuthContext.jsx` owns session state.

- `useAuth()` throws outside the provider (:87-93). Context value (:69-81): `user`,
  `isAuthenticated`, `isLoadingAuth`, `isLoadingPublicSettings` (hardcoded `false`),
  `authError`, `appPublicSettings` (fixed `{id:'self-hosted', public_settings:{}}`),
  `authChecked`, `logout`, `navigateToLogin`, `checkUserAuth`, `checkAppState`.
- `checkUserAuth` (:24-48): with no stored token it returns unauthenticated with **no network
  call**; otherwise `base44.auth.me()`. A thrown error becomes `authError = {type:'auth_required'}`
  **only** when `error.status === 401 || 403` (:41-43).
- 401 handling is centralized **only** here plus `AuthenticatedApp` calling `navigateToLogin()`
  (`App.jsx:79-83`). `apiFetch` attaches `.status` but there is no global 401 interceptor.
- `base44.auth` surface (`src/api/base44Client.js:303-348`): `me()` GET `/auth/me` →
  `{user}`; `loginViaEmailPassword` POST `/auth/login` → `{token,user}` (stores the token);
  `register({email,password,full_name})` POST `/auth/register`; `verifyOtp({otpCode})` POST
  `/auth/verify-otp` body `{code}` (the token does **not** rotate — it returns the existing one);
  `resendOtp()` POST `/auth/resend-otp` takes no args even though `Register.jsx:60` passes the
  email; `resetPasswordRequest`/`resetPassword`; `logout(redirectUrl)` clears the token then
  `window.location.href = redirectUrl`; `redirectToLogin(returnTo)` → `/login?returnTo=`;
  `loginWithProvider('google', returnTo)` → `${API_BASE}/auth/google/start?returnTo=` (throws for
  any other provider); device flow `getDevicePending`/`approveDevice`/`denyDevice`.
- Token storage is localStorage key `morpheus_token` (`TOKEN_KEY`, :35; helpers :44-54). An
  in-memory `overrideToken` set via `setOverrideToken` wins in `getToken()` (:41-47) and is used
  only by the `/embed` widget surface with a `wgt_` token. There are **no auth cookies**.
- Google sign-in is gated at build time by `import.meta.env.VITE_GOOGLE_AUTH_ENABLED !== 'false'`
  (`Login.jsx:44`, `Register.jsx:75`) — on unless explicitly disabled.
- `src/lib/authReturnTo.js` centralizes `safeReturnTo()`: same-origin check, strips Base44
  bootstrap params, rejects `//` and backslashes (:11-33).
- `src/lib/app-params.js` still carries legacy Base44 bootstrap params (`base44_app_id`,
  `base44_access_token`, `base44_functions_version`, `base44_app_base_url`, prefix `base44_`) with
  a `clear_access_token=true` cleanup path — vestigial but live.
- Connection (not session) state lives in `src/contexts/GithubConnectionContext.jsx` (phases
  `idle|starting|awaiting|connecting|error`, poll interval `(max(2,interval)+1)*1000`, terminal
  `expired|denied`, transient backoff) and the Google Drive / Deck Google contexts. Both probe
  only after `base44.auth.isAuthenticated()`.

## API client (`src/api/base44Client.js`)

- Runtime API base, **not** build-time: `resolveApiBase()` precedence is `?api_base=` query param
  (persisted to localStorage, trailing slashes stripped) → localStorage `morpheus_api_base` →
  `import.meta.env.VITE_API_BASE_URL || '/api'` (:18-32). `const API_BASE = resolveApiBase()` is
  computed **once at module load** (:34), so changing `?api_base=` requires a reload. No window
  global is involved.
- `apiFetch(path, opts)` (:73-124): JSON-stringifies non-string bodies unless `FormData`; sets
  `Content-Type` and `Authorization: Bearer <token>`; aborts at `API_FETCH_TIMEOUT_MS = 210000`
  (:71); a timeout carries `.status = 0`, `.code = 'CLIENT_TIMEOUT'`.
- **Error contract** (:98-104): non-OK tries `res.json()`, sets
  `err.message = data.error || res.statusText || 'Request failed (N)'`, `err.status = res.status`,
  `err.data = data`. When `data.code === 'INSUFFICIENT_CREDITS'` it dispatches a
  `morpheus:insufficient-credits` CustomEvent on `window` with `{needed, available, message}`
  (:111-117); `src/components/matrix/InsufficientCreditsModal.jsx` listens for it.
- Response handling: `204` → `null`; `application/json` → `res.json()`; otherwise `res.blob()`.
- Entity CRUD `makeEntity(name)` (:135-146): `list(sort,limit)`, `filter(query,sort,limit)`,
  `get(id)`, `create`, `update`, `delete`, `deleteMany(query)` → `/bulk-delete`,
  `bulkCreate(items)` → `/bulk-create`. `ENTITY_NAMES` (:148-157) lists the 15 non-Deck entities
  plus the Deck entities; note **`DeckJarvisMemory` is absent client-side** even though the
  `morpheus-deck` skill mentions it.
- `functions.invoke(name, body)` POSTs `/functions/<name>` and returns an axios-style `{data}`
  (:252-256).
- `functions.invokeStream(name, body, onStage)` (:180-247): POSTs the same path, parses NDJSON
  incrementally with `res.body.getReader()` + `TextDecoder({stream:true})`, routes
  `evt.type === 'stage'` to `onStage` and keeps `result`/`error` as the final event, flushes a
  trailing partial line, and throws `'Connection closed before Morpheus finished responding.'` when
  no terminal event arrives. Non-OK responses reproduce the `apiFetch` error shape and the
  credits event (:187-201).
- `integrations.Core.UploadFile({file})` POSTs multipart `/uploads` (:267-275).
- `base44.admin.*` (:354-378) wraps `/admin/*`: overview, settings, model catalog, audit log,
  Northflank status/logs/restart, `runDbQuery(sql, confirm)`, Stripe health, freshness,
  billing-exempt.

## Data-fetching conventions

- `@tanstack/react-query` v5 is a dependency and `QueryClientProvider` is mounted
  (`App.jsx:207`; `src/lib/query-client.js:4-11`, `refetchOnWindowFocus:false`, `retry:1`), but
  the **only** `useQuery` in all of `src/` is `PageNotFound.jsx:10-11` (`queryKey:['user']`).
  There are zero `useMutation` and zero `invalidateQueries` calls — treat react-query as
  vestigial.
- The dominant pattern is `useState` + `useEffect` + `base44.entities.*` / `base44.functions.invoke`.
  Canonical example `src/hooks/useWorkspace.js`: `Project.list('-created_date', 50)`,
  `ProjectFile.filter({project_id}, 'path')` with `backend/` and `external/` prefixes filtered
  out, `ChatMessage.filter({project_id}, '-created_date', 100)` then reversed for chronological
  display, `FileSnapshot.filter(..., '-created_date', 50)`.
- **Sort/limit semantics worth knowing**: a leading `-` means descending; a positive `limit` with
  an **ascending** sort returns the OLDEST N rows, not the newest (documented at
  `useWorkspace.js:55-63`).
- Mutations are optimistic: local state first, then the network call, with rollback and rethrow on
  failure (`deleteProject`, `useWorkspace.js:117-132`; widespread in the Deck context).
- Debounced writes use `debouncedSave(key, fn, delay = 600)` (`CommandDeckContext.jsx:128-132`).
- Polling is manual: `pollWidgetBuild` re-arms every 5000 ms until the build status leaves
  `['done','failed']` (`CommandDeckContext.jsx:251-268`).
- Streaming consumer: `useWorkspace.sendMessage` calls
  `invokeStream('chatWithMorpheus', {projectId, message, fileUrls, focusPaths, mode, webAccess}, onStage)`
  and builds `pipelineStages` entries from stage events; a dropped connection reloads the last
  100 `ChatMessage` rows and only retries if no newer morpheus reply landed.

## UI and state conventions

- shadcn/ui, style `new-york`, `tsx:false`, baseColor `neutral`, `cssVariables:true`
  (`components.json`); Radix primitives; `lucide` icons. ~50 primitives in `src/components/ui/`.
- `cn()` = `twMerge(clsx(inputs))` (`src/lib/utils.js:4-6`).
- Tailwind 3.4.17 with `darkMode: ['class']` and `content: ['./index.html','./src/**/*.{ts,tsx,js,jsx}']`
  (`tailwind.config.js:3-4`). **`deck.html` is deliberately not in `content`.** Colors/fonts/keyframes
  all map CSS variables; `tailwindcss-animate` is the only plugin.
- The real stylesheet is `src/index.css` (349 lines), with variable blocks for `:root`,
  `.dark`, `[data-theme="classic"]`, `[data-theme="boring"]`, and
  `[data-theme="boring"][data-boring-mode="light"]`, plus app utilities (`.route-fade`,
  `.neon-glow`/`.neon-border`, `.scrollbar-matrix`, `.safe-*`, `.min-h-dvh`).
- Theme context `src/contexts/ThemeContext.jsx`: `morpheus_theme` with
  `VALID_THEMES = ['clear','classic','boring']` and `morpheus_boring_mode` with
  `['dark','light']`; `useTheme()` never throws.
- Repo-root `styles.css` is **not imported by the app** — it exists as the design-system
  stylesheet injected into generated projects (referenced from `src/lib/aiFunctionsData.js`).
- Toasts: shadcn's store-based `use-toast` + `<Toaster/>`; only `Register.jsx` and the
  insufficient-credits modal consume it. `sonner` is a dependency with an unmounted wrapper and
  `react-hot-toast` is never imported. The practical convention is inline error `<div>` bound to
  local state.
- Modals: Radix `dialog`/`sheet`/`alert-dialog` in the main app. Command Deck instead hand-rolls
  fixed-overlay divs and a callback-based confirm (`askToDelete`/`resolveConfirmDelete` plus
  `randomDeleteConfirmPhrase()` in `deckConstants.js:103-157`).

## Command Deck PWA

- `deck.html` is a **second HTML entry for the same SPA** (it loads `/src/main.jsx`), with an
  inline initial loader, `theme-color #241A12`, and `<link rel="manifest" href="/deck-manifest.json">`.
- `public/deck-manifest.json`: name/short_name "Command Deck", `start_url:"/deck"`,
  `scope:"/deck"`, `display:"standalone"`, portrait, single `/deck-icon.svg`.
- Path routing to it: Netlify `public/_redirects` maps `/deck` and `/deck/*` to `/deck.html` 200,
  with a catch-all `/* /index.html 200`; Vite dev gets the same via the `deckHtmlDevMiddleware`
  plugin (`vite.config.js:23-34`); the build emits both entries
  (`build.rollupOptions.input = { main: index.html, deck: deck.html }`, :46-53).
- **There is no service worker anywhere.** No `navigator.serviceWorker.register`, no `public/sw.js`,
  no workbox. "PWA" here means manifest + install prompt only; there is no offline cache.
- Install UX: `src/hooks/usePwaInstall.js` listens for `beforeinstallprompt`/`appinstalled` and
  exposes `{canInstall, installed, promptInstall}`; consumed by `Landing.jsx` and
  `DeckSettings.jsx` (which falls back to "use Add to Home Screen").
- Deck surface in the SPA: `/deck` → lazy `CommandDeck` default-exporting `CommandDeckLayout`,
  which wraps `CommandDeckProvider` → `DeckGoogleConnectionProvider` and renders header, `<Outlet/>`,
  lightbox, delete-confirm overlay, welcome modal and `DeckTabBar`. Tabs are `/deck`,
  `/deck/jarvis`, `/deck/tools`, `/deck/settings`. `MobileTabBar` is suppressed on `/deck*`.
- Widgets: registry `DECK_WIDGETS` (16 entries) in
  `src/pages/CommandDeck/deckWidgets.js`; `DeckHome.jsx` discovers widget modules with
  `import.meta.glob('./widgets/*.jsx', { eager: true })`, maps filename to key, and renders
  enabled instances by `sort_order`. 16 widget files exist.
- `src/contexts/CommandDeckContext.jsx` (958 lines) owns ~17 entity lists and every Deck mutation;
  it loads them in one `Promise.all` and lazily seeds defaults for empty accounts. Deck server
  functions it calls include `classifyDeckDumpItem`, `syncMurbahBooking`, `listMurbahCalendarEvents`,
  `syncDeckGmailInbox`, `suggestDeckReply`, `sendDeckEmailReply`, `backupDeckToDrive`,
  `restoreDeckFromDrive`, `deleteDeckWidget`, `listUpcomingDeckEvents`, `addDeckCalendarEvent`,
  `chatWithJarvis`, `runJarvisSynthesis`, `createDeckDocument`.
- Deck styling note: `CommandDeck/index.jsx` sets `document.documentElement.dataset.theme = 'deck'`,
  but **no `[data-theme="deck"]` CSS block exists** — Deck colors come from the inline token object
  `C` in `deckConstants.js:10-24` (tweed, paper, ink, walnut, brass, gold, alert).

## Build config

- `vite.config.js`: plugins `[react(), deckHtmlDevMiddleware()]`; aliases `@` → `./src` (mirrored in
  `jsconfig.json`); `define.__APP_BUILD_TIME__`; multi-entry build; dev proxy `/api` and `/uploads`
  to `process.env.VITE_BACKEND_URL || 'http://localhost:4500'`. No `outDir`, `base` or `envPrefix`
  override.
- Root `package.json` scripts: `dev: vite`; `prebuild: node scripts/sync-capabilities.mjs && node scripts/pack-wp-plugin.mjs`;
  `build: vite build`; `lint: eslint . --quiet`; `typecheck: tsc -p ./jsconfig.json`;
  `preview: vite preview`. **No `postbuild`.**
- `prebuild` (runs automatically before `npm run build`) regenerates `src/MORPHEUS_DESIGN_PLAN.md`
  from `src/lib/morpheusCapabilities.json` (hazard H3) and packs the WordPress plugin zip plus
  `public/plugin-manifest.json`.
- `eslint.config.js` lints only `src/components/**`, `src/pages/**`, `src/hooks/**` and the
  nonexistent `src/Layout.jsx`; it ignores `src/lib/**` and `src/components/ui/**`. Because
  `npm run lint` passes `--quiet`, `react-hooks/exhaustive-deps` (configured `warn`) never fails
  the build, while `react-hooks/rules-of-hooks` is `error`.
- `jsconfig.json` includes only `src/components/**/*.js`, `src/pages/**/*.jsx` and `src/Layout.jsx`,
  and excludes `src/lib`, `src/api`, `src/components/ui`, `src/vite-plugins` — so
  `npm run typecheck` skips the API client and lib.
- Frontend env vars: `VITE_API_BASE_URL` (default `/api`), `VITE_GOOGLE_AUTH_ENABLED`,
  `VITE_BASE44_APP_ID`, `VITE_BASE44_FUNCTIONS_VERSION`, `VITE_BASE44_APP_BASE_URL`;
  `VITE_BACKEND_URL` is consumed at config time by Vite, not exposed to the client. Root `.env*`
  is gitignored, so these are unset unless the deploy injects them.

## Load-bearing invariants

1. `API_BASE` is resolved once at module load — a different API base needs a reload.
2. The runtime overrides are `?api_base=` and localStorage `morpheus_api_base`; there is no build-time
   API base in production.
3. `ProtectedRoute` renders the caller's element; it does not redirect or toast on its own.
4. Admin gating is exactly `user.role === 'admin'` and is a **UI** guard only — the server
   re-checks (`ADMIN_FUNCTIONS`, `requireAdmin`).
5. `invokeStream` requires a terminal `result`/`error` event or it throws.
6. `/deck` is routed by Netlify `_redirects` and the Vite dev middleware, not by the SPA router alone.

## Risks and discrepancies

- **`nginx.conf` has no `/deck` rule** (`try_files $uri $uri/ /index.html`), so a Docker/nginx-served
  `/deck` falls back to `index.html` and the main Morpheus manifest, not `deck.html`. Deck's entry is
  wired only for Netlify and Vite dev.
- **No service worker** means no offline behaviour and possibly no install prompt on browsers that
  require one; not verifiable from source.
- **The Docker frontend image removes `base44/` before the Vite build**
  (`Dockerfile:10` runs before `Dockerfile:11`), while `src/components/matrix/BackendPanel.jsx:13`
  imports `../../../base44/shared/infrastructureComponents` at bundle time. Whether
  `docker compose up --build` still builds the frontend is unverified.
- `npm run lint` does not cover `src/App.jsx`, `src/main.jsx`, `src/api/**`, `src/contexts/**`,
  `src/lib/**`, or `src/components/ui/**`; `npm run typecheck` skips `src/lib` and `src/api`.
- `react-query` is mounted but unused, so there is no cache invalidation convention — stale lists
  after a mutation are the default unless a component refetches.
- `.dsh/skills/morpheus-deck/SKILL.md` is stale: it still says `/deck` is admin-gated and lists the
  Jarvis "Get suggestions" synthesis card as unbuilt, but `/deck` is now in the ordinary
  authenticated group (`App.jsx:158-169`) and the synthesis card is implemented.

## Open questions

- The full server-side `/auth/me` user shape (only `role` is relied on by the UI).
- Which `VITE_*` values the Netlify/Northflank production builds set.
- Whether target browsers require a service worker for `beforeinstallprompt`.
- The intended route for the unreferenced `src/pages/OAuthConsent.jsx`.
- Whether the Docker/nginx frontend is actually used in production given the `/deck` fallback gap.
