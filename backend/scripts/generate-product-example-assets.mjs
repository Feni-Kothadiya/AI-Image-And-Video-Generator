import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(root, 'shared/product-studio/example-sheets');
const assetRoot = join(root, 'ai-image-video-generator/assets/product-studio/examples');
const manifestPath = join(root, 'ai-image-video-generator/src/product-examples.generated.ts');

const categories = [
    {
        id: 'fashion', width: 1024, height: 1536, ratio: '3:4', model: 'indian-woman',
        titles: ['Emerald saree', 'Ivory kurta set', 'Coral day dress', 'Navy bomber jacket', 'Mustard co-ord', 'Maroon lehenga', 'Pastel linen shirt', 'Black evening dress', 'Teal embroidered tunic', 'Rust handloom saree'],
    },
    {
        id: 'jewellery', width: 1312, height: 1199, ratio: '1:1', model: 'indian-woman',
        titles: ['Emerald necklace', 'Silver jhumkas', 'Rose-gold ring', 'Pearl choker', 'Oxidized necklace', 'Gold bangles', 'Minimal pendant', 'Kundan bridal set', 'Steel wristwatch', 'Gemstone earrings'],
    },
    {
        id: 'accessories', width: 1312, height: 1199, ratio: '1:1', model: 'product-only',
        titles: ['Structured handbag', 'Leather wristwatch', 'White sneakers', 'Tortoiseshell sunglasses', 'Silk scarf', 'Leather belt', 'Canvas backpack', 'Red heels', 'Minimal wallet', 'Gold hair clip'],
    },
    {
        id: 'beauty', width: 1312, height: 1199, ratio: '1:1', model: 'product-only',
        titles: ['Amber serum', 'Face cream', 'Coral lipstick', 'Botanical shampoo', 'Daily sunscreen', 'Fine fragrance', 'Compact powder', 'Body lotion', 'Handmade soap', 'Wellness supplement'],
    },
    {
        id: 'food', width: 1536, height: 1024, ratio: '1:1', model: 'product-only',
        titles: ['Spice blend', 'Artisan coffee', 'Cookie box', 'Mango drink', 'Premium tea', 'Fruit granola', 'Hot sauce', 'Chocolate bar', 'Natural honey', 'Sparkling water'],
    },
    {
        id: 'electronics', width: 1536, height: 1024, ratio: '1:1', model: 'product-only',
        titles: ['Over-ear headphones', 'Smartphone', 'Wireless earbuds', 'Bluetooth speaker', 'Smartwatch', 'Mechanical keyboard', 'Portable blender', 'Desk lamp', 'Game controller', 'Slim laptop'],
    },
    {
        id: 'home', width: 1122, height: 1402, ratio: '3:4', model: 'product-only',
        titles: ['Boucle accent chair', 'Ceramic table lamp', 'Patterned cushion', 'Oak side table', 'Neutral woven rug', 'Ceramic vase', 'Linen bedding', 'Wall mirror', 'Storage basket', 'Modern floor lamp'],
    },
    {
        id: 'kids', width: 1312, height: 1199, ratio: '3:4', model: 'product-only',
        titles: ['Sunny outfit', 'School backpack', 'Wooden stacker', 'Pastel sneakers', 'Storybook', 'Plush rabbit', 'Raincoat', 'Lunch box', 'Balance bike', 'Baby blanket'],
    },
    {
        id: 'craft', width: 1222, height: 1287, ratio: '1:1', model: 'product-only',
        titles: ['Ceramic vase', 'Woven basket', 'Embroidery hoop', 'Handmade candle', 'Macrame hanging', 'Painted jewellery box', 'Knitted scarf', 'Painted serving tray', 'Clay planter', 'Paper notebook'],
    },
];

const scenes = ['studio', 'lifestyle', 'luxury', 'marketplace', 'outdoor'];
const poses = ['front', 'three-quarter', 'close-up', 'front', 'three-quarter'];
const lookPrompts = [
    'Use a warm minimal premium studio with soft directional window light, creamy neutral architecture and restrained props.',
    'Use a bright aspirational lifestyle setting with natural daylight, realistic context and clean commercial styling.',
    'Use a refined luxury campaign set with deep tonal contrast, focused highlights and expensive tactile materials.',
    'Use a pure clean marketplace setup with even illumination, uncluttered framing and a subtle grounding shadow.',
    'Use an elegant golden-hour outdoor setting with soft natural depth, warm rim light and believable contact.',
    'Use a sculptural editorial studio with controlled shadows, a polished neutral palette and generous negative space.',
    'Use a modern lived-in interior with gentle daylight and supporting details that never compete with the product.',
    'Use glossy campaign lighting with precise reflections, crisp material detail and a bold but uncluttered background.',
    'Use an earthy tactile set with natural stone, linen or wood and soft directional light that reveals workmanship.',
    'Use a fresh social-commerce look with lively color accents, clean composition and clear product-first hierarchy.',
];

const lines = [
    "import { ImageSourcePropType } from 'react-native';",
    "import { ProductCategoryId, ProductModelId, ProductPoseId, ProductRatio, ProductSceneId } from './product-studio';",
    '',
    'export type ProductExample = {',
    '  id: string;',
    '  categoryId: ProductCategoryId;',
    '  title: string;',
    '  before: ImageSourcePropType;',
    '  after: ImageSourcePropType;',
    '  modelId: ProductModelId;',
    '  sceneId: ProductSceneId;',
    '  poseId: ProductPoseId;',
    '  ratio: ProductRatio;',
    '  prompt: string;',
    '};',
    '',
    'export const PRODUCT_EXAMPLES: ProductExample[] = [',
];

for (const category of categories) {
    const source = join(sourceRoot, `${category.id}.png`);
    const outputDir = join(assetRoot, category.id);
    mkdirSync(outputDir, { recursive: true });
    const cellWidth = Math.floor(category.width / 4);
    const cellHeight = Math.floor(category.height / 5);

    category.titles.forEach((title, index) => {
        const row = Math.floor(index / 2);
        const beforeColumn = (index % 2) * 2;
        const number = String(index + 1).padStart(2, '0');
        const beforeName = `${number}-before.jpg`;
        const afterName = `${number}-after.jpg`;
        for (const [fileName, column] of [[beforeName, beforeColumn], [afterName, beforeColumn + 1]]) {
            execFileSync('ffmpeg', [
                '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
                '-vf', `crop=${cellWidth}:${cellHeight}:${column * cellWidth}:${row * cellHeight},scale=600:-2:flags=lanczos`,
                '-q:v', '3', join(outputDir, fileName),
            ]);
        }
        lines.push('  {');
        lines.push(`    id: '${category.id}-${number}',`);
        lines.push(`    categoryId: '${category.id}',`);
        lines.push(`    title: ${JSON.stringify(title)},`);
        lines.push(`    before: require('../assets/product-studio/examples/${category.id}/${beforeName}'),`);
        lines.push(`    after: require('../assets/product-studio/examples/${category.id}/${afterName}'),`);
        lines.push(`    modelId: '${category.model}',`);
        lines.push(`    sceneId: '${scenes[index % scenes.length]}',`);
        lines.push(`    poseId: '${poses[index % poses.length]}',`);
        lines.push(`    ratio: '${category.ratio}',`);
        lines.push(`    prompt: ${JSON.stringify(lookPrompts[index])},`);
        lines.push('  },');
    });
}

lines.push('];', '');
writeFileSync(manifestPath, lines.join('\n'));
console.log(`Generated ${categories.length * 20} images and ${categories.length * 10} comparison records.`);
