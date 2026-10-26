/**
 * One-command check that the Meta Model API key works for every model we use.
 *   cd api && node --env-file=$HOME/.config/pdaftar-automation/env dist/meta-check.js [photo.jpg]
 * Prints status and latency per model; never prints the key.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MetaModels } from './ai/models.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
if (!cfg.ai.apiKey) {
  console.error('META_API_KEY is not set');
  process.exit(1);
}
const models = new MetaModels(cfg.ai, fetch);
const photoPath = process.argv[2] ?? fileURLToPath(new URL('../test/fixtures/product.jpg', import.meta.url));
const photo = await readFile(photoPath);

async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`✓ ${name} (${Date.now() - t} ms): ${out.slice(0, 120).replace(/\s+/g, ' ')}`);
    return true;
  } catch (e) {
    console.log(`✗ ${name} (${Date.now() - t} ms): ${(e as Error).message.slice(0, 300)}`);
    return false;
  }
}

const results = [
  await step(`chat ${cfg.ai.textModel}`, () =>
    models.chat([{ role: 'user', content: 'Reply with JSON {"ok":true,"lang":"uz"} only.' }], { json: true, maxTokens: 30 }),
  ),
  await step(`vision ${cfg.ai.visionModel}`, () =>
    models.chat(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe the main object in 5 words.' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${photo.toString('base64')}` } },
          ],
        },
      ],
      { vision: true, maxTokens: 40 },
    ),
  ),
  await step(`segment ${cfg.ai.segmentModel}`, async () => {
    const raw = await models.samRaw(photo, 'product');
    const crop = await models.segmentProduct(photo, 'product');
    if (!crop) throw new Error(`no box parsed; raw output starts: ${raw.slice(0, 200)}`);
    return `crop ${crop.length} bytes`;
  }),
  await step(`image ${cfg.ai.imageModel}`, async () => {
    const img = await models.stageProduct(photo, 'Place this exact object on a clean white studio background.');
    return img ? `image ${img.length} bytes` : 'no image returned';
  }),
];
process.exit(results.every(Boolean) ? 0 : 1);
