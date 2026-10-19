import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  audit,
  connectDatabase,
  credit,
  getSetting,
  now,
  setSetting,
} from "./db.mjs";

if (process.env.RESET_ALL_USER_COINS !== "1") {
  console.error(
    "Refusing to reset balances. Set RESET_ALL_USER_COINS=1 to confirm.",
  );
  process.exit(1);
}

const dataDir = resolve(process.env.DATA_DIR || "./data");
let db;

try {
  db = await connectDatabase(join(dataDir, "studio.sqlite"), { seed: false });
  const result = await db.transaction(async () => {
    const users = await db
      .prepare("SELECT id,coins FROM users WHERE role='user' ORDER BY id")
      .all();
    const published = await getSetting(db, "published");
    const draft = await getSetting(db, "draft");
    if (!published?.content?.rewards || !draft?.content?.rewards)
      throw new Error("Published or draft rewards configuration is missing.");

    const changedUsers = users.filter((user) => user.coins !== 0);
    const previousCoins = changedUsers.reduce(
      (total, user) => total + user.coins,
      0,
    );
    const resetAt = now();
    const backupDir = join(dataDir, "backups");
    const backupPath = join(
      backupDir,
      `before-user-coin-reset-${resetAt.replace(/[:.]/g, "-")}.json`,
    );
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    await writeFile(
      backupPath,
      JSON.stringify(
        {
          createdAt: resetAt,
          users,
          published,
          draft,
        },
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
    );

    const reference = `admin-coin-reset:${resetAt}`;
    for (const user of changedUsers)
      await credit(
        db,
        user.id,
        -user.coins,
        "Administrative coin balance reset",
        reference,
      );

    const publishedContent = structuredClone(published.content);
    const draftContent = structuredClone(draft.content);
    publishedContent.rewards.welcome = 0;
    draftContent.rewards.welcome = 0;

    let publishedVersion = published.version;
    if (published.content.rewards.welcome !== 0) {
      const revision = await db
        .prepare(
          "INSERT INTO revisions(content,note,actor,created_at) VALUES(?,?,?,?)",
        )
        .run(
          JSON.stringify(publishedContent),
          "Set the starting coin balance for new users to zero",
          "coin-reset",
          resetAt,
        );
      publishedVersion = Number(revision.lastInsertRowid);
      await setSetting(db, "published", {
        version: publishedVersion,
        content: publishedContent,
      });
    }
    if (draft.content.rewards.welcome !== 0)
      await setSetting(db, "draft", {
        version: draft.version + 1,
        content: draftContent,
      });

    await audit(db, "coin-reset", "users.coins.reset", "all-users", {
      users: users.length,
      changedUsers: changedUsers.length,
      previousCoins,
      newBalance: 0,
      welcomeCoins: 0,
      backupPath,
    });

    return {
      users: users.length,
      changedUsers: changedUsers.length,
      previousCoins,
      newTotalCoins: 0,
      welcomeCoins: 0,
      publishedVersion,
      backupPath,
    };
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Coin reset failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
