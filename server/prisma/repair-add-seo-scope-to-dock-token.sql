-- Give the live admin-dock widget token the SEO scope, so the widget can render
-- the SEO page (src/pages/Embed.jsx's SCOPE_TABS filters on the token's scopes,
-- and this token was created with the EMBED tab's default chat,deploy,store).
--
-- ONE ROW, identified by primary key, with the current value in the WHERE clause
-- so a second run is a no-op. Reversible: set scopes back to 'chat,deploy,store'.
--
-- A data write, not DDL — hence the explicit --data-repair channel:
--   node scripts/prod-sql.mjs prisma/repair-add-seo-scope-to-dock-token.sql --data-repair

UPDATE widget_tokens
SET scopes = 'chat,deploy,seo,store'
WHERE id = 'de09d361-3d17-4ddd-875c-1434da5acb86' AND scopes = 'chat,deploy,store';
