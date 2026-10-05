import { Link } from 'react-router-dom';
import { Download, ArrowLeft, ShieldCheck, BookOpen, Store, Boxes, HardDrive } from 'lucide-react';
import { MORPHEUS_DOWNLOADS } from '@/lib/morpheusCapabilities';

// Everything downloadable, in one place.
//
// WHY THIS PAGE EXISTS. Rob, 2026-10-05: *"if we have standalone versions of the plugin and the other
// formats where are they available for download"* — and there was no answer. A user compiled a plugin into
// their own project; the repo's rigs kept 7-day artifacts. Nothing on the site offered a file. A visitor
// whose reasonable next move is "show me one" had nowhere to go, which is the kind of gap that costs a sale
// quietly rather than loudly.
//
// ⚠️ AND THE HARD PART IS NOT THE LIST, IT IS THE DISTINCTION THE PAGE HAS TO MAKE. Almost nothing Morpheus
// produces is a download from us: it is built inside the user's OWN repository and lands in `_compiled/` in
// their OWN project. A downloads page that blurred that would be selling a builder as a shop, and the
// difference — the file is yours, in your account, from your source — is the whole product. So the page
// states it in as many words rather than leaving it to be inferred from a missing entry.
//
// The list itself lives in `morpheusCapabilities.json` with the capability list, for the same reason that
// one does: the page, the sitemap and llms.txt are generated from it, and a page that drifted from the
// machine-readable brief is exactly the drift `scripts/verify-seo-static.mjs` exists to catch.

/** An icon per entry, chosen by what the thing IS rather than by its position in the list. */
const ICONS = { 'Portable Morpheus': HardDrive, 'The user manual': BookOpen, 'Audio plugin — demo builds': Boxes, 'Marketplace templates': Store };

export default function Downloads() {
  const d = MORPHEUS_DOWNLOADS;
  if (!d) return null;

  return (
    <div className="min-h-screen bg-background matrix-bg p-4 sm:p-6">
      <div className="max-w-2xl mx-auto py-6">
        <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-primary/50 hover:text-primary font-mono tracking-wider mb-6">
          <ArrowLeft size={12} /> BACK
        </Link>

        <div className="border border-primary/40 bg-black/60 p-4 sm:p-5 shadow-[0_0_20px_rgba(0,255,65,0.15)]">
          <p className="text-[10px] text-primary/50 tracking-[0.2em] font-display flex items-center gap-1.5">
            <Download size={12} /> // {d.title.toUpperCase()}
          </p>
          <h1 className="text-ink font-display tracking-wide text-lg mt-2">{d.title}</h1>
          <p className="text-xs text-ink-strong leading-relaxed mt-2">{d.intro}</p>

          <ul className="mt-5 space-y-3">
            {d.items.map((it) => {
              const Icon = ICONS[it.name] || Download;
              // A route is an SPA link; an absolute URL is somebody else's page (the release) and must be a
              // plain anchor, or the router would take it and 404.
              const external = /^https?:/i.test(it.href);
              const body = (
                <>
                  <span className="text-primary font-display tracking-wider flex items-center gap-1.5">
                    <Icon size={13} /> {it.name}
                  </span>
                  <span className="text-[10px] text-primary/50 tracking-wider font-mono block mt-0.5">{it.platform}</span>
                  <span className="text-xs text-ink-strong leading-snug block mt-1.5">{it.what}</span>
                  <span className="text-[10px] text-ink-max leading-snug block mt-1.5">{it.note}</span>
                </>
              );
              return (
                <li key={it.name}>
                  {external
                    ? <a href={it.href} target="_blank" rel="noreferrer" className="block border border-primary/25 hover:border-primary/60 p-3 transition-colors">{body}</a>
                    : <Link to={it.href} className="block border border-primary/25 hover:border-primary/60 p-3 transition-colors">{body}</Link>}
                </li>
              );
            })}
          </ul>

          {/* The distinction, said outright. It is the sentence that keeps this page honest. */}
          <div className="border-t border-primary/20 mt-5 pt-3">
            <p className="text-[10px] text-primary/50 tracking-[0.2em] font-display flex items-center gap-1.5">
              <ShieldCheck size={12} /> // {d.ownHeading.toUpperCase()}
            </p>
            <p className="text-xs text-ink-strong leading-relaxed mt-2">{d.own}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
