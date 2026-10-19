// Web App compile target — builds a static web app and packages it as a ZIP.
// Detects the framework (React, Vue, Svelte, Next, etc.) and handles SPA routing.

import {
  hasFile, parsePackageJson, detectWebFramework, detectBuildOutputDir,
  usesSPARouting, detectNodeVersion, cloneFiles
} from './utils.js';

export const webApp = {
  id: 'web-app',
  label: 'Web App',
  runner: 'ubuntu-latest',

  // What a *shipped* web app includes — surfaced to the planner/coder on
  // every build (chatWithMorpheus.js publishBlock) and shown as a checklist
  // in the PUBLISH panel. Each `check` is a heuristic run over the current
  // files to mark an item done/missing in the UI. `when: 'data'` items only
  // apply once the site collects something (a form, analytics, cookies).
  publishChecklist: [
    {
      id: 'title-meta',
      label: 'Title + meta description on every page',
      detail: 'A unique <title> and <meta name="description"> for each route — never leave "Vite App", "Document", or a placeholder.',
      check: (f) => /<meta[^>]+name=["']description["']/i.test(f.html) && !/<title>\s*(document|vite app|react app|untitled)\s*<\/title>/i.test(f.html),
    },
    {
      id: 'og',
      label: 'Open Graph + Twitter Card tags',
      detail: 'og:title, og:description, og:image (an absolute URL — a Media Library asset), og:type, and twitter:card=summary_large_image.',
      check: (f) => /property=["']og:title["']/i.test(f.html) && /property=["']og:image["']/i.test(f.html),
    },
    {
      id: 'favicon',
      label: 'Favicon + touch icon',
      detail: 'Author a small favicon.svg from the brand colour/logo (no binary needed), link it with <link rel="icon" href="/favicon.svg">, and add an apple-touch-icon.',
      check: (f) => f.paths.some((p) => /^(public\/)?favicon\.(svg|ico|png)$/i.test(p)) || /<link[^>]+rel=["'][^"']*icon/i.test(f.html),
    },
    {
      id: 'manifest',
      label: 'Web app manifest',
      detail: 'manifest.json with name, short_name, theme_color (brand primary), background_color, display:"standalone", and at least one icon; <link rel="manifest">.',
      check: (f) => f.paths.some((p) => /(^|\/)manifest\.(webmanifest|json)$/i.test(p)) || /rel=["']manifest["']/i.test(f.html),
    },
    {
      id: 'sitemap-robots',
      label: 'sitemap.xml + robots.txt',
      detail: 'sitemap.xml listing every public route; robots.txt allowing crawling and pointing at the sitemap.',
      check: (f) => f.paths.some((p) => /(^|\/)sitemap\.xml$/i.test(p)) && f.paths.some((p) => /(^|\/)robots\.txt$/i.test(p)),
    },
    {
      id: 'canonical-lang',
      label: 'Canonical URL + <html lang>',
      detail: '<html lang="…"> and a <link rel="canonical"> on every page.',
      check: (f) => /<html[^>]+lang=/i.test(f.html) && /rel=["']canonical["']/i.test(f.html),
    },
    {
      id: 'a11y',
      label: 'Accessibility baseline',
      detail: 'Semantic landmarks (header/nav/main/footer), a skip link that appears on focus, alt text on every image, a label on every input, visible focus states.',
      check: (f) => /<main[\s>]/i.test(f.html + f.jsx) && /skip[\s-]?to[\s-]?(content|main)/i.test(f.html + f.jsx),
    },
    {
      id: '404',
      label: 'Custom 404 page',
      detail: 'A 404.html (or a catch-all route) with the site nav and a link home.',
      check: (f) => f.paths.some((p) => /(^|\/)404\.html$/i.test(p)) || /path=["']\*["']|notfound|not-found/i.test(f.jsx),
    },
    {
      id: 'legal',
      label: 'Privacy + terms pages',
      when: 'data',
      detail: 'Only once the site collects data (a form, analytics, or cookies): generate /privacy and /terms from the site details, link them in the footer, and add a cookie notice if analytics or non-essential cookies are used.',
      check: (f) => /privacy/i.test(f.paths.join(' ')) && /terms/i.test(f.paths.join(' ')),
    },
  ],

  validate(files) {
    const warnings = [];
    if (!hasFile(files, 'package.json')) {
      return { valid: false, error: 'web-app target requires a package.json with a build script.', warnings };
    }
    const pkg = parsePackageJson(files);
    if (pkg) {
      if (!pkg.scripts || (!pkg.scripts.build && !pkg.scripts.dist)) {
        warnings.push(
          'package.json has no "build" script, so the build publishes the PROJECT ROOT as-is. Everything '
          + 'in it that is not excluded (source, docs, server code — anything that is not .env*, *.pem or '
          + '*.key) becomes publicly readable at the live URL. Add a "build" script that outputs to dist/ '
          + 'if that is not what you want.',
        );

        // …and because the ROOT is what gets published, this project's own SHAPE decides whether that is
        // fine. Both cases below were observed on the first real live run (2026-09-28): the deployed
        // construct held index.html AND public/index.html, so the operator had two copies of the site and
        // nothing to say which one the live URL served. Checked only on the fallback path — a project with
        // a build script publishes its output directory and none of this applies.
        const nested = ['public', 'site', 'www', 'htdocs'].find((d) => hasFile(files, `${d}/index.html`));
        if (!hasFile(files, 'index.html') && nested) {
          warnings.push(
            `There is no index.html at the project root, so the live site would have NO homepage at /. The `
            + `pages are in ${nested}/ — give the project a "build" script that outputs to dist/, or move the `
            + 'site\'s files to the project root.',
          );
        } else if (nested) {
          warnings.push(
            `This project has two copies of the site: index.html at the root and ${nested}/index.html. The ROOT `
            + `is what gets published, so changes made in ${nested}/ will NOT appear on the live site.`,
          );
        }
      }
    } else {
      warnings.push('package.json is not valid JSON — build may fail.');
    }
    return { valid: true, warnings };
  },

  scaffold(files) {
    const generated = [];
    const warnings = [];
    const augmented = cloneFiles(files);

    // Auto-generate SPA routing fallback if the project uses a router
    // and doesn't already have a hosting config
    if (usesSPARouting(augmented) &&
        !hasFile(augmented, '_redirects') &&
        !hasFile(augmented, 'vercel.json') &&
        !hasFile(augmented, 'netlify.toml')) {
      augmented.push({
        path: '_redirects',
        content: '/*    /index.html   200\n'
      });
      generated.push('_redirects');
      warnings.push('Auto-generated _redirects for SPA routing (React Router / Vue Router).');
    }

    return { files: augmented, generated, warnings };
  },

  buildSteps(files) {
    const framework = detectWebFramework(files);
    const outputDir = detectBuildOutputDir(files);
    // Use the project's declared Node version if specified (.nvmrc or
    // package.json engines.node); fall back to 20 LTS.
    const nodeVersion = detectNodeVersion(files) || '24';

    return [
      { uses: 'actions/checkout@v4' },
      {
        uses: 'actions/setup-node@v4',
        with: { 'node-version': `'${nodeVersion}'` }
      },
      {
        name: 'Cache npm',
        uses: 'actions/cache@v4',
        with: {
          path: '~/.npm',
          key: "npm-${{ runner.os }}-${{ hashFiles('package.json', 'package-lock.json') }}",
          'restore-keys': 'npm-${{ runner.os }}-'
        }
      },
      { run: 'npm install' },
      { run: 'npm run build --if-present' },
      {
        name: 'Package web app',
        run: [
          `# The PUBLISHED ROOT is the build output, not the project root, and two things were`,
          `# being got wrong by treating them as the same place (found 2026-09-28 by reading the`,
          `# chain before its first real run — a deploy would have reported success and produced a`,
          `# broken site):`,
          `#   1. \`zip -r release.zip dist\` stores \`dist/index.html\`, so the archive's root is a`,
          `#      directory and the host, which serves the archive AS the site root, serves nothing.`,
          `#   2. The SPA fallback is scaffolded at the PROJECT root, so it was never in the archive`,
          `#      at all — client-side routes would 404 on a direct visit while the homepage looked`,
          `#      fine. It has to be carried into the published root.`,
          `ROOT="$(pwd)"`,
          `OUT=""`,
          `if [ -d "${outputDir}" ]; then OUT="${outputDir}"; elif [ -d dist ]; then OUT="dist"; elif [ -d build ]; then OUT="build"; fi`,
          `if [ -n "$OUT" ]; then`,
          `  if [ -f "$ROOT/_redirects" ] && [ ! -f "$OUT/_redirects" ]; then cp "$ROOT/_redirects" "$OUT/_redirects"; fi`,
          `  (cd "$OUT" && zip -r "$ROOT/release.zip" .)`,
          `else`,
          `  # No build output: the project root IS the site, so it is zipped as-is — but not`,
          `  # everything in it. This archive is published to the open internet, and the project`,
          `  # root is where a project's .env lives (dotenv is a normal dependency): publishing`,
          `  # it would serve the operator's secrets at /.env. Backend source, compiled artifacts,`,
          `  # platform bookkeeping and CI config are not site content either.`,
          `  zip -r release.zip . -x "node_modules/*" -x ".git/*" -x "release.zip" -x "_compiled/*" -x "backend/*" -x ".morpheus/*" -x ".github/*" -x ".env*" -x "*.pem" -x "*.key"`,
          `fi`,
          `test -f release.zip || { echo "No web build output found"; exit 1; }`
        ].join('\n')
      }
    ];
  },

  artifact: {
    glob: 'release.zip',
    isGlob: false,
    artifactName: 'web-app.zip',
    verifyCommand: 'test -f release.zip || { echo "No release.zip produced"; exit 1; }'
  }
};

export default webApp;
