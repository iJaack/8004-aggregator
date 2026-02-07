import pg from "pg";
import { mustEnv, loadEnvOnce } from "../env.js";

export type PgPool = pg.Pool;

export function makePgPool(): PgPool {
  loadEnvOnce();
  return new pg.Pool({
    connectionString: mustEnv("DATABASE_URL"),
    max: 10,
  });
}

