(() => {
  'use strict';
  const token = location.pathname.split('/')[2];
  const base = `/panel/${encodeURIComponent(token || '')}`;
  const $ = id => document.getElementById(id);
  const clone = value => structuredClone(value);
  const profile = config => ({ persona: config?.persona || '', background: config?.background || '', overrides: { ...(config?.overrides || {}) } });
  const signature = config => JSON.stringify([config?.persona || '', config?.background || '', Object.entries(config?.overrides || {}).sort(([a], [b]) => a.localeCompare(b))]);
  let state = null;
  let draft = null;
  let busy = false;
  let fetching = false;
  let kind = 'skill';
  let pane = 'profile';
  let conflict = false;
  let saveMessage = '';
  let renderTimer;
  let receiptPending = false;
  let lastReceipt = '';
  let error = '';
  let historyAction = null;

  const dirty = () => Boolean(state && draft && signature(draft) !== signature(state.config));
  const hasOverrides = config => Boolean(config?.persona || config?.background || Object.keys(config?.overrides || {}).length);
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  async function request(path, method = 'GET', body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(base + path, {
        method, credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = new Error(typeof result?.error === 'string' ? result.error : result?.error?.message || result?.message || `请求失败（${response.status}）`);
        failure.status = response.status;
        throw failure;
      }
      return result;
    } finally { clearTimeout(timer); }
  }

  function validState(next) {
    return Boolean(next && next.thread && typeof next.thread.id === 'string' && next.config && Number.isInteger(next.config.revision) && Array.isArray(next.catalog));
  }

  function accept(next) {
    if (!validState(next)) throw new Error('宿主返回了无法识别的配置，请重新连接。');
    if (state && state.thread.id !== next.thread.id) throw new Error('任务标识发生变化。为避免写入其他任务，请重新打开正确的任务面板。');
    state = next;
    // A restarted service needs a fresh page receipt even if the layout is unchanged.
    if (next.integration?.mount?.status === 'waiting') lastReceipt = '';
    draft = profile(next.config);
    conflict = false;
    error = '';
    render(true);
    scheduleReceipt();
  }

  function fail(caught) {
    conflict = caught?.status === 409;
    error = conflict ? '版本已更新，草稿已保留。' : caught?.name === 'AbortError' ? '连接超时，草稿已保留。' : caught?.message || '连接中断，草稿已保留。';
    renderError();
    renderActions();
  }

  async function refresh({ discardDraft = false } = {}) {
    if (fetching || busy || (historyAction && !discardDraft)) return;
    if (discardDraft) historyAction = null;
    fetching = true;
    try {
      const next = await request('/api/state');
      if (!validState(next)) throw new Error('宿主返回了无法识别的配置，请重新连接。');
      if (dirty() && !discardDraft) {
        if (next.thread.id !== state.thread.id) throw new Error('任务标识发生变化，已保留当前草稿。');
        if (next.config.revision !== state.config.revision) {
          const changed = new Error('版本冲突'); changed.status = 409; throw changed;
        }
        state = { ...state, integration: next.integration, catalog: next.catalog, notice: next.notice, history: next.history, historyRevision: next.historyRevision };
        error = ''; conflict = false; render(false);
      } else {
        if (!state || next.config.revision !== state.config.revision) saveMessage = '';
        accept(next);
      }
    } catch (caught) { fail(caught); }
    finally { fetching = false; renderError(); }
  }

  function parentOf(item) {
    return state?.catalog.find(candidate => candidate.id === item.parentId || candidate.childIds?.includes(item.id));
  }

  function requested(item, seen = new Set()) {
    const mode = draft?.overrides[item.id] || 'inherit';
    if (seen.has(item.id)) return Boolean(item.defaultEnabled);
    seen.add(item.id);
    const parent = parentOf(item);
    if (parent && !requested(parent, seen)) return false;
    if (mode !== 'inherit') return mode === 'on';
    if (parent) {
      const parentMode = draft?.overrides[parent.id] || 'inherit';
      if (parentMode === 'on') return true;
    }
    return Boolean(item.defaultEnabled);
  }

  function renderCapabilities() {
    const list = $('capability-list');
    list.replaceChildren();
    list.setAttribute('aria-labelledby', `category-${kind}`);
    const catalog = state?.catalog || [];
    document.querySelectorAll('[data-count]').forEach(node => {
      const count = catalog.filter(item => item.kind === node.dataset.count).length;
      node.textContent = count ? String(count) : '';
    });
    const items = catalog.filter(item => item.kind === kind);
    if (!items.length) {
      list.append(element('div', 'empty-state', state ? '暂无此类目录' : '读取中…'));
      return;
    }
    items.forEach((item, index) => {
      const mode = draft?.overrides[item.id] || 'inherit';
      const control = item.control || 'unavailable';
      const parent = parentOf(item);
      const parentOff = Boolean(parent && !requested(parent));
      const row = element('div', 'capability');
      const text = element('div', 'capability-copy');
      const label = element('div', 'capability-name', item.name || item.id);
      label.id = `capability-name-${index}`;
      text.append(label);
      const description = element('p', 'capability-description');
      description.id = `capability-description-${index}`;
      const observed = item.executionPolicy === 'error' ? '暂不可用' : parentOff ? '插件已关闭' : !item.available || control === 'unavailable' ? '不可编辑'
        : item.inclusion === 'accepted' ? '已加入输入' : item.inclusion === 'next-turn' ? '下轮加入' : item.inclusion === 'stopped' ? '停止追加'
        : item.executionPolicy === 'observed' ? '执行校验已运行' : item.executionPolicy === 'registered' ? '执行校验已注册'
        : /读取失败/.test(item.reason || '') ? '读取失败' : /旧快照/.test(item.reason || '') ? '旧快照'
        : item.effective === true ? '观测开启' : item.effective === false ? '观测关闭' : '未确认';
      description.textContent = `${mode === 'inherit' ? '默认' : mode === 'on' ? '请求开启' : '请求关闭'} · ${observed}`;
      const detail = [item.name || item.id, item.reason, item.source && `来源：${item.source}`, parentOff && `所属插件“${parent.name || parent.id}”关闭；子项偏好仍保留`].filter(Boolean).join('\n');
      label.title = detail;
      const meta = element('div', 'capability-meta');
      meta.append(description);
      if (mode !== 'inherit') {
        const restore = element('button', 'revert', '恢复默认');
        restore.type = 'button'; restore.disabled = busy;
        restore.setAttribute('aria-label', `${item.name || item.id}：恢复默认`);
        restore.addEventListener('click', () => {
          delete draft.overrides[item.id]; saveMessage = ''; render(false);
        });
        meta.append(restore);
      }
      text.append(meta);
      const toggle = element('button', 'switch');
      toggle.type = 'button'; toggle.setAttribute('role', 'switch');
      toggle.dataset.capabilityId = item.id;
      toggle.setAttribute('aria-checked', String(requested(item)));
      toggle.setAttribute('aria-labelledby', label.id);
      toggle.setAttribute('aria-describedby', description.id);
      toggle.title = detail;
      toggle.disabled = busy || !item.available || control === 'unavailable' || parentOff;
      toggle.append(element('span', 'track'));
      toggle.addEventListener('click', () => {
        draft.overrides[item.id] = requested(item) ? 'off' : 'on';
        saveMessage = ''; render(false);
        $('capability-list').querySelectorAll('.switch')[index]?.focus();
      });
      row.append(text, toggle); list.append(row);
    });
  }

  function renderIntegration() {
    $('integration-status').replaceChildren();
    [['context', '人设与背景'], ['capabilities', '能力控制'], ['mount', '面板挂载']].forEach(([key, name]) => {
      const value = state?.integration?.[key];
      const dt = element('dt', '', name);
      const dd = element('dd', '', value?.label || '尚未确认');
      dd.dataset.status = ['applied', 'active', 'supported', 'connected', 'verified'].includes(value?.status) ? 'ok' : 'warning';
      $('integration-status').append(dt, dd);
    });
    $('notice').textContent = state?.notice || '';
    $('notice').hidden = !state?.notice;
  }

  function renderHistory() {
    const focused = document.activeElement;
    const selection = focused?.id === 'version-name' ? [focused.selectionStart, focused.selectionEnd] : null;
    const history = Array.isArray(state?.history) ? state.history : [];
    $('history-count').textContent = history.length ? `· ${history.length}` : '';
    const list = $('history-list'); list.replaceChildren();
    if (!history.length) { list.append(element('p', 'history-note', '暂无记录')); return; }
    if (dirty()) list.append(element('p', 'history-note', '先保存或取消草稿'));
    [...history].sort((a, b) => b.revision - a.revision).forEach(entry => {
      const item = element('div', 'history-item');
      item.dataset.revision = String(entry.revision);
      const row = element('div', 'history-row');
      const label = element('span', 'history-label', entry.name || `v${entry.revision}`);
      label.title = entry.name ? `${entry.name} · v${entry.revision}` : `v${entry.revision}`;
      row.append(label);
      if (entry.name) row.append(element('span', 'history-number', `v${entry.revision}`));
      const actions = element('div', 'history-actions');
      const disabled = dirty() || busy || conflict;
      if (entry.revision === state.config.revision) actions.append(element('span', 'history-current', '当前'));
      else {
        const restore = element('button', 'text-button', '恢复此版本');
        restore.type = 'button'; restore.disabled = disabled || Boolean(historyAction);
        restore.setAttribute('aria-label', `恢复版本 ${entry.revision}`);
        restore.addEventListener('click', () => rollback(entry.revision));
        actions.append(restore);
      }
      const more = element('button', 'history-more', '···');
      more.type = 'button'; more.disabled = disabled;
      more.setAttribute('aria-label', `管理版本 ${entry.revision}`);
      more.setAttribute('aria-expanded', String(historyAction?.revision === entry.revision));
      more.addEventListener('click', () => {
        historyAction = historyAction?.revision === entry.revision ? null : {
          revision: entry.revision, mode: 'menu', value: entry.name || '',
          expectedRevision: state.config.revision, expectedHistoryRevision: state.historyRevision
        };
        renderHistory();
      });
      actions.append(more); row.append(actions); item.append(row);
      if (historyAction?.revision === entry.revision) {
        const editor = element('div', 'history-editor');
        const addButton = (text, aria, callback, className = '') => {
          const button = element('button', className, text);
          button.type = 'button'; button.disabled = disabled;
          button.setAttribute('aria-label', aria); button.addEventListener('click', callback);
          editor.append(button); return button;
        };
        if (historyAction.mode === 'menu') {
          addButton('重命名', `重命名版本 ${entry.revision}`, () => {
            historyAction.mode = 'rename'; renderHistory(); $('version-name')?.focus();
          });
          const remove = addButton('删除', `删除版本 ${entry.revision}`, () => {
            historyAction.mode = 'delete'; renderHistory();
          }, 'danger');
          remove.disabled ||= entry.revision === state.config.revision;
          if (entry.revision === state.config.revision) remove.title = '当前版本正在使用，请先恢复其他版本或保存新版本。';
        } else if (historyAction.mode === 'rename') {
          const input = element('input', 'version-name');
          input.id = 'version-name'; input.type = 'text'; input.maxLength = 80;
          input.placeholder = `v${entry.revision}`; input.value = historyAction.value;
          input.setAttribute('aria-label', `版本 ${entry.revision} 的名称`); input.disabled = disabled;
          input.addEventListener('input', () => { historyAction.value = input.value; });
          input.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); manageVersion('rename'); }
            if (event.key === 'Escape') { historyAction = null; renderHistory(); }
          });
          editor.append(input);
          addButton('保存', `保存版本 ${entry.revision} 名称`, () => manageVersion('rename'));
          addButton('取消', '取消版本操作', () => { historyAction = null; renderHistory(); });
        } else {
          editor.append(element('p', 'history-confirm', '删除后将从历史列表移除，无法再恢复此版本。'));
          addButton('确认删除', `确认删除版本 ${entry.revision}`, () => manageVersion('delete'), 'danger');
          addButton('取消', '取消版本操作', () => { historyAction = null; renderHistory(); });
        }
        item.append(editor);
      }
      list.append(item);
    });
    if (selection && $('version-name') && !busy) {
      $('version-name').focus(); $('version-name').setSelectionRange(...selection);
    }
  }

  async function manageVersion(action) {
    if (!historyAction || !state || busy || dirty() || conflict) return;
    const pending = { ...historyAction };
    busy = true; render(false);
    try {
      const next = await request(`/api/history/${action}`, 'POST', {
        expectedRevision: pending.expectedRevision, expectedHistoryRevision: pending.expectedHistoryRevision,
        targetRevision: pending.revision, ...(action === 'rename' ? { name: pending.value } : {})
      });
      historyAction = null; accept(next);
      saveMessage = action === 'rename' ? '版本名称已保存' : '历史版本已删除';
    } catch (caught) { fail(caught); }
    finally { busy = false; render(false); }
  }

  function renderError() {
    $('error-banner').hidden = !error;
    $('error-message').textContent = error;
    $('reconnect').hidden = conflict;
    $('reload').hidden = !conflict;
    $('download-draft').hidden = !dirty();
    $('connection').textContent = error ? '连接需处理' : state ? '本地服务已连接' : '连接中';
    $('connection').dataset.connected = String(Boolean(state && !error));
  }

  function renderActions() {
    const changed = dirty();
    $('persona').disabled = !state || busy;
    $('background').disabled = !state || busy;
    $('apply').disabled = !state || busy || !changed || conflict;
    $('apply').textContent = busy ? '保存中…' : '保存';
    $('cancel').disabled = !changed || busy;
    $('reset').disabled = !state || busy || !hasOverrides(draft);
    $('summary').textContent = changed ? '未保存' : !state ? '连接中' : hasOverrides(state.config) ? `v${state.config.revision}` : '默认';
    $('summary').dataset.dirty = String(changed);
    $('save-status').dataset.dirty = String(changed);
    const status = state?.integration?.[pane === 'profile' ? 'context' : 'capabilities']?.status;
    const labels = { 'not-connected': '未接通', connected: pane === 'profile' ? '后续轮次应用' : '控制已接通', accepted: '宿主已接受', 'catalog-observed': '执行未确认', 'catalog-stale': '目录已过期', 'catalog-partial': '部分状态未知', 'pending-reload': '等待重载', 'partially-prepared': '部分已准备', error: pane === 'profile' ? '接入异常' : '能力控制暂不可用' };
    const saved = changed ? '未保存' : saveMessage || (hasOverrides(state?.config) ? `已保存 v${state.config.revision}` : '沿用默认');
    $('save-status').textContent = state ? `${saved} · ${labels[status] || '状态未确认'}` : '连接中';
  }

  function render(updateInputs) {
    const focusedCapability = document.activeElement?.dataset.capabilityId;
    if (state) {
      $('task-title').textContent = state.thread.title || '当前任务';
      $('task-title').title = `任务 ${state.thread.id}${state.thread.hostId ? ` · ${state.thread.hostId}` : ''}`;
      $('version').textContent = `v${state.config.revision}`;
      document.title = `${state.thread.title || '当前任务'} · 任务配置`;
    }
    if (updateInputs && draft) {
      $('persona').value = draft.persona;
      $('background').value = draft.background;
    }
    renderActions(); renderCapabilities(); renderIntegration(); renderHistory(); renderError();
    if (focusedCapability) {
      [...$('capability-list').querySelectorAll('.switch')].find(button => button.dataset.capabilityId === focusedCapability)?.focus();
    }
  }

  async function apply() {
    if (!state || busy || !dirty() || conflict) return;
    busy = true; render(false);
    try {
      const next = await request('/api/config', 'PUT', { expectedRevision: state.config.revision, ...clone(draft) });
      accept(next);
      saveMessage = `已保存 v${state.config.revision}`;
    } catch (caught) { fail(caught); }
    finally { busy = false; render(false); }
  }

  async function rollback(targetRevision) {
    if (!state || busy || dirty() || conflict) return;
    busy = true; render(false);
    try {
      accept(await request('/api/rollback', 'POST', { expectedRevision: state.config.revision, targetRevision }));
      saveMessage = `已恢复为 v${state.config.revision}`;
    } catch (caught) { fail(caught); }
    finally { busy = false; render(false); }
  }

  function activatePane(next, focus = false) {
    pane = next;
    ['profile', 'capabilities'].forEach(name => {
      const active = name === pane;
      $(`tab-${name}`).setAttribute('aria-selected', String(active));
      $(`tab-${name}`).tabIndex = active ? 0 : -1;
      $(`${name}-pane`).hidden = !active;
    });
    if (focus) $(`tab-${pane}`).focus();
    renderActions();
    scheduleReceipt();
  }

  function activateKind(next, focus = false) {
    kind = next;
    document.querySelectorAll('[data-kind]').forEach(button => {
      const active = button.dataset.kind === kind;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    });
    renderCapabilities();
    if (focus) $(`category-${kind}`).focus();
    scheduleReceipt();
  }

  function keyboardTabs(event, options, current, activate) {
    let index = options.indexOf(current);
    if (event.key === 'ArrowRight') index = (index + 1) % options.length;
    else if (event.key === 'ArrowLeft') index = (index + options.length - 1) % options.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = options.length - 1;
    else return;
    event.preventDefault(); activate(options[index], true);
  }

  async function reportVisible() {
    if (!state || receiptPending) return;
    const bounds = document.querySelector('.panel').getBoundingClientRect();
    const receipt = { width: Math.round(bounds.width), height: Math.round(bounds.height), visibility: document.visibilityState };
    const key = JSON.stringify(receipt);
    if (key === lastReceipt) return;
    receiptPending = true;
    try { await request('/api/visible', 'POST', receipt); lastReceipt = key; }
    catch { /* Visibility acknowledgement is independent from config delivery. */ }
    finally { receiptPending = false; }
  }

  function scheduleReceipt() { clearTimeout(renderTimer); renderTimer = setTimeout(reportVisible, 150); }

  $('expand').addEventListener('click', () => {
    const expanded = $('expand').getAttribute('aria-expanded') !== 'true';
    $('expand').setAttribute('aria-expanded', String(expanded));
    $('card-content').hidden = !expanded;
    scheduleReceipt();
  });
  ['profile', 'capabilities'].forEach(name => $('tab-' + name).addEventListener('click', () => activatePane(name)));
  document.querySelector('.tabs').addEventListener('keydown', event => keyboardTabs(event, ['profile', 'capabilities'], pane, activatePane));
  $('categories').addEventListener('keydown', event => keyboardTabs(event, ['skill', 'mcp', 'plugin', 'app'], kind, activateKind));
  document.querySelectorAll('[data-kind]').forEach(button => button.addEventListener('click', () => activateKind(button.dataset.kind)));
  ['persona', 'background'].forEach(name => $(name).addEventListener('input', () => {
    if (!draft) return;
    draft[name] = $(name).value; saveMessage = ''; renderActions(); renderHistory(); renderError();
  }));
  $('reset').addEventListener('click', () => { if (draft && !busy) { draft = profile(null); saveMessage = ''; render(true); } });
  $('cancel').addEventListener('click', () => { if (state && !busy) { draft = profile(state.config); saveMessage = ''; render(true); } });
  $('apply').addEventListener('click', apply);
  $('reconnect').addEventListener('click', () => refresh());
  $('reload').addEventListener('click', () => refresh({ discardDraft: true }));
  $('download-draft').addEventListener('click', () => {
    if (!state || !draft) return;
    const blob = new Blob([JSON.stringify({ threadId: state.thread.id, expectedRevision: state.config.revision, ...draft }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = 'threadbrief-draft.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.addEventListener('visibilitychange', scheduleReceipt);
  window.addEventListener('resize', scheduleReceipt);
  new ResizeObserver(scheduleReceipt).observe(document.querySelector('.panel'));
  window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  render(false);
  refresh();
  setInterval(() => { if (!dirty() && !busy && document.visibilityState === 'visible') refresh(); }, 5000);
})();
