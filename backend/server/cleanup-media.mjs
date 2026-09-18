export async function cleanupMedia(
  db,
  storage,
  cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
) {
  const expired = await db
    .prepare("SELECT * FROM uploads WHERE public=0 AND created_at<?")
    .all(cutoff);
  let removed = 0;
  for (const media of expired) {
    const active = await db
      .prepare(
        "SELECT request FROM jobs WHERE user_id=? AND status IN ('queued','processing')",
      )
      .all(media.user_id);
    if (
      active.some((job) => JSON.parse(job.request).uploadIds.includes(media.id))
    )
      continue;
    await storage.deleteUpload(media);
    await db.prepare("DELETE FROM uploads WHERE id=?").run(media.id);
    removed++;
  }
  await db.prepare("DELETE FROM sessions WHERE expires_at<?").run(Date.now());
  return removed;
}
