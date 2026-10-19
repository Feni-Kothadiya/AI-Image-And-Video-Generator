# Genora Product Studio artwork

Original synthetic preview artwork generated for this project with the built-in image-generation tool. These images are app navigation and selection previews; they are not customer outputs and do not represent real selectable people.

The mobile app uses optimized JPEG copies under `ai-image-video-generator/assets/product-studio/`. The PNG files in this directory are the full-resolution masters.

## Before-and-after example catalog

Each of the 9 product categories has 10 matched transformations: 10 source product images and 10 corresponding marketing results. That is 90 examples and 180 individual app images in total.

- Full-resolution 10-pair source sheets: `example-sheets/*.png`
- Optimized individual app images: `ai-image-video-generator/assets/product-studio/examples/<category>/`
- Generated app manifest: `ai-image-video-generator/src/product-examples.generated.ts`
- Rebuild command: `node scripts/generate-product-example-assets.mjs`

The examples are original synthetic artwork with no real brands or readable packaging claims. Every after image is paired with the product immediately beside it in the source sheet so product color, shape, pattern and construction remain visually consistent.

## Category prompt set

All category images use the following common requirements: photorealistic commercial product photography, vertical 4:5 composition, one unmistakable focal product, realistic materials and contact shadows, clean card-safe margins, no brand, no readable text, no logo and no watermark.

- `categories/fashion.png`: original adult Indian woman model wearing an elegant emerald saree in a warm minimal editorial studio; full garment visible with accurate woven detail.
- `categories/jewellery.png`: luxury close-up of an original adult Indian woman model wearing a gold necklace and earrings against a deep charcoal studio gradient; jewellery detail is the focal point.
- `categories/accessories.png`: unbranded tan leather handbag on a sculptural cream pedestal with premium directional studio light.
- `categories/beauty.png`: blank-label serum bottle and cream jar on pale stone with water reflections and soft botanical shadows.
- `categories/food.png`: blank Indian spice pouch beside a ceramic bowl of masala and neatly arranged whole spices on warm terracotta.
- `categories/electronics.png`: generic wireless headphones and smartphone on a dark navy reflective technology set with restrained cyan rim light.
- `categories/home.png`: upholstered accent chair in an aspirational warm-neutral apartment interior with realistic room scale.
- `categories/kids.png`: original child model in age-appropriate yellow catalogue clothing on a clean pastel studio set.
- `categories/craft.png`: handmade ceramic vase and woven basket on a warm clay-toned artisan set with tactile natural texture.

## Model prompt set

All model images use the following common requirements: original generic person with no public-figure resemblance, realistic commercial casting portrait, vertical 4:5 upper-body framing, simple clothing, soft neutral studio light, authentic skin texture, no text, logo or watermark.

- `models/indian-woman.png`: adult Indian woman, age 25+, cream outfit and warm-grey backdrop.
- `models/indian-man.png`: adult Indian man, age 25+, sand shirt and warm-grey backdrop.
- `models/international-woman.png`: adult globally inclusive woman model, short natural curls, black outfit and cool-grey backdrop.
- `models/international-man.png`: adult globally inclusive man model, charcoal shirt and cool-grey backdrop.
- `models/senior-woman.png`: elegant Indian woman around age 55, authentic age and silver-streaked hair, navy outfit and taupe backdrop.
- `models/product-only.png`: empty ivory studio pedestal with curved seamless backdrop and softbox lighting; no person and no product.

