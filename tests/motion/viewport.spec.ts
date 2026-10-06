import { expect, test } from '@playwright/test';

test('cover geometry stays stable as the mobile dynamic viewport changes', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Mobile browser controls change the dynamic viewport independently of the small viewport.');
  const cdp = await page.context().newCDPSession(page);
  await page.goto('/post/getting-started');
  await page.waitForFunction(() => customElements.get('sakura-petals'));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2000);
  // CDP applies height and the svh difference in separate messages. Prevent its
  // intermediate state from anchoring the scroll before checking the final geometry.
  await page.addStyleTag({ content: 'html { overflow-anchor: none; }' });
  await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.id = 'small-viewport-probe';
    probe.style.cssText = 'position:fixed;width:0;height:100svh;pointer-events:none';
    document.body.append(probe);
    window.scrollTo({ top: 600, behavior: 'instant' });
  });
  const geometry = () =>
    page.evaluate(() => {
      const article = document.querySelector('article')?.getBoundingClientRect();
      const cover = document.querySelector('.cover-hero')?.getBoundingClientRect();
      const wave = document.querySelector('.wave-wrap')?.getBoundingClientRect();
      const copy = document.querySelector('.cover-copy');
      if (!article || !cover || !wave || !copy) throw new Error('Article cover is missing');
      return {
        articleTop: article.top + window.scrollY,
        coverHeight: cover.height,
        waveHeight: wave.height,
        copyBottom: getComputedStyle(copy).bottom,
      };
    });
  const initial = await geometry();
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Viewport is required');
  const smallHeight = viewport.height;
  // CDP has no real browser toolbar. Keep svh fixed while sweeping dvh, instead of
  // treating a normal viewport resize (where both units change) as toolbar emulation.
  for (const [index, delta] of [0, 20, 40, 60, 80, 60, 40, 20, 0].entries()) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), 600 + index * 20);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: smallHeight + delta,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send('Emulation.setSmallViewportHeightDifferenceOverride', { difference: delta });
    await expect(page.locator('#small-viewport-probe')).toHaveCSS('height', `${smallHeight}px`);
    await expect.poll(geometry).toEqual(initial);
    expect(await page.evaluate(() => window.scrollY)).toBe(600 + index * 20);
  }
});

test('cover responds to a real window resize and orientation change', async ({ page, isMobile }) => {
  await page.goto('/post/getting-started');
  const height = () => page.locator('.cover-hero').evaluate((el) => el.getBoundingClientRect().height);
  const initial = await height();
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Viewport is required');
  await page.setViewportSize(
    isMobile ? { width: viewport.height, height: viewport.width } : { width: viewport.width, height: viewport.height - 200 },
  );
  await expect.poll(height).not.toBe(initial);
  await expect.poll(height).toBeCloseTo((isMobile ? viewport.width : viewport.height - 200) * 0.6, 1);
});

test('desktop directory stays in place when the navigation hides and reveals', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The sticky directory is displayed on desktop.');
  await page.goto('/post/getting-started');
  await page.waitForFunction(() => {
    const nav = document.querySelector('astro-island[component-url*="Navigator"]');
    return nav && !nav.hasAttribute('ssr');
  });
  const header = page.locator('#site-header');
  const sider = page.locator('.page-home-sider');
  const top = () => sider.evaluate((el) => el.getBoundingClientRect().top);
  await page.evaluate(() => window.scrollTo({ top: 1000, behavior: 'instant' }));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }));
  await expect(header).not.toHaveClass(/-translate-y-full/);
  await page.waitForTimeout(600);
  const initial = await top();
  await page.evaluate(() => window.scrollTo({ top: 950, behavior: 'instant' }));
  await expect(header).toHaveClass(/-translate-y-full/);
  await page.waitForTimeout(350);
  expect(await top()).toBe(initial);
  await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }));
  await expect(header).not.toHaveClass(/-translate-y-full/);
  await page.waitForTimeout(600);
  expect(await top()).toBe(initial);
});
