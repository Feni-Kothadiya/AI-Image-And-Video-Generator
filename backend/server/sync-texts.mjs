import { readFileSync } from "node:fs";
const credentials = readFileSync(
  new URL("../data/admin-credentials.txt", import.meta.url),
  "utf8",
);
const email = credentials.match(/^Email: (.+)$/m)[1].trim(),
  password = credentials.match(/^Password: (.+)$/m)[1].trim();
const origin = process.env.ADMIN_ORIGIN || "http://localhost:4000";
const login = await fetch(origin + "/api/admin/login", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({ email, password }),
});
if (!login.ok)
  throw new Error(
    "Sign in failed. Add new text entries through the dashboard if the initial password has changed.",
  );
const { csrf } = await login.json(),
  cookie = login.headers.getSetCookie()[0].split(";")[0];
const headers = {
  Origin: origin,
  Cookie: cookie,
  "X-CSRF-Token": csrf,
  "Content-Type": "application/json",
};
const data = await (
  await fetch(origin + "/api/admin/content", { headers })
).json();
const defaults = JSON.parse(
  readFileSync(
    new URL("../../shared/default-config.json", import.meta.url),
    "utf8",
  ),
);
let count = 0;
for (const [key, value] of Object.entries(defaults.texts))
  if (!Object.hasOwn(data.draft.content.texts, key)) {
    data.draft.content.texts[key] = value;
    count++;
  }
if (count) {
  const saved = await fetch(origin + "/api/admin/content", {
    method: "PUT",
    headers,
    body: JSON.stringify(data.draft),
  });
  if (!saved.ok) throw new Error("Could not save updated text catalog.");
  console.log(
    "Added " +
      count +
      " missing text entries to the draft. Publish through the dashboard when ready.",
  );
} else console.log("Text catalog is up to date.");
await fetch(origin + "/api/admin/logout", {
  method: "POST",
  headers,
  body: "{}",
});
