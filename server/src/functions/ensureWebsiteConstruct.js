// Find (or make) the construct a website runs from — the one the WordPress
// onboarding works in.
//
// WHY THIS IS A FUNCTION AND NOT A BUTTON THAT CREATES A PROJECT:
// "open a construct straight away" has to mean the SAME construct every time.
// A client that creates one on each visit leaves a trail of empty constructs,
// and two taps in quick succession (which a phone does) race each other. The
// decision — is there already a website construct for this account? — belongs
// where the answer can be given once.
//
// It is deliberately NOT wired into sign-up: this flow is specifically for
// people whose WordPress site Morpheus is going to operate, and everyone else
// should keep arriving at an empty Matrix with nothing invented for them.
import { prisma } from '../db.js';

/** A default name from the account, so the first thing they see is theirs. */
export function defaultWebsiteName(fullName, email) {
  const first = String(fullName || '').trim().split(/\s+/)[0];
  if (first) return `${first}'s website`;
  const local = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  if (local) return `${local.charAt(0).toUpperCase()}${local.slice(1)}'s website`;
  return 'My website';
}

export default async function handler({ user, body }) {
  if (!user?.id) throw Object.assign(new Error('Sign in first.'), { status: 401 });

  // The most recently touched website construct, if there is one. web-app is
  // the compile target that switches on the WEBSITE panel (Publish, Forms,
  // Domain, Content and Website are all gated on it), so it is the only target
  // this flow can use — a 'source' construct would land the operator in a
  // workspace with no way to connect a site at all.
  const existing = await prisma.project.findFirst({
    where: { created_by_id: user.id, compile_target: 'web-app' },
    orderBy: { updated_date: 'desc' },
    select: { id: true, name: true, description: true, github_repo: true, compile_target: true },
  });

  if (existing) {
    return { project: existing, created: false };
  }

  const name = String(body?.name || '').trim() || defaultWebsiteName(user.full_name, user.email);
  const project = await prisma.project.create({
    data: {
      name,
      description: 'A website managed through Morpheus.',
      created_by_id: user.id,
      status: 'init',
      compile_target: 'web-app',
      project_type: 'frontend',
    },
    select: { id: true, name: true, description: true, github_repo: true, compile_target: true },
  });

  return { project, created: true };
}
