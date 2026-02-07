import { readFile } from "node:fs/promises";
import path from "node:path";
import { makePgPool } from "./pool.js";
import { loadEnvOnce } from "../env.js";

export async function migrate(): Promise<void> {
  loadEnvOnce();
  const schemaPath = path.resolve(process.cwd(), "../../db/schema.sql");
  const sql = await readFile(schemaPath, "utf8");

  const pool = makePgPool();
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

