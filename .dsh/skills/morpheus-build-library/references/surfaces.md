# Surfaces — which Morpheus am I looking at?

Read this when a request names a screen ("the SEO tab in the plugin"), when a fix
seems not to have reached the user, or before adding a panel or a tab.

**The map is generated, not written here.** `node scripts/context.mjs` prints a
SURFACES section with each surface's entry file, its tabs, which components two
surfaces share, and the WordPress plugin's asset count. Paths and counts rot;
that generator does not. Read it before this card.

## The four surfaces

| When the operator says… | They mean | How to tell you are there |
|---|---|---|
| "in the app", "the website panel" | the app's WEBSITE panel | it has SETUP and EMBED tabs; they are logged into Morpheus |
| "in the plugin", "on my site" | **the dock** — the loader Morpheus serves, dropping the panel onto their own pages | they are logged into wp-admin looking at their own site; there is a floating button |
| "the WordPress plugin" as a thing to install or update | the plugin directory under `wp-plugin/` | it ships no interface at all — if you are hunting for a tab inside it, you are in the wrong place |
| "the deck", "Jarvis" | the Command Deck | a personal life-assist dashboard, not the site |

## The trap that already cost a session

**The dock loader and the WordPress plugin are unrelated files that both get
called "the plugin".** One is a script Morpheus serves to the site; the other is
the plugin that answers signed requests from Morpheus. A session asked to fix
"the SEO tab in the WordPress plugin" went looking in `wp-plugin/`, found no
interface — because there is none — and reported the work as misplaced while the
operator was in the dock the whole time.

If a request names a screen you cannot find, ask which surface before concluding
the feature does not exist. Two of the four have no tabs at all, and one of those
two is the one whose name invites the mistake.

## Shared components, and why one fix appears in two places

The dock and the app panel mount the **same** tab components. A fix to a tab is
therefore a fix in both surfaces, and a bug report from either describes the same
code. That holds only while nobody forks them: section 11 of
`scripts/verify-context.mjs` fails if the dock gains a `*Tab` component the app
panel does not have. A genuinely dock-only tab is fine — that check is the prompt
to make the decision deliberately instead of drifting into a second panel.

## Chrome the dock does not have

Connecting the site, editing the theme's files and minting an embed token are
app-panel only: none of them can live on a surface that only exists once the site
is already connected. Expect them to be missing from the dock, and do not "fix"
that asymmetry.

## Scope gating

Dock tabs render only for the scopes the widget token carries. A missing tab is
almost always a missing scope rather than a missing feature — check the token
before the code, and remember a token's scopes can be edited without reissuing
the token or touching the snippet already pasted on the site.
