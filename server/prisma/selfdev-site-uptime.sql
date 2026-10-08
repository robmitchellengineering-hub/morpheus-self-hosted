-- site_uptime_checks — one observation of whether a connected site answered.
--
-- WHY THIS IS A NEW TABLE
--
-- The WordPress audit's item 7: uptime monitoring. /status exists in every build of
-- the plugin, needs no signature and costs one HTTP request, and NOTHING stored the
-- answer — so "was my site up last night?" had no answer anywhere in the product. A
-- site that was down for an hour while the owner slept looked exactly like one that
-- was never checked, and the failure an owner notices first was the one thing
-- Morpheus could not tell them about.
--
-- A ROW PER CHECK, not a running total: the interesting question is never the
-- percentage on its own, it is WHEN it broke and what the site said. A failed check
-- keeps the reason and the HTTP code (0 meaning "never got a response", which is a
-- different fact from a 500), and a successful one keeps the plugin version the site
-- is running — so a site stuck on an old build becomes visible without anyone asking
-- it.
--
-- Additive and idempotent, per KNOWN-HAZARDS.md H8, and safe if it lands AFTER the
-- code does: lib/siteUptimeStore.js treats a missing table as "no history yet"
-- rather than throwing, so an unmigrated database cannot break a page. That is the
-- H11 shape with the smallest blast radius, because entities.js never lists this
-- model — nothing reads it by default, only the uptime surface asks.
--
-- The foreign keys are INLINE rather than separate `ALTER TABLE … ADD CONSTRAINT`
-- statements: `ADD CONSTRAINT` has no `IF NOT EXISTS` in Postgres, so a re-run would
-- fail halfway, which is exactly what H8's "idempotent" requirement rules out.
--
-- Bounded by PRUNING on write (lib/siteUptimeStore.js), not by a counter here: this
-- table grows at the polling rate forever otherwise.

CREATE TABLE IF NOT EXISTS site_uptime_checks (
    id             TEXT         NOT NULL,
    project_id     TEXT         NOT NULL,
    created_by_id  TEXT         NOT NULL,
    checked_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ok             BOOLEAN      NOT NULL,
    status_code    INTEGER      NOT NULL DEFAULT 0,
    latency_ms     INTEGER      NOT NULL DEFAULT 0,
    plugin_version TEXT,
    error          TEXT,

    CONSTRAINT site_uptime_checks_pkey PRIMARY KEY (id),
    CONSTRAINT site_uptime_checks_project_id_fkey FOREIGN KEY (project_id)
      REFERENCES projects (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT site_uptime_checks_created_by_id_fkey FOREIGN KEY (created_by_id)
      REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS site_uptime_checks_project_id_checked_at_idx
  ON site_uptime_checks (project_id, checked_at);

COMMENT ON TABLE site_uptime_checks IS
  'One uptime observation of a connected WordPress site, recorded by lib/siteUptimeStore.js and read by functions/siteUptime.js. Pruned to RETAIN_DAYS on write. status_code 0 means no response at all — kept distinct from an HTTP error because the remedies differ.';

COMMENT ON COLUMN site_uptime_checks.plugin_version IS
  'The version the plugin reported on this check. Stored per check so a site that has fallen behind becomes visible over time, rather than only when somebody looks.';
