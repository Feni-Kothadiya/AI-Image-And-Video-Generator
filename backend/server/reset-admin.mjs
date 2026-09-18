import { resolve, join } from "node:path";
import { connectDatabase } from "./db.mjs";
import { resetAdmin, AdminResetError } from "./admin-reset.mjs";

let db;
try {
  const dir = resolve(process.env.DATA_DIR || "./data");
  db = await connectDatabase(join(dir, "studio.sqlite"), { seed: false });
  const result = await resetAdmin(db, {
    login: process.env.ADMIN_LOGIN,
    password: process.env.ADMIN_PASSWORD,
    currentLogin: process.env.ADMIN_CURRENT_LOGIN,
  });
  console.log(`Administrator reset successfully in ${db.kind}. Login ID: ${result.login}. Existing sessions were revoked. No password was printed.`);
} catch (error) {
  console.error(error instanceof AdminResetError ? error.message
    : "Administrator reset failed. Check database connectivity and permissions; database error details were not printed.");
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
