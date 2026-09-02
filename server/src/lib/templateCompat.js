// Defensive compatibility layer for Template.artifact_files.
//
// schema.prisma has this column, and browseTemplates.js/getSellerStats.js/
// getPublicTemplate.js/installTemplate.js/downloadTemplate.js/
// publishTemplate.js all reference it — but a Northflank deploy only runs
// `prisma generate`, never a migration (see server/prisma/
// add-template-artifact-files-column.sql, a one-time SQL file that has to
// be run by hand against the real Supabase DB). If that migration hasn't
// been run yet in a given environment, any Prisma call on Template that
// implicitly selects every column (a plain findMany/findFirst/create with
// no `select`) throws "column templates.artifact_files does not exist"
// instead of the query just working — the exact same class of bug as the
// earlier UserSettings.personality_enabled outage (a schema field shipped
// ahead of its migration), just on a different table. That broke
// Marketplace browsing (raw Prisma error rendered inline), the EARN panel
// (silently blank — getSellerStats' fetch failed and the empty-state copy
// is easy to miss), and publishing itself (create() always writes this
// field, even as null, so every publish attempt failed regardless of
// whether the seller checked "attach compiled build").
//
// Real fix: run add-template-artifact-files-column.sql once. This module
// is the defensive backstop so that a schema field shipped ahead of its
// migration degrades to "no attached artifacts yet" instead of a hard
// crash — here and for any future field added to Template the same way.
export function isMissingArtifactFilesColumn(err) {
  return !!err && typeof err.message === 'string' &&
    /column\s+.*templates\.artifact_files.*does not exist/i.test(err.message);
}

// Every real Template column except artifact_files — used to retry a
// failed read with an explicit select once the column is confirmed
// missing, so a pre-migration environment still serves working listings
// (just with no compiled-artifact attachment, which is correct: nothing
// could have one until the column exists to write it into).
export const TEMPLATE_SELECT_WITHOUT_ARTIFACTS = {
  id: true, created_by_id: true, project_id: true,
  name: true, description: true, long_description: true,
  author_name: true, author_id: true, files: true,
  icon: true, screenshots: true, compile_target: true,
  tags: true, category: true, install_count: true, file_count: true,
  price: true, stripe_product_id: true, stripe_price_id: true,
  created_date: true, updated_date: true,
};
