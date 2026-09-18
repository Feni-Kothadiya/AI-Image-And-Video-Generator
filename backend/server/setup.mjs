import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { connectDatabase, now, transaction } from "./db.mjs";
import { hashPassword, token, masterKey } from "./security.mjs";
const dir = resolve(process.env.DATA_DIR || "./data");
let db;
try {
  db = await connectDatabase(join(dir, "studio.sqlite"));
  masterKey(dir);
  await transaction(db, async () => {
    if (await db.prepare("SELECT id FROM users WHERE role='admin'").get()) {
      console.log(
        "An administrator already exists. Credentials were not changed.",
      );
      return;
    }
    const filename = join(dir, "admin-credentials.txt");
    if (existsSync(filename) && !process.env.ADMIN_PASSWORD)
      throw new Error(
        "An existing credentials file was found. Import the old database before setup, or set ADMIN_EMAIL and ADMIN_PASSWORD for a fresh administrator.",
      );
    const email = process.env.ADMIN_EMAIL || "admin@aicreator.local";
    const password = process.env.ADMIN_PASSWORD || token();
    if (password.length < 12)
      throw new Error("ADMIN_PASSWORD must have at least 12 characters.");
    await db
      .prepare(
        "INSERT INTO users(id,email,password,role,created_at) VALUES(?,?,?,'admin',?)",
      )
      .run(randomUUID(), email, await hashPassword(password), now());
    if (!existsSync(filename)) {
      writeFileSync(
        filename,
        "Dashboard: http://localhost:4000\nEmail: " +
          email +
          "\nPassword: " +
          password +
          "\n\nChange the password in Dashboard > Security. Keep this file private.\n",
        { mode: 0o600, flag: "wx" },
      );
      console.log(
        "Administrator created. Initial login details are in backend/data/admin-credentials.txt; no password was printed.",
      );
    } else
      console.log(
        "Administrator created using the explicitly configured login. The existing credentials file was preserved.",
      );
  });
} catch (error) {
  const safe = [
    "An existing credentials file was found. Import the old database before setup, or set ADMIN_EMAIL and ADMIN_PASSWORD for a fresh administrator.",
    "ADMIN_PASSWORD must have at least 12 characters.",
  ];
  console.error(
    safe.includes(error.message)
      ? error.message
      : "Backend setup failed. Check database connectivity and local data permissions.",
  );
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
