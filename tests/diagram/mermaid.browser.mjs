import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from '@playwright/test';

// Run against pnpm dev or pnpm preview; phone-size viewports do not substitute for a real phone.
const origin = process.env.DIAGRAM_TEST_ORIGIN || 'http://127.0.0.1:4321';
const engines = { chromium, firefox, webkit };
const browsers = (process.env.DIAGRAM_TEST_BROWSERS || 'firefox,chromium').split(',');

for (const name of browsers) {
  assert.ok(engines[name], `Unknown browser: ${name}`);
  const browser = await engines[name].launch();
  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport, colorScheme: 'dark' });
      try {
        await page.goto(`${origin}/post/markdown-features`);
        const wrapper = page.locator('.mermaid-wrapper').first();
        const pre = wrapper.locator('pre.mermaid');
        const toggle = wrapper.getByRole('button', { name: /查看源码|查看渲染结果/ });
        await toggle.waitFor();
        await page.waitForFunction(() => document.querySelector('pre.mermaid[data-diagram-sized] > svg'));
        const source = await pre.getAttribute('data-diagram');
        assert.match(source, /^flowchart/);
        assert.ok(await pre.isVisible());
        const initialId = await pre.locator('svg').getAttribute('id');

        // A theme repaint must not replace the source view or restore a stale SVG snapshot.
        await toggle.click();
        assert.equal(await wrapper.locator('.mermaid-source code').textContent(), source);
        assert.ok(await pre.isHidden());
        await page.evaluate(() => {
          document.documentElement.dataset.theme = 'light';
          document.documentElement.classList.remove('dark');
        });
        await page.waitForFunction((id) => {
          const pre = document.querySelector('pre.mermaid');
          return pre.dataset.processed === 'true' && pre.querySelector('svg')?.id !== id;
        }, initialId);
        assert.equal(await wrapper.locator('.mermaid-source code').textContent(), source);
        const refreshedId = await pre.locator('svg').getAttribute('id');
        await toggle.click();
        assert.ok(await pre.isVisible());
        assert.equal(await pre.locator('svg').getAttribute('id'), refreshedId);

        // Drive astro-mermaid's actual error path rather than synthesizing an error message.
        await pre.evaluate((element) => {
          element.dataset.diagram = 'invalid diagram syntax';
          element.removeAttribute('data-processed');
        });
        await page.evaluate(() => {
          document.documentElement.dataset.theme = 'dark';
          document.documentElement.classList.add('dark');
        });
        await wrapper.getByRole('status').waitFor();
        assert.match(await wrapper.getByRole('status').textContent(), /图表暂时无法显示/);
        assert.ok(await pre.isHidden());
        assert.ok(await wrapper.getByRole('button', { name: '全屏查看', exact: true }).isDisabled());
        assert.ok(await wrapper.getByRole('button', { name: '刷新重试' }).isVisible());
        await toggle.click();
        assert.equal(await wrapper.locator('.mermaid-source code').textContent(), 'invalid diagram syntax');
        await toggle.click();

        // A later successful render must recover from the error state.
        await pre.evaluate((element, definition) => {
          element.dataset.diagram = definition;
          element.removeAttribute('data-processed');
        }, source);
        await page.evaluate(() => {
          document.documentElement.dataset.theme = 'light';
        });
        await page.waitForFunction(() => document.querySelector('pre.mermaid[data-processed="true"] > svg'));
        await wrapper.getByRole('status').waitFor({ state: 'detached' });
        assert.ok(await pre.isVisible());

        // Rehydrate a rendered block whose canonical source is missing. Its SVG CSS must stay out of source view.
        await page.evaluate(() => {
          const pre = document.querySelector('pre.mermaid').cloneNode(true);
          pre.removeAttribute('data-diagram');
          pre.removeAttribute('data-react-enhanced');
          pre.id = 'missing-mermaid-source';
          document.querySelector('.custom-content').appendChild(pre);
          document.dispatchEvent(new CustomEvent('content:decrypted'));
        });
        const missingSource = page.locator('.mermaid-wrapper').filter({ has: page.locator('#missing-mermaid-source') });
        const sourceButton = missingSource.getByRole('button', { name: '查看源码' });
        await sourceButton.waitFor();
        assert.ok(await sourceButton.isDisabled(), 'SVG style text must never become Mermaid source');
        assert.equal(await missingSource.locator('.mermaid-source').count(), 0);
        console.log(`PASS ${name} ${viewport.width}px: render, theme/source, failure, recovery, missing source`);
      } finally {
        await page.close();
      }
    }
    if (name === 'firefox') {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        let blockedImports = 0;
        await page.route(/\/mermaid(?:\.core)?[^/]*\.js(?:\?|$)/, async (route) => {
          blockedImports++;
          await route.abort();
        });
        await page.goto(`${origin}/post/markdown-features`);
        const wrapper = page.locator('.mermaid-wrapper').first();
        await wrapper.getByRole('status').waitFor({ timeout: 25000 });
        assert.ok(blockedImports > 0, 'The test must block the actual Mermaid import');
        assert.match(await wrapper.getByRole('status').textContent(), /图表加载时间较长/);
        assert.equal(await wrapper.locator('pre.mermaid').getAttribute('data-processed'), null);
        await page.unrouteAll();
        await wrapper.getByRole('button', { name: '刷新重试' }).click();
        await page.waitForFunction(() => document.querySelector('pre.mermaid[data-diagram-sized] > svg'));
        console.log('PASS firefox: blocked Mermaid import shows delay notice; reload recovers');
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
