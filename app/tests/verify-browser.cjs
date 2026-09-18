// Reproducible browser checks. All mutations use a fresh temporary store and random port.
// Run: node tests/verify-browser.cjs
// Optional: PLAYWRIGHT_MODULE=<module name or package directory> CHROMIUM_PATH=<executable>
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const appRoot = path.resolve(__dirname, '..');
const outputDirectory = path.join(appRoot, 'output', 'browser-check');

function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE);
  return require('playwright');
}

async function main() {
  const { chromium } = loadPlaywright();
  const executablePath = process.env.CHROMIUM_PATH;
  if (executablePath) await fs.access(executablePath);
  const { createPanelService } = await import(pathToFileURL(path.join(appRoot, 'lib', 'panel-service.mjs')).href);
  const parent = { id: 'test-plugin', name: '测试插件', kind: 'plugin', defaultEnabled: true, available: true, effective: null, childIds: ['test-skill'], source: '浏览器测试夹具' };
  const child = { id: 'test-skill', name: '测试技能', kind: 'skill', defaultEnabled: true, available: true, effective: null, parentId: parent.id, source: '浏览器测试夹具' };
  const catalog = [parent, child];
  const unavailableId = 'browser-check:unavailable-fixture';
  // This explicit test-only row exercises disabled UI; it never enters the production snapshot.
  const testCatalog = [...catalog, {
    id: unavailableId, name: '不可用能力（仅验证）', kind: 'mcp', defaultEnabled: false,
    available: false, effective: null, control: 'unavailable', reason: '验证不可用状态', source: '浏览器测试夹具'
  }];
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'threadbrief-browser-check-'));
  const binding = { threadId: randomUUID(), hostId: 'browser-check', accountScope: 'isolated-test-only', title: '任务配置交互验证' };
  const checks = [];
  const pageErrors = [];
  const configWrites = [];
  const report = {
    checkedAt: new Date().toISOString(), passed: false,
    evidenceScope: 'Isolated local service and Chromium; not native Codex mount or model-application proof',
    productionConfigTouched: false, catalogSource: 'synthetic test fixture',
    catalogItems: catalog.length, threadId: binding.threadId, checks,
    pageErrors, screenshots: []
  };
  let service;
  let browser;
  await fs.mkdir(outputDirectory, { recursive: true });
  const saveScreenshot = async (page, filename) => {
    await page.locator('.panel').screenshot({ path: path.join(outputDirectory, filename) });
    report.screenshots.push(filename);
  };
  const waitVersion = (page, revision) => page.waitForFunction(expected => document.getElementById('version').textContent === `v${expected}`, revision);
  try {
    service = await createPanelService({
      binding, catalog: testCatalog, port: 0,
      dataDirectory: path.join(temporaryDirectory, 'data'),
      evidenceDirectory: path.join(temporaryDirectory, 'evidence')
    });
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 444, height: 950 }, colorScheme: 'light' });
    const stale = await browser.newPage({ viewport: { width: 420, height: 900 } });
    for (const current of [page, stale]) {
      current.on('pageerror', error => pageErrors.push(error.message));
      current.on('request', request => { if (request.method() === 'PUT') configWrites.push(request.url()); });
    }
    await Promise.all([page.goto(service.url), stale.goto(service.url)]);
    await waitVersion(page, 0);
    await waitVersion(stale, 0);
    assert.equal(await page.locator('#card-content').isVisible(), false);
    const collapsed = await page.locator('.card').boundingBox();
    assert.equal(collapsed.height, 42);
    assert.equal(collapsed.width, 380);
    report.collapsedHeight = collapsed.height;
    report.maximumWidth = collapsed.width;
    await saveScreenshot(page, '01-collapsed-light.png');
    await page.setViewportSize({ width: 380, height: 900 });
    await page.locator('#expand').click();
    assert.equal(await page.locator('#history').evaluate(node => node.open), false);
    assert.equal(await page.locator('#reset').isVisible(), false);
    assert.equal(await page.locator('#cancel').isVisible(), false);
    await saveScreenshot(page, '02-profile-light-380.png');
    await page.locator('#tab-capabilities').click();
    await saveScreenshot(page, '03-capabilities-light-380.png');
    assert.match(await page.locator('#capability-list').innerText(), /默认 · 未确认/);
    assert.match(await page.locator('#save-status').innerText(), /未接通/);
    assert.equal(await page.locator('.capability-source').count(), 0);
    assert.match(await page.locator('.capability-name').first().getAttribute('title'), /来源：/);
    assert.equal((await service.state()).catalog.every(item => item.effective === null), true);
    assert.equal(configWrites.length, 0);
    assert.equal((await service.state()).config.revision, 0);
    checks.push('42px default collapse, max 380px; opening does not write configuration');
    checks.push('One save action; details collapsed; effective:null remains unconfirmed and integration remains honest');
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await saveScreenshot(page, '04-capabilities-light-320.png');
    await page.emulateMedia({ colorScheme: 'dark' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await saveScreenshot(page, '05-capabilities-dark-320.png');
    await page.locator('#tab-profile').click();
    await saveScreenshot(page, '06-profile-dark-320.png');
    await page.locator('#tab-capabilities').click();
    await page.setViewportSize({ width: 380, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await saveScreenshot(page, '07-capabilities-dark-380.png');
    checks.push('320px and 380px light/dark layouts have no horizontal overflow');

    // Keep the second tab dirty before the first save so the five-second read poll cannot rebase it.
    await stale.locator('#expand').click();
    await stale.locator('#persona').fill('保留的冲突草稿');
    await page.locator('#tab-profile').click();
    await page.locator('#persona').fill('中文项目伙伴');
    await page.locator('#background').fill('只在此任务保存的长期背景');
    assert.equal((await service.state()).config.revision, 0);
    await page.locator('#tab-capabilities').click();
    const switchFor = async id => {
      const index = await page.locator('.switch').evaluateAll((nodes, expected) => nodes.findIndex(node => node.dataset.capabilityId === expected), id);
      assert.notEqual(index, -1, `Capability switch must exist: ${id}`);
      return page.locator('.switch').nth(index);
    };
    await page.locator('#category-plugin').click();
    let parentSwitch = await switchFor(parent.id);
    if ((await parentSwitch.getAttribute('aria-checked')) !== 'true') await parentSwitch.click();
    await page.locator('#category-skill').click();
    let childSwitch = await switchFor(child.id);
    if ((await childSwitch.getAttribute('aria-checked')) !== 'true') await childSwitch.click();
    await childSwitch.focus();
    await page.keyboard.press('Space');
    assert.equal(await childSwitch.getAttribute('aria-checked'), 'false');
    await page.keyboard.press('Space');
    assert.equal(await childSwitch.getAttribute('aria-checked'), 'true');
    checks.push('Keyboard Space toggles requested capability preference');
    await page.locator('#category-plugin').click();
    parentSwitch = await switchFor(parent.id);
    await parentSwitch.click();
    await page.locator('#category-skill').click();
    childSwitch = await switchFor(child.id);
    assert.equal(await childSwitch.isDisabled(), true);
    assert.equal(await childSwitch.getAttribute('aria-checked'), 'false');
    assert.match(await page.locator('#capability-list').innerText(), /插件已关闭/);
    await page.locator('#category-mcp').click();
    assert.equal(await (await switchFor(unavailableId)).isDisabled(), true);
    await page.locator('#category-app').click();
    if (!catalog.some(item => item.kind === 'app')) {
      assert.match(await page.locator('#capability-list').innerText(), /暂无此类目录/);
      checks.push('Missing capability category displays an honest empty state');
    }
    checks.push('Unavailable capability is disabled');
    await page.locator('#apply').click();
    await waitVersion(page, 1);
    let saved = await service.state();
    assert.equal(saved.config.persona, '中文项目伙伴');
    assert.equal(saved.config.background, '只在此任务保存的长期背景');
    assert.equal(saved.config.overrides[child.id], 'on');
    assert.equal(saved.config.overrides[parent.id], 'off');
    assert.equal(await page.locator('#card-content').isVisible(), true);
    checks.push('Chinese profile persists; Apply keeps panel expanded');
    checks.push('Parent off blocks child while preserving explicit child-on preference');

    await stale.locator('#apply').click();
    await stale.locator('#reload').waitFor();
    assert.equal(await stale.locator('#persona').inputValue(), '保留的冲突草稿');
    assert.equal(await stale.locator('#apply').isDisabled(), true);
    assert.equal((await service.state()).config.revision, 1);
    await saveScreenshot(stale, '08-conflict-keeps-draft.png');
    await stale.locator('#reload').click();
    await waitVersion(stale, 1);
    assert.equal(await stale.locator('#persona').inputValue(), '中文项目伙伴');
    checks.push('Real stale revision returns 409 and preserves draft; explicit reload discards it');

    await page.locator('#history > summary').click();
    await page.locator('#reset').click();
    assert.equal((await service.state()).config.revision, 1);
    await page.locator('#cancel').click();
    assert.equal(await page.locator('#apply').isDisabled(), true);
    await page.locator('#reset').click();
    await page.locator('#apply').click();
    await waitVersion(page, 2);
    saved = await service.state();
    assert.equal(saved.config.persona, '');
    assert.equal(saved.config.background, '');
    assert.deepEqual(saved.config.overrides, {});
    checks.push('Reset is staged; Cancel discards it; Apply saves the empty overlay');
    await page.locator('#history').evaluate(node => { node.open = true; });
    await page.getByRole('button', { name: '恢复版本 1', exact: true }).click();
    await waitVersion(page, 3);
    assert.equal((await service.state()).config.persona, '中文项目伙伴');
    checks.push('History rollback restores content as new revision v3');

    const beforeHistoryEdits = structuredClone((await service.state()).config);
    const manage = revision => page.getByRole('button', { name: `管理版本 ${revision}`, exact: true });
    await manage(3).click();
    assert.equal(await page.getByRole('button', { name: '删除版本 3', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '重命名版本 3', exact: true }).click();
    await page.getByRole('textbox', { name: '版本 3 的名称', exact: true }).fill('中文审阅伙伴');
    await page.getByRole('button', { name: '保存版本 3 名称', exact: true }).click();
    await page.locator('.history-item[data-revision="3"] .history-label').filter({ hasText: '中文审阅伙伴' }).waitFor();
    assert.deepEqual((await service.state()).config, beforeHistoryEdits);
    await page.reload();
    await waitVersion(page, 3);
    await page.locator('#expand').click();
    await page.locator('#history').evaluate(node => { node.open = true; });
    assert.equal(await page.locator('.history-item[data-revision="3"] .history-label').innerText(), '中文审阅伙伴');
    checks.push('Current version can be renamed durably without changing configuration; current deletion is protected');

    await manage(1).click();
    await page.getByRole('button', { name: '删除版本 1', exact: true }).click();
    await page.getByRole('button', { name: '取消版本操作', exact: true }).click();
    assert.equal((await service.state()).history.some(entry => entry.revision === 1), true);
    await manage(1).click();
    await page.getByRole('button', { name: '删除版本 1', exact: true }).click();
    await page.getByRole('button', { name: '确认删除版本 1', exact: true }).click();
    await page.locator('.history-item[data-revision="1"]').waitFor({ state: 'detached' });
    assert.deepEqual((await service.state()).config, beforeHistoryEdits);
    assert.equal((await service.state()).history.some(entry => entry.revision === 1), false);
    await saveScreenshot(page, '09-version-history.png');
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    checks.push('Historical deletion requires explicit confirmation, cancel preserves it, and delete leaves current configuration intact');

    // Simulate another tab changing history after this tab started editing.
    await manage(2).click();
    await page.getByRole('button', { name: '重命名版本 2', exact: true }).click();
    await page.getByRole('textbox', { name: '版本 2 的名称', exact: true }).fill('保留的名称草稿');
    const concurrentState = await service.state();
    const concurrentRename = await fetch(service.url + '/api/history/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: service.origin },
      body: JSON.stringify({ expectedRevision: 3, expectedHistoryRevision: concurrentState.historyRevision, targetRevision: 2, name: '另一面板命名' })
    });
    assert.equal(concurrentRename.status, 200);
    // Polling while an inline editor is open must not discard its text or silently rebase its CAS.
    await page.waitForTimeout(5200);
    assert.equal(await page.locator('#version-name').inputValue(), '保留的名称草稿');
    await page.getByRole('button', { name: '保存版本 2 名称', exact: true }).click();
    await page.locator('#reload').waitFor();
    assert.equal(await page.locator('#version-name').inputValue(), '保留的名称草稿');
    assert.equal((await service.state()).history.find(entry => entry.revision === 2).name, '另一面板命名');
    await page.locator('#reload').click();
    await page.locator('.history-item[data-revision="2"] .history-label').filter({ hasText: '另一面板命名' }).waitFor();
    assert.equal(await page.locator('#version-name').count(), 0);
    checks.push('Concurrent history edits return 409; polling and conflict preserve rename draft until explicit reload');

    await page.locator('#persona').fill('未保存的人设草稿');
    assert.equal(await manage(2).isDisabled(), true);
    assert.equal(await page.locator('#persona').inputValue(), '未保存的人设草稿');
    await page.locator('#cancel').click();
    assert.deepEqual((await service.state()).config, beforeHistoryEdits);
    checks.push('Unsaved profile drafts disable history management and are never overwritten by it');

    const receipt = JSON.parse(await fs.readFile(path.join(temporaryDirectory, 'evidence', 'panel-visible.json'), 'utf8'));
    assert.equal(receipt.threadId, binding.threadId);
    assert.equal(receipt.width > 0, true);
    assert.deepEqual(pageErrors, []);
    report.browserUserAgent = receipt.userAgent;
    report.configWriteRequests = configWrites.length;
    checks.push('Visible receipt received on isolated service; no JavaScript page errors');
    await stale.close();
    const previousUrl = new URL(service.url);
    await service.close();
    service = null;
    service = await createPanelService({
      binding, catalog: testCatalog, port: Number(previousUrl.port), panelToken: previousUrl.pathname.split('/')[2],
      dataDirectory: path.join(temporaryDirectory, 'data'),
      evidenceDirectory: path.join(temporaryDirectory, 'evidence')
    });
    const reconnectDeadline = Date.now() + 9000;
    while ((await service.state()).integration.mount.status !== 'page-observed' && Date.now() < reconnectDeadline) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal((await service.state()).integration.mount.status, 'page-observed');
    assert.equal((await service.state()).config.revision, 3);
    assert.equal((await service.state()).history.find(entry => entry.revision === 3).name, '中文审阅伙伴');
    assert.equal((await service.state()).history.some(entry => entry.revision === 1), false);
    assert.equal(configWrites.length, report.configWriteRequests);
    checks.push('Existing page reconnects after restart at the same address and resends visibility without configuration writes');
    report.passed = true;
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    report.completedAt = new Date().toISOString();
    await browser?.close();
    await service?.close();
    // The directory is the exact absolute path returned by mkdtemp, under the OS temp directory.
    const resolvedTemporary = path.resolve(temporaryDirectory);
    const temporaryRoot = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolvedTemporary), temporaryRoot);
    assert.equal(path.basename(resolvedTemporary).startsWith('threadbrief-browser-check-'), true);
    await fs.rm(resolvedTemporary, { recursive: true, force: true });
    report.temporaryStoreRemoved = true;
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, report: path.join(outputDirectory, 'report.json'), screenshots: report.screenshots }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
