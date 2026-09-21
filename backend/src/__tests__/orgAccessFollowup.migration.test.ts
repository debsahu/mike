import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Four of this branch's defects (B09-B12) live entirely in SQL, so no unit or
// route test can exercise them: proving them needs a Postgres instance, which
// is what `npm run test:stack` and .github/workflows/schema-drift.yml are for.
// What CAN be guarded without a database is that the forward migration still
// CONTAINS each correction and that schema.sql — the fresh-install shape —
// still agrees with it. That is the invariant an upgraded deployment depends
// on: 20260904_01 and 20260904_02 are merged and immutable, so every
// correction to them has to arrive in a later file AND be mirrored in
// schema.sql, or a fresh install and an upgrade end at different shapes.
//
// Scope, stated plainly: this asserts the statements are present, not that
// Postgres executes them correctly. The behavioural proof is the drift job.

const repoRoot = path.resolve(__dirname, "../../..");
const migrationsDir = path.join(repoRoot, "backend/migrations");

// The eight tables 20260904_01 created and granted to service_role without
// ever revoking the PUBLIC-inherited privileges from anon/authenticated.
const ACCESS_TABLES = [
    "organizations",
    "org_members",
    "org_invitations",
    "project_access_grants",
    "project_org_access_overrides",
    "chat_access_grants",
    "tabular_review_access_grants",
    "workflow_org_access_overrides",
];

// Read lazily and never throw at collection time: a missing file has to fail
// each case on its own assertion, not abort the file before any case runs.
function followupMigrationFile() {
    return readdirSync(migrationsDir)
        .filter((name) => name.endsWith("_organization_access_followup.sql"))
        .sort()
        .pop();
}

function readFollowupMigration() {
    const file = followupMigrationFile();
    if (!file) return "";
    return readFileSync(path.join(migrationsDir, file), "utf8").toLowerCase();
}

describe("the 0904 corrections ship as a forward migration", () => {
    const sql = readFollowupMigration();
    const schema = readFileSync(
        path.join(repoRoot, "backend/schema.sql"),
        "utf8",
    ).toLowerCase();

    it("exists at all, so an upgraded deployment has somewhere to get them", () => {
        expect(
            followupMigrationFile(),
            "no *_organization_access_followup.sql in backend/migrations: 20260904_01 and _02 are merged and immutable, so their corrections have nowhere to land on an upgraded deployment",
        ).toBeDefined();
    });

    it("carries the migration-date header the repo's runner orders on", () => {
        expect(sql).toMatch(/^-- migration date: \d{4}-\d{2}-\d{2}/);
    });

    // B11. get_workflows_overview lists a share with lower() on both sides.
    // workflow_access_role compared the STORED value raw, so a legacy
    // mixed-case recipient was listed the row and then 404'd on opening it.
    it("B11: lowers both sides of the workflow share recipient compare", () => {
        expect(sql).toContain(
            "create or replace function public.workflow_access_role",
        );
        expect(sql).toContain(
            "lower(s.shared_with_email) = lower(p_user_email)",
        );
        // And the stored values are canonicalised, with a constraint that
        // keeps them that way.
        expect(sql).toContain("workflow_shares_email_lowercase");
        expect(schema).toContain(
            "lower(s.shared_with_email) = lower(p_user_email)",
        );
        expect(schema).toContain("workflow_shares_email_lowercase");
    });

    // B10. RLS ENABLE with no policy is not a grant boundary: anon and
    // authenticated inherit table privileges from PUBLIC unless revoked.
    // schema.sql revoked all eight; an upgraded deployment never did.
    it.each(ACCESS_TABLES)(
        "B10: revokes anon/authenticated on public.%s for upgrades too",
        (table) => {
            expect(
                sql,
                `the followup migration never revokes anon/authenticated on ${table}`,
            ).toContain(`revoke all on public.${table} from anon, authenticated`);
            expect(
                schema,
                `schema.sql never revokes anon/authenticated on ${table}`,
            ).toContain(`revoke all on public.${table} from anon, authenticated`);
        },
    );

    // B12. The 0904_02 backfill turned a creator's own address, echoed back
    // inside the legacy shared_with array, into an EDITOR grant on their own
    // matter; and it accepted any value containing '@', including '@x.com'.
    it("B12: deletes the self-grants and the address-less rows the backfill wrote", () => {
        for (const table of [
            "project_access_grants",
            "tabular_review_access_grants",
        ]) {
            expect(
                sql,
                `${table} keeps the creator self-grants 20260904_02 wrote`,
            ).toMatch(new RegExp(`delete from public\\.${table}\\b`));
        }
        // auth.users is the authoritative address: keying the exclusion on
        // user_profiles alone left a creator with no profile row holding an
        // editor grant on their own project.
        expect(sql).toContain("auth.users");
        // '@x.com' has an '@' but no local part; position() > 1 is the test
        // for a real address, so <= 1 is the row to remove.
        expect(sql).toContain("position('@' in trim(email)) <= 1");
    });

    // B09. 20260904_02 dropped tabular_reviews.shared_with without recording
    // the recipients of direct shares on project-contained reviews, which the
    // new model cannot express.
    it("B09: creates the legacy-share archive and backfills it only while the column exists", () => {
        expect(sql).toContain(
            "create table if not exists public.tabular_review_legacy_shares",
        );
        // A historical record of who lost access has to outlive the rows it
        // describes, so the review id is a plain indexed column, not a
        // cascading foreign key.
        expect(sql).toContain(
            "drop constraint if exists tabular_review_legacy_shares_tabular_review_id_fkey",
        );
        expect(sql).toContain(
            "create index if not exists idx_tabular_review_legacy_shares_review",
        );
        // The backfill is guarded: on a deployment that already ran
        // 20260904_02 the column is gone and this must be a no-op, not an
        // error that aborts the rest of the migration.
        expect(sql).toContain("information_schema.columns");
        expect(sql).toContain("column_name = 'shared_with'");
        // Fresh installs get the same table, or the drift check fails.
        expect(schema).toContain(
            "create table if not exists public.tabular_review_legacy_shares",
        );
        expect(schema).toContain(
            "revoke all on public.tabular_review_legacy_shares from anon, authenticated",
        );
    });
});
