import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  openDatabase,
  defaults,
  getSetting,
  setSetting,
} from "../server/db.mjs";
import { templateArtwork, bundledPath } from "../server/bundled-media.mjs";
import {
  publishTemplateArtwork,
  withTemplateArtwork,
} from "../server/template-artwork.mjs";

test("all catalog categories have distinct, readable generated artwork", async () => {
  const hashes = new Set();
  assert.equal(templateArtwork.length, 30);
  for (const asset of templateArtwork) {
    const bytes = await readFile(bundledPath(asset.name));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    hashes.add(createHash("sha256").update(bytes).digest("hex"));
    assert.equal(
      defaults.templates.find((t) => t.id === asset.id).imageUrl,
      "/seed-assets/" + asset.name,
    );
  }
  assert.equal(hashes.size, 30);
  for (const [group, categories] of Object.entries(defaults.categories)) {
    for (const category of categories)
      assert.ok(
        defaults.templates.some(
          (t) =>
            (t.kind === "dance" ? "video" : t.kind) === group &&
            t.category === category &&
            t.imageUrl,
        ),
        `${group}/${category} is missing artwork`,
      );
  }
  assert.throws(() => bundledPath("../prompts.json"));
});

test("artwork publication preserves unpublished edits, adds Animal, and can be rerun", async (t) => {
  const db = await openDatabase(":memory:");
  t.after(() => db.close());
  const old = structuredClone(defaults);
  old.templates = old.templates
    .filter((t) => t.id !== "v11")
    .map((t) => ({ ...t, imageUrl: "" }));
  old.home.title = "Live home title";
  const draft = structuredClone(old);
  draft.home.title = "Private draft title";
  draft.templates.find((t) => t.id === "p0").prompt =
    "Custom unpublished prompt";
  await setSetting(db, "published", { version: 1, content: old });
  await setSetting(db, "draft", { version: 8, content: draft });
  const result = await publishTemplateArtwork(db);
  assert.equal(result.changed, true);
  const published = await getSetting(db, "published");
  const savedDraft = await getSetting(db, "draft");
  assert.equal(published.content.home.title, "Live home title");
  assert.equal(savedDraft.content.home.title, "Private draft title");
  assert.equal(
    savedDraft.content.templates.find((t) => t.id === "p0").prompt,
    "Custom unpublished prompt",
  );
  assert.equal(savedDraft.version, 9);
  assert.equal(
    published.content.templates.find((t) => t.id === "v11").category,
    "Animal",
  );
  assert.equal(
    published.content.templates.filter((t) => t.imageUrl).length,
    30,
  );
  assert.deepEqual(await publishTemplateArtwork(db), {
    changed: false,
    version: result.version,
  });
  assert.equal((await getSetting(db, "draft")).version, 9);
  const conflicting = structuredClone(defaults);
  conflicting.templates.find((t) => t.id === "p0").category = "Prank";
  assert.throws(() => withTemplateArtwork(conflicting), /category changed/);
});
