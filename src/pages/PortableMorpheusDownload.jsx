import { useState, useEffect } from 'react';

// Portable Morpheus is ONE artifact, generated at build time from the tree that was just built —
// `scripts/build-portable-bundle.mjs`, run by `postbuild` — and served as `portable-morpheus.zip`.
//
// This page used to assemble the zip in the browser: it fetched a hand-written list of ~10 adapter
// files plus every path in `public/portable-morpheus/_source/manifest.json`, one HTTP request each,
// and zipped them with JSZip on the client. Two things were wrong with that. The mirror it read was
// generated from `base44/` — a tree untouched since 2026-08-26 — while the product had moved to
// `server/src/`, so the download faithfully shipped a superseded codebase (Rob, 2026-09-29: "we have
// lost the downloadable portable morpheus along the way somewhere"). And the whole product is ~780
// source files, which is not a thing to fetch one request at a time in a browser.
//
// The artifact is now a build product, so there is nothing to assemble here and nothing that can go
// stale: the page links the same file the build just wrote, and shows the commit it came from.
export default function PortableMorpheusDownload() {
  const [meta, setMeta] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch(`${import.meta.env.BASE_URL}portable-morpheus.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (alive && m) setMeta(m); })
      .catch(() => { /* the link still works without the size line */ });
    return () => { alive = false; };
  }, []);

  const size = meta ? `${(meta.bytes / 1048576).toFixed(1)} MB` : null;

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-background text-ink font-mono p-6">
      <div className="text-center max-w-md">
        <div className="text-lg tracking-wider neon-glow mb-2">◇ PORTABLE MORPHEUS</div>
        <p className="text-xs text-ink-strong leading-relaxed">
          The whole product — the builder <em>and</em> the Command Deck — to run on your own machine.
          Generated from the current source at build time, so what you download is the code that is
          running here right now.
        </p>
        {meta && (
          <div className="text-[11px] text-ink-max mt-2">
            {meta.fileCount} files · {size} · built from {meta.commit}
          </div>
        )}
      </div>
      <a
        href={`${import.meta.env.BASE_URL}portable-morpheus.zip`}
        download
        className="px-4 py-2 border border-primary text-primary hover:bg-primary hover:text-black text-xs font-bold tracking-wider"
      >
        DOWNLOAD PORTABLE MORPHEUS
      </a>
      {/* Said here rather than discovered after unpacking. This used to promise "no wizard, no remote
          access" — true when it was written, and false once portable:setup and portable:remote
          shipped. Copy on a public page that under-sells a shipped feature is the same claim-vs-system
          failure as one that oversells, so it now names what IS there and what is genuinely absent. */}
      <p className="text-[11px] text-ink-max max-w-md text-center leading-relaxed">
        This is the source, not a signed native app — one command sets it up, but the download is not
        notarised, so macOS will quarantine it and Windows will warn once. No AI provider is configured
        until you choose one. The bundle&rsquo;s PORTABLE-README.md lists exactly what is and is not in it.
      </p>
    </div>
  );
}
