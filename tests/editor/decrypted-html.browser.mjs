// Run against an existing dev server: EDITOR_TEST_URL=http://localhost:4321 node --import tsx tests/editor/decrypted-html.browser.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { encryptEditorContent } from '../../src/features/editor/crypto.ts';

const testOrigin = new URL(process.env.EDITOR_TEST_URL ?? 'http://localhost:4321');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(new URL('/editor', testOrigin).href, { waitUntil: 'domcontentloaded' });
  await page.locator('.cm-content').waitFor();
  const previewElement = await page.locator('iframe[title="实际博文实时预览"]').elementHandle();
  const preview = await previewElement?.contentFrame();
  assert.ok(preview, 'preview iframe is loaded');
  await preview.locator('.custom-content').waitFor();
  await page.evaluate(() => {
    window.__previewXss = 0;
  });

  const send = async (source) => {
    await page.evaluate((markdown) => {
      document.querySelector('iframe[title="实际博文实时预览"]').contentWindow.postMessage(
        {
          type: 'koharu-preview-source',
          source: markdown,
          mode: 'body',
          dark: false,
        },
        location.origin,
      );
    }, source);
  };

  for (const className of ['encrypted-block', 'encrypted-post']) {
    const marker = `Safe ${className} decrypted`;
    const payload = `<p>${marker}</p><img src="/missing-xss-test-image.png" onerror="window.parent.__previewXss += 1"><svg onload="window.parent.__previewXss += 10"></svg><a href="javascript:window.parent.__previewXss += 100">bad URL</a><script>window.parent.__previewXss += 1000</script>`;
    const data = await encryptEditorContent(payload, 'regression-password');
    await send(`<div class="${className}" data-cipher="${data.cipher}" data-iv="${data.iv}" data-salt="${data.salt}"></div>`);
    await preview.locator(`.${className} input[type="password"]`).waitFor();
    await preview.locator(`.${className} input[type="password"]`).fill('regression-password');
    await preview.locator(`.${className} input[type="password"]`).press('Enter');
    await preview.getByText(marker).waitFor();
    await preview.locator('img[src="/missing-xss-test-image.png"]').evaluate(async (image) => {
      if (!image.complete)
        await new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        });
    });
    assert.equal(
      await preview
        .locator(
          '.custom-content [onerror], .custom-content [onload], .custom-content script, .custom-content [href^="javascript:"]',
        )
        .count(),
      0,
    );
    assert.equal(await page.evaluate(() => window.__previewXss), 0);
    console.log(
      `PASS: prebuilt ${className} ciphertext decrypts harmless text and strips event handlers, scripts and active URLs`,
    );
  }

  for (const className of ['encrypted-block', 'encrypted-post']) {
    const data = await encryptEditorContent('<script>window.parent.__previewXss += 1000</script>', 'regression-password');
    await send(`<div class="${className}" data-cipher="${data.cipher}" data-iv="${data.iv}" data-salt="${data.salt}"></div>`);
    await preview.locator(`.${className} input[type="password"]`).waitFor();
    await preview.locator(`.${className} input[type="password"]`).fill('regression-password');
    await preview.locator(`.${className} input[type="password"]`).press('Enter');
    await preview.locator('.custom-content input[type="password"]').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.__previewXss), 0);
    if (className === 'encrypted-post') assert.equal(await preview.locator('.custom-content [data-cipher]').count(), 0);
    console.log(`PASS: sanitized-empty ${className} unlocks safely`);
  }
  assert.deepEqual(pageErrors, []);
} finally {
  await browser.close();
}
