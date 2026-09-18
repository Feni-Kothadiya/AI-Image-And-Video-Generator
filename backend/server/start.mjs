import { buildApp } from "./app.mjs";
const port = Number(process.env.PORT || 4000),
  host = process.env.HOST || "127.0.0.1";
if (
  process.env.NODE_ENV === "production" &&
  !process.env.ADMIN_ORIGIN?.startsWith("https://")
)
  throw new Error(
    "Production requires ADMIN_ORIGIN=https://your-admin-domain.",
  );
const app = await buildApp({
  worker: process.env.BACKGROUND_WORKERS_ENABLED !== "0",
});
try {
  await app.listen({ port, host });
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
