/**
 * scripts/migrate.ts
 *
 * SQL migration runner for the Outsyde backend.
 * - Reads every *.sql file in migrations/ in sorted (filename) order.
 * - Tracks applied migrations in a _schema_migrations table so each file
 *   runs exactly once, even across multiple deploys.
 * - Uses @neondatabase/serverless (HTTP transport) — same driver as the app,
 *   no separate pg client or proxy required.
 * - Safe to run in CI/CD: all migration files use IF NOT EXISTS / IF EXISTS.
 */

import { neon } from "@neondatabase/serverless";
import { readdir, readFile } from "fs/promises";
import { join } from "path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[migrate] FATAL: DATABASE_URL environment variable is not set");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

/**
 * Strip SQL comments and split on semicolons into individual statements.
 * Filters out blank / whitespace-only results.
 */
function splitStatements(sqlText: string): string[] {
  const stripped = sqlText
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // block comments
    .replace(/--[^\n]*/g, "");            // line comments

  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function migrate(): Promise<void> {
  console.log("[migrate] Starting migration run...");

  // Ensure the tracking table exists (idempotent)
  await sql(
    `CREATE TABLE IF NOT EXISTS _schema_migrations (
       filename   TEXT        PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    []
  );

  // Fetch already-applied filenames
  const appliedRows = await sql(`SELECT filename FROM _schema_migrations ORDER BY filename`, []);
  const appliedSet = new Set((appliedRows as { filename: string }[]).map((r) => r.filename));

  // Collect migration files
  const migrationsDir = join(process.cwd(), "migrations");
  let files: string[];
  try {
    const entries = await readdir(migrationsDir);
    files = entries
      .filter((f) => f.endsWith(".sql") && f !== "meta")
      .sort();
  } catch {
    console.log("[migrate] No migrations/ directory found — nothing to do.");
    return;
  }

  let appliedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`[migrate] skip   ${file} (already applied)`);
      skippedCount++;
      continue;
    }

    const filePath = join(migrationsDir, file);
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      console.warn(`[migrate] warn   cannot read ${file} — skipping`);
      continue;
    }

    const statements = splitStatements(content);
    if (statements.length === 0) {
      console.log(`[migrate] empty  ${file} — marking applied`);
    } else {
      console.log(`[migrate] apply  ${file} (${statements.length} statement(s))`);
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];
        try {
          await sql(stmt, []);
        } catch (err: any) {
          console.error(
            `[migrate] ERROR in ${file} statement ${i + 1}:\n  ${stmt.substring(0, 200)}\n  ${err.message}`
          );
          throw err;
        }
      }
    }

    // Record this migration as applied
    await sql(`INSERT INTO _schema_migrations (filename) VALUES ($1)`, [file]);
    console.log(`[migrate] done   ${file}`);
    appliedCount++;
  }

  console.log(
    `[migrate] Finished — ${appliedCount} applied, ${skippedCount} skipped.`
  );
}

migrate().catch((err: Error) => {
  console.error("[migrate] FATAL:", err.message || err);
  process.exit(1);
});
