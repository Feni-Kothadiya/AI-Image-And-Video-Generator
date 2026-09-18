import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaults, getSetting, setSetting, now, audit } from "./db.mjs";
import { configSchema, parse } from "./schema.mjs";
import { templateArtwork } from "./bundled-media.mjs";

export function withTemplateArtwork(content) {
  const result = structuredClone(content);
  for (const asset of templateArtwork) {
    const original = defaults.templates.find((t) => t.id === asset.id);
    if (!original) throw new Error("Artwork has no matching default template.");
    let template = result.templates.find((t) => t.id === asset.id);
    if (
      template &&
      (template.category !== original.category ||
        template.kind !== original.kind)
    )
      throw new Error(
        "A template category changed; review the artwork mapping before installing.",
      );
    if (!template) {
      template = {
        ...original,
        order: Math.max(-1, ...result.templates.map((t) => t.order)) + 1,
      };
      result.templates.push(template);
      const group = template.kind === "dance" ? "video" : template.kind;
      if (!result.categories[group].includes(template.category))
        result.categories[group].push(template.category);
    }
    template.imageUrl = "/seed-assets/" + asset.name;
  }
  return parse(configSchema, result);
}

// Update published and draft independently: unrelated draft edits stay unpublished.
export async function publishTemplateArtwork(db, { backupDir } = {}) {
  return db.transaction(async () => {
    const published = await getSetting(db, "published");
    const draft = await getSetting(db, "draft");
    const content = withTemplateArtwork(published.content);
    const draftContent = withTemplateArtwork(draft.content);
    const publishChanged =
      JSON.stringify(content) !== JSON.stringify(published.content);
    const draftChanged =
      JSON.stringify(draftContent) !== JSON.stringify(draft.content);
    if (!publishChanged && !draftChanged)
      return { changed: false, version: published.version };
    if (backupDir) {
      await mkdir(backupDir, { recursive: true });
      await writeFile(
        join(backupDir, `before-template-artwork-${Date.now()}.json`),
        JSON.stringify({ published, draft }, null, 2),
        { mode: 0o600, flag: "wx" },
      );
    }
    let version = published.version;
    if (publishChanged) {
      const revision = await db
        .prepare(
          "INSERT INTO revisions(content,note,actor,created_at) VALUES(?,?,?,?)",
        )
        .run(
          JSON.stringify(content),
          "Install 30 original category template images",
          "template-artwork",
          now(),
        );
      version = Number(revision.lastInsertRowid);
      await setSetting(db, "published", { version, content });
    }
    await setSetting(db, "draft", {
      version: draft.version + 1,
      content: draftContent,
    });
    await audit(db, "template-artwork", "content.artwork", String(version), {
      images: templateArtwork.length,
    });
    return { changed: true, version };
  });
}
