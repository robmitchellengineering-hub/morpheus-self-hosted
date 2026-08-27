// Ported from base44/functions/publishTemplate/entry.ts.
import { prisma } from '../db.js';
import { logUsage, detectLanguage } from '../lib/projectUtils.js';
import { stripeFetch, encodeForm } from '../lib/stripe.js';

// Stripe requires checkout totals to convert to at least 50¢ in the
// account's settlement currency. Reject sub-minimum prices at publish time
// so buyers never hit a raw Stripe minimum-amount error at checkout.
const MIN_PRICE = 0.50;

export default async function handler({ user, body }) {
  const { projectId, tags, category, price, screenshots, icon, long_description, includeCompiledArtifacts } = body;
  const templatePrice = Math.max(0, Number(price) || 0);
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (templatePrice > 0 && templatePrice < MIN_PRICE) {
    throw Object.assign(
      new Error(`Paid templates must cost at least $${MIN_PRICE.toFixed(2)} (Stripe minimum checkout amount). Set the price to 0 to publish for free.`),
      { status: 400 },
    );
  }

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const files = await prisma.projectFile.findMany({ where: { project_id: projectId, created_by_id: user.id } });
  if (files.length === 0) throw Object.assign(new Error('No files to publish'), { status: 400 });

  // Source files always go into the listing — the marketplace has always
  // sold full source, on every listing, free or paid (that part of "sell
  // source code" already worked). `_compiled/` rows are excluded from this
  // list: their `content` is just a placeholder comment (see
  // saveCompiledArtifacts.js), not real source, so they'd be dead weight in
  // the source ZIP — the real binary is handled separately below.
  const sourceFiles = files.filter((f) => !f.path.startsWith('_compiled/'));
  if (sourceFiles.length === 0) throw Object.assign(new Error('No source files to publish'), { status: 400 });
  const filesMap = sourceFiles.map((f) => ({ path: f.path, content: f.content, language: detectLanguage(f.path) }));

  // Optional: attach the project's already-compiled binaries (from
  // saveCompiledArtifacts.js's `_compiled/*` ProjectFile rows, each with a
  // real storage `file_url`) alongside the source, for buyers who'd rather
  // download a ready-to-run build than recompile it themselves. This is
  // additive — the source above is always included either way.
  let artifactFiles = [];
  if (includeCompiledArtifacts) {
    const compiledRows = files.filter((f) => f.path.startsWith('_compiled/') && f.file_url);
    artifactFiles = compiledRows.map((f) => ({ name: f.path.replace(/^_compiled\//, ''), file_url: f.file_url }));
  }

  const template = await prisma.template.create({
    data: {
      created_by_id: user.id,
      project_id: projectId,
      name: project.name,
      description: project.description || '',
      author_name: user.full_name || user.email || 'anonymous',
      author_id: user.id,
      files: JSON.stringify(filesMap),
      artifact_files: artifactFiles.length > 0 ? JSON.stringify(artifactFiles) : null,
      compile_target: project.compile_target || 'source',
      tags: (tags || '').toString().trim(),
      category: (category || 'general').toString().trim() || 'general',
      file_count: filesMap.length,
      price: templatePrice,
      screenshots: screenshots ? JSON.stringify(screenshots) : '',
      icon: icon || '',
      long_description: long_description || '',
    },
  });

  let stripePriceId = '';
  if (templatePrice > 0) {
    try {
      const appId = process.env.BASE44_APP_ID || '';
      const product = await stripeFetch('/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeForm({
          name: project.name,
          description: (project.description || '').substring(0, 350) || undefined,
          metadata: { base44_app_id: appId, template_id: template.id },
        }),
      });
      const priceObj = await stripeFetch('/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeForm({
          product: product.id,
          unit_amount: Math.round(templatePrice * 100),
          currency: 'usd',
          metadata: { base44_app_id: appId, template_id: template.id },
        }),
      });
      stripePriceId = priceObj.id;
      await prisma.template.update({ where: { id: template.id }, data: { stripe_price_id: stripePriceId } });
    } catch (e) {
      console.error('Stripe price creation failed:', e.message);
    }
  }

  await logUsage(user.id, 'template_publish', projectId, project.name, { templateId: template.id, fileCount: filesMap.length, price: templatePrice, artifactCount: artifactFiles.length });

  return {
    templateId: template.id,
    name: template.name,
    fileCount: filesMap.length,
    price: templatePrice,
    artifactCount: artifactFiles.length,
    // Lets the publish UI tell the seller "no compiled build found" when
    // they checked the box but the project has no `_compiled/*` files yet.
    requestedArtifacts: !!includeCompiledArtifacts,
  };
}
