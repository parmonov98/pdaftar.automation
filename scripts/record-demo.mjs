// Records demo footage of the hackathon build in a real browser (1280×720 WebM per scene).
//   node scripts/record-demo.mjs <base-url> <token-file> <out-dir>
// Needs Playwright (the VPS has it at /home/devmurod/tools/playwright).
// Shows only what was built during the hackathon: Playground (text, photo, voice), Reels studio, Inbox.
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const [, , base = 'https://automation.pdaftar.uz', tokenFile, out = './demo-footage'] = process.argv;
if (!tokenFile) {
  console.error('usage: node scripts/record-demo.mjs <base-url> <token-file> <out-dir>');
  process.exit(1);
}
const pw = await import(process.env.PLAYWRIGHT ?? '/home/devmurod/tools/playwright/node_modules/playwright/index.mjs');
mkdirSync(out, { recursive: true });
const token = readFileSync(tokenFile, 'utf8').trim();
const photo = new URL('../api/test/fixtures/product.jpg', import.meta.url).pathname;

const browser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });

async function scene(name, fn) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: out, size: { width: 1280, height: 720 } },
    permissions: ['microphone'],
    locale: 'uz-UZ',
  });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.evaluate(() => localStorage.setItem('lang', 'uz'));
  await page.reload();
  await page.fill('#token', token);
  await page.click('button[type=submit]');
  await page.waitForURL('**/app/**');
  await fn(page);
  await page.waitForTimeout(1500);
  const video = page.video();
  await ctx.close();
  renameSync(await video.path(), join(out, `${name}.webm`));
  console.log('recorded', name);
}

const slowType = async (page, sel, text) => {
  await page.click(sel);
  await page.keyboard.type(text, { delay: 60 });
};

await scene('1-playground-text', async (page) => {
  await page.click('a[href="/app/playground"]');
  await slowType(page, '#pg-text', 'Qora futbolka narxi qancha?');
  await page.click('form button[type=submit]');
  await page.waitForSelector('.bubble.out', { timeout: 60000 });
  await page.click('details summary').catch(() => {});
  await page.waitForTimeout(2500);
  await page.fill('#pg-text', '');
  await slowType(page, '#pg-text', 'Цена на колу?');
  await page.click('form button[type=submit]');
  await page.waitForTimeout(4000);
});

await scene('2-playground-photo-voice', async (page) => {
  await page.click('a[href="/app/playground"]');
  await page.setInputFiles('input[type=file][accept^="image"]', photo);
  await slowType(page, '#pg-text', 'Shu bormi?');
  await page.click('form button[type=submit]');
  await page.waitForSelector('.bubble.out', { timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.click('button:has-text("Olib tashlash")');
  await page.fill('#pg-text', '');
  await page.click('button:has-text("Yozib olish")');
  await page.waitForTimeout(3000);
  await page.click('button:has-text("To‘xtatish")');
  await page.click('form button[type=submit]');
  await page.waitForTimeout(5000);
});

await scene('3-reels-studio', async (page) => {
  await page.click('a[href="/app/studio"]');
  await page.waitForSelector('.product:not([disabled])');
  const picks = page.locator('.product:not([disabled])');
  const n = Math.min(2, await picks.count());
  for (let i = 0; i < n; i++) await picks.nth(i).click();
  await page.click('.templates button:has-text("Yangi keldi")');
  await page.waitForTimeout(800);
  await page.click('button:has-text("Video yaratish")');
  await page.waitForSelector('video.video', { timeout: 180000 });
  await page.locator('video.video').first().scrollIntoViewIfNeeded();
  await page.evaluate(() => document.querySelector('video.video')?.play());
  await page.waitForTimeout(9000);
});

await scene('4-inbox', async (page) => {
  await page.click('a[href="/app/inbox"]');
  await page.waitForTimeout(2500);
  await page.click('[role=tab]:has-text("Direct")');
  await page.locator('.conv').first().click().catch(() => {});
  await page.waitForTimeout(3500);
});

await browser.close();
console.log(`footage in ${out}`);
