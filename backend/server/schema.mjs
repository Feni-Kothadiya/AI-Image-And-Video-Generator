import { z } from "zod";
const text = z.string().max(5000);
const short = z.string().trim().min(1).max(160);
const coins = z.number().int().min(0).max(1000000);
const url = z
  .string()
  .max(2048)
  .refine(
    (v) =>
      !v ||
      /^\/media\/[a-f0-9-]+\.(png|jpg|webp)$/.test(v) ||
      /^\/seed-assets\/template-(p(?:[0-9]|10)|v(?:[0-9]|10|11)|s[0-6])\.png$/.test(v) ||
      /^https:\/\/[^\s]+$/.test(v),
    "Use an uploaded media path or an HTTPS URL.",
  );
const categoryList = z
  .array(short)
  .min(1)
  .max(80)
  .refine(
    (v) => new Set(v).size === v.length,
    "Category names must be unique.",
  );
export const templateSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    title: short,
    category: short,
    art: z.enum(["portrait", "city", "couple", "flowers"]),
    kind: z.enum(["image", "video", "dance", "slideshow"]),
    prompt: z.string().max(4000),
    count: z.number().int().min(2).max(30).optional(),
    duration: z.number().int().min(3).max(120).optional(),
    imageUrl: url,
    enabled: z.boolean(),
    premium: z.boolean().optional(),
    order: z.number().int().min(0).max(10000),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.kind === "slideshow" && (!t.count || !t.duration))
      ctx.addIssue({
        code: "custom",
        message: "Slideshows need a photo count and duration.",
      });
    if (t.kind !== "slideshow" && !t.prompt.trim())
      ctx.addIssue({ code: "custom", message: "AI templates need a prompt." });
  });
export const configSchema = z
  .object({
    branding: z
      .object({
        appName: short,
        logoUrl: url,
        accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .strict(),
    home: z
      .object({
        title: short,
        subtitle: text,
        button: short,
        bannerUrl: url,
        featuredIds: z.array(short).max(30),
        sections: z.array(short).max(80),
      })
      .strict(),
    texts: z
      .record(z.string().min(1).max(5000), text)
      .refine(
        (v) =>
          Object.keys(v).length <= 3000 &&
          !Object.keys(v).some((k) =>
            ["__proto__", "constructor", "prototype"].includes(k),
          ),
        "Invalid text keys or too many entries.",
      ),
    costs: z.object({ image: coins, video: coins, dance: coins }).strict(),
    rewards: z
      .object({
        welcome: coins,
        daily: z.array(coins).length(7),
        ad: coins,
        twoAds: coins,
        image: coins,
        video: coins,
        slideshow: coins,
        notification: coins,
      })
      .strict(),
    coinPacks: z
      .array(
        z
          .object({
            id: short,
            coins: coins,
            rupees: z.number().min(0).max(1000000),
            label: short,
            productId: z.string().max(150),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(20),
    plans: z
      .array(
        z
          .object({
            id: short,
            label: short,
            price: short,
            period: short,
            saving: z.string().max(150),
            productId: z.string().max(150),
            basePlanId: z.string().max(150).optional(),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(20),
    categories: z
      .object({
        video: categoryList,
        image: categoryList,
        slideshow: categoryList,
      })
      .strict(),
    templates: z.array(templateSchema).max(1000),
    features: z
      .object({
        image: z.boolean(),
        video: z.boolean(),
        dance: z.boolean(),
        slideshow: z.boolean(),
        dailyRewards: z.boolean(),
        maintenance: z.boolean(),
      })
      .strict(),
    legal: z
      .object({
        supportEmail: z.union([z.literal(""), z.string().email().max(254)]),
        privacy: text,
        terms: text,
        announcement: text,
        playStoreUrl: z
          .string()
          .max(2048)
          .refine(
            (v) =>
              !v ||
              /^https:\/\/play\.google\.com\/store\/apps\/details\?id=[a-zA-Z0-9._]+$/.test(
                v,
              ),
            "Use a Google Play app link.",
          ),
      })
      .strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const productIds = [...c.coinPacks, ...c.plans].map(p => p.productId).filter(Boolean);
    if (new Set(productIds).size !== productIds.length) ctx.addIssue({code:"custom",path:["plans"],message:"Use a different Google Play product ID for each pack and plan."});
    for (const field of ["templates", "plans", "coinPacks"]) {
      const ids = c[field].map((v) => v.id);
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "IDs must be unique.",
        });
    }
    const ids = new Set(c.templates.map((t) => t.id));
    if (c.home.featuredIds.some((id) => !ids.has(id)))
      ctx.addIssue({
        code: "custom",
        path: ["home", "featuredIds"],
        message: "Featured templates must exist.",
      });
    for (const t of c.templates) {
      if (
        !c.categories[t.kind === "dance" ? "video" : t.kind].includes(
          t.category,
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["templates"],
          message: t.title + ": category does not exist for this type.",
        });
    }
    if (
      c.home.sections.some(
        (s) => ![...c.categories.video, ...c.categories.image].includes(s),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["home", "sections"],
        message: "Home sections must match an image or video category.",
      });
  });
export const adminLoginIdSchema = z.string().trim().min(1).max(254)
  .regex(/^[^\s]+$/, "Enter a login ID or email without spaces.")
  .transform((v) => v.toLowerCase());
export const adminCredentialsSchema = z.object({
  email: adminLoginIdSchema,
  password: z.string().min(1).max(128),
}).strict();
export const credentialsSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    password: z.string().min(12).max(128),
  })
  .strict();
export const jobSchema = z
  .object({
    mode: z.enum(["image", "video", "dance", "slideshow"]),
    prompt: z.string().trim().max(4000),
    templateId: z.string().max(80).optional(),
    uploadIds: z.array(z.string().uuid()).max(30).default([]),
    background: z.enum(["Original", "AI Generate"]).default("Original"),
  })
  .strict();
export const integrationSchema = z
  .object({
    provider: z.enum(["gateway", "fal"]).optional(),
    enabled: z.boolean(),
    gatewayUrl: z.union([z.literal(""), z.string().url().max(2048)]),
    models: z
      .object({
        image: z.string().max(150),
        video: z.string().max(150),
        dance: z.string().max(150),
        slideshow: z.string().max(150),
      })
      .strict(),
  })
  .strict();
export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const error = new Error(
      result.error.issues
        .map((i) => (i.path.join(".") || "Input") + ": " + i.message)
        .join("; "),
    );
    error.statusCode = 400;
    throw error;
  }
  return result.data;
}
export function fail(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  throw e;
}
