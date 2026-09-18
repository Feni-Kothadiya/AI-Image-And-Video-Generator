import { adminLoginIdSchema } from "./schema.mjs";
import { hashPassword } from "./security.mjs";
import { transaction, audit } from "./db.mjs";

export class AdminResetError extends Error {}

export async function resetAdmin(db, { login, password, currentLogin } = {}) {
  const parsed = adminLoginIdSchema.safeParse(login);
  if (!parsed.success)
    throw new AdminResetError("Set ADMIN_LOGIN to a login ID or email without spaces.");
  if (typeof password !== "string" || password.length < 8 || password.length > 128)
    throw new AdminResetError("Set ADMIN_PASSWORD to a password of 8 to 128 characters.");
  const current = currentLogin === undefined ? undefined : adminLoginIdSchema.safeParse(currentLogin);
  if (current && !current.success)
    throw new AdminResetError("ADMIN_CURRENT_LOGIN must be a login ID or email without spaces.");
  const hashed = await hashPassword(password);
  return transaction(db, async () => {
    const admins = current
      ? await db.prepare("SELECT id FROM users WHERE role='admin' AND email=?").all(current.data)
      : await db.prepare("SELECT id FROM users WHERE role='admin'").all();
    if (!admins.length)
      throw new AdminResetError("No matching administrator exists. Check the selected database and ADMIN_CURRENT_LOGIN.");
    if (admins.length !== 1)
      throw new AdminResetError("Multiple administrators exist. Set ADMIN_CURRENT_LOGIN to the account to reset.");
    const { id } = admins[0];
    const conflict = await db.prepare("SELECT id FROM users WHERE email=? AND id!=?").get(parsed.data, id);
    if (conflict)
      throw new AdminResetError("That login ID belongs to another account. No credentials were changed.");
    await db.prepare("UPDATE users SET email=?,password=?,status='active' WHERE id=? AND role='admin'")
      .run(parsed.data, hashed, id);
    await db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    await audit(db, id, "admin.credentials.reset", id);
    return { id, login: parsed.data };
  });
}
