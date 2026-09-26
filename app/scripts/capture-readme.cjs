// Actual production panel, disposable example data, no Codex runtime connection.
// Uses the same optional PLAYWRIGHT_MODULE / CHROMIUM_PATH as test:browser.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

async function main() {
  const app = path.resolve(__dirname, '..');
  const output = path.join(app, 'output', 'playwright', 'readme');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'threadbrief-readme-'));
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const { createPanelService } = await import(pathToFileURL(path.join(app, 'lib/panel-service.mjs')).href);
  const entries = [
    ['skill:review', '代码审阅', 'skill'], ['skill:writing', '技术写作', 'skill'],
    ['skill:ui', '界面设计', 'skill'], ['mcp:docs', '文档检索', 'mcp'],
    ['mcp:browser', '浏览器工具', 'mcp'], ['plugin:workspace', '工作区助手', 'plugin'],
    ['app:notes', '笔记应用', 'app'],
  ];
  const catalog = entries.map(([id, name, kind]) => ({ id, name, kind,
    defaultEnabled: true, available: true, effective: null,
    source: 'README 演示目录', reason: '公开示例；未连接真实工具',
  }));
  let service, browser;
  const pageErrors = [], screenshots = [];
  try {
    await fs.mkdir(output, { recursive: true });
    service = await createPanelService({
      binding: { threadId: randomUUID(), hostId: 'readme-demo', accountScope: 'public-examples', title: '代码审阅 · 示例任务' },
      dataDirectory: path.join(temporary, 'data'), catalog, port: 0,
    });
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
    const page = await browser.newPage({ viewport: { width: 412, height: 1100 }, deviceScaleFactor: 2, colorScheme: 'light' });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(service.url);
    const version = revision => page.waitForFunction(expected => document.getElementById('version').textContent === `v${expected}`, revision);
    const shot = async name => {
      await page.locator('.panel').screenshot({ path: path.join(output, name) });
      screenshots.push(name);
    };
    await version(0);
    await shot('card-collapsed.png');
    await page.locator('#expand').click();
    const save = async (persona, background, revision) => {
      await page.locator('#tab-profile').click();
      await page.locator('#persona').fill(persona);
      await page.locator('#background').fill(background);
      await page.locator('#apply').click();
      await version(revision);
    };
    const nameVersion = async (revision, name) => {
      if (!await page.locator('#history').evaluate(node => node.open)) await page.locator('#history > summary').click();
      await page.getByRole('button', { name: `管理版本 ${revision}`, exact: true }).click();
      await page.getByRole('button', { name: `重命名版本 ${revision}`, exact: true }).click();
      await page.getByRole('textbox', { name: `版本 ${revision} 的名称`, exact: true }).fill(name);
      await page.getByRole('button', { name: `保存版本 ${revision} 名称`, exact: true }).click();
      await page.locator(`.history-item[data-revision="${revision}"] .history-label`).filter({ hasText: name }).waitFor();
      await page.locator('#history > summary').click();
    };
    await save('担任技术写作伙伴，使用清晰、简洁的中文。', '为一个开源项目编写使用说明，面向初次使用者。', 1);
    await nameVersion(1, '技术写作');
    await save('担任实现伙伴，将需求拆成可验证的小改动。', '为一个开源项目完善任务面板，优先保持现有行为。', 2);
    await nameVersion(2, '实现伙伴');
    await page.locator('#persona').fill('担任代码审阅伙伴，先指出问题，再给出依据。');
    await page.locator('#background').fill('审阅一个开源项目的改动，重点关注任务隔离、兼容性和可维护性。');
    await page.locator('#tab-capabilities').click();
    await page.locator('.switch[data-capability-id="skill:review"]').click();
    await page.locator('.switch[data-capability-id="skill:writing"]').click();
    await page.locator('#apply').click();
    await version(3);
    await nameVersion(3, '代码审阅');
    await page.locator('#tab-profile').click();
    await shot('card-profile.png');
    await page.locator('#tab-capabilities').click();
    assert.equal(await page.locator('.switch[aria-checked="true"]').count(), 2);
    assert.match(await page.locator('#save-status').innerText(), /未接通/);
    await shot('card-capabilities.png');
    await page.locator('#tab-profile').click();
    await page.locator('#history > summary').click();
    await page.getByRole('button', { name: '管理版本 2', exact: true }).click();
    await shot('card-history.png');
    assert.equal((await service.state()).history.length, 3);
    assert.deepEqual(pageErrors, []);
    const hashes = {};
    for (const rel of ['public/index.html', 'public/panel.js', 'public/panel.css']) {
      hashes[rel] = createHash('sha256').update(await fs.readFile(path.join(app, rel))).digest('hex');
    }
    await fs.writeFile(path.join(output, 'capture.json'), JSON.stringify({
      source: 'Production panel served by createPanelService', data: 'Public examples and a demonstration capability catalog',
      nativeCodexConnected: false, screenshots, pageErrors, sourceHashes: hashes,
    }, null, 2) + '\n');
    console.log(JSON.stringify({ output, screenshots, pageErrors }));
  } finally {
    if (browser) await browser.close();
    if (service) await service.close();
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep + 'threadbrief-readme-'));
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
