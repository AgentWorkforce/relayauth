import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { MigrationFile, MigrationSource } from "../types.js";

/**
 * Return a 64-char lowercase sha256 hex digest of the given string.
 * Exposed as a named export so consumers writing their own sources (e.g. a
 * Workers source that embeds SQL via `import.meta.glob`) can reuse the same
 * checksum algorithm and stay compatible with existing journals.
 */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Build a {@link MigrationSource} that reads `.sql` files from a directory
 * using `node:fs/promises`.
 *
 * Files are sorted by name lex-ascending, matching the convention of naming
 * migrations with a zero-padded numeric prefix (e.g. `0001_...`, `0002_...`).
 * Non-`.sql` files are ignored so README or other companion files can live in
 * the same directory without interfering.
 */
export function createFsMigrationSource(dir: string): MigrationSource {
  return {
    async list(): Promise<MigrationFile[]> {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          return [];
        }
        throw err;
      }

      const sqlFiles = entries
        .filter((name) => name.endsWith(".sql"))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      const files: MigrationFile[] = [];
      for (const name of sqlFiles) {
        const sql = await readFile(join(dir, name), "utf8");
        files.push({
          id: name.replace(/\.sql$/, ""),
          sql,
          checksum: sha256(sql),
        });
      }
      return files;
    },
  };
}
