import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { loadConfig } from "../env.ts";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
await migrate(drizzle(pool), { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
await pool.end();
console.log("migrations applied");
