// One-off check: inspector pane state is per session.
const { chromium } = require('playwright');

const conv = (id, title) => ({ id, title, mode: 'code', updatedAt: 1750000000000, createdAt: 1740000000000, running: false, pinned: false, projectId: null, automationId: null });

const bootstrap = {
  version: '0.0.0-test', home: '/tmp', platform: 'linux', hosted: false, workspace: '/tmp/ws',
  settings: {}, provider: { name: 'test' }, features: {}, profiles: [], status: { workspace: '/tmp/ws' },
  conversations: [conv('a1', 'Alpha'), conv('b1', 'Beta')], projects: [],
};
const snapshot = (id) => ({ ...conv(id), items: [], workspace: '/tmp/ws', cwd: '/tmp/ws', running: false });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    let body = {};
    if (p === '/api/bootstrap') body = bootstrap;
    else if (/^\/api\/conversations\/[^/]+$/.test(p)) body = snapshot(p.split('/').pop());
    else if (p === '/api/edits') body = { edits: [] };
    else if (p === '/api/status') body = { workspace: '/tmp/ws' };
    else if (p === '/api/projects') body = { projects: [] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  await page.goto('http://127.0.0.1:5199/#/c/a1');
  await page.waitForSelector('[aria-label="Toggle inspector"]');
  const aside = page.locator('aside[aria-label="Inspector"]');
  const box = async () => (await aside.boundingBox())?.width ?? 0;
  const selected = () => page.locator('[role="tab"][aria-selected="true"]').first().innerText();

  console.log('A initial width:', await box());
  await page.click('[aria-label="Toggle inspector"]');
  await page.waitForTimeout(400);
  console.log('A opened width:', Math.round(await box()), 'tab:', await selected());

  await page.click('[role="tab"]:has-text("Changes")');
  await page.waitForTimeout(200);
  console.log('A tab:', await selected());

  await page.goto('http://127.0.0.1:5199/#/c/b1');
  await page.waitForTimeout(600);
  console.log('B width (expect 0):', Math.round(await box()));

  await page.goto('http://127.0.0.1:5199/#/c/a1');
  await page.waitForTimeout(700);
  console.log('A again width:', Math.round(await box()), 'tab (expect Changes):', await selected());

  console.log('localStorage:', await page.evaluate(() => localStorage.getItem('shmakk.rightByConv')));
  await browser.close();
})();
