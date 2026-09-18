import { createHash } from 'node:crypto';
import { stableSerialize } from '../lib/host-contract.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 8192
  && !/[\u0000-\u001f\u007f]/u.test(value) && !reserved.has(value);
const matcher = 'mcp__.*';

function parseKey(key) {
  const parts = [];
  for (let i = 0; i < key.length;) {
    if (key[i] === '"' || key[i] === "'") {
      const quote = key[i], start = i++;
      let escaped = false;
      for (; i < key.length; i += 1) {
        if (quote === '"' && !escaped && key[i] === '\\') { escaped = true; continue; }
        if (!escaped && key[i] === quote) break;
        escaped = false;
      }
      if (i === key.length) return null;
      const token = key.slice(start, ++i);
      try { parts.push(quote === '"' ? JSON.parse(token) : token.slice(1, -1)); } catch { return null; }
    } else {
      const start = i;
      while (i < key.length && key[i] !== '.') i += 1;
      const token = key.slice(start, i);
      if (!/^[A-Za-z0-9_-]+$/u.test(token)) return null;
      parts.push(token);
    }
    if (!text(parts.at(-1))) return null;
    if (i === key.length) break;
    if (key[i++] !== '.' || i === key.length) return null;
  }
  return parts.length ? parts : null;
}
function assignmentKey(value) {
  let quote, escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (quote === '"' && !escaped && ch === '\\') { escaped = true; continue; }
      if (!escaped && ch === quote) quote = undefined;
      escaped = false;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '=') return parseKey(value.slice(0, i).trim());
  }
  return null;
}
const windowsQuote = value => `'${value.replaceAll("'", "''")}'`;
const shellQuote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
function ownHook({ nodeExecutable, hookFile, runtimeConfigFile, configEvent, eventName, hashEvent, matcher: match = null, additionalContextLimit }) {
  const words = [nodeExecutable, hookFile, runtimeConfigFile];
  const commandWindows = `& ${words.map(windowsQuote).join(' ')}`;
  const command = process.platform === 'win32' ? commandWindows : words.map(shellQuote).join(' ');
  const limit = additionalContextLimit === undefined ? {} : { additionalContextLimit };
  const definition = `hooks.${configEvent}=[{${match === null ? '' : `matcher=${JSON.stringify(match)},`}hooks=[{type="command",command=${JSON.stringify(command)},commandWindows=${JSON.stringify(commandWindows)},timeout=5${additionalContextLimit === undefined ? '' : `,additionalContextLimit=${additionalContextLimit}`}}]}]`;
  const expectedHash = `sha256:${createHash('sha256').update(stableSerialize({ event_name: hashEvent,
    hooks: [{ ...limit, async: false, command, timeout: 5, type: 'command' }], ...(match === null ? {} : { matcher: match }) })).digest('hex')}`;
  return { definition, command, eventName, matcher: match, expectedHash, ...limit };
}

/** Adds own session-flags hooks, without installing or trusting files on disk. */
export function prepareToolPolicyHookArgs({ args, nodeExecutable, hookFile, runtimeConfigFile, promptHookFile } = {}) {
  const off = reason => ({ args, enabled: false, command: null, matcher, reason });
  if (!Array.isArray(args) || !args.every(value => typeof value === 'string' && !value.includes('\0'))
    || ![nodeExecutable, hookFile, runtimeConfigFile].every(text)) return off('REGISTRATION_ARGUMENTS_INVALID');
  let promptConflict = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') break;
    let value;
    if (arg === '-c' || arg === '--config') value = args[++i];
    else if (arg.startsWith('--config=')) value = arg.slice(9);
    else if (arg.startsWith('-c') && !arg.startsWith('--')) value = arg.slice(2).replace(/^=/u, '');
    else continue;
    if (typeof value !== 'string') return off('CLI_CONFIG_INVALID');
    const parts = assignmentKey(value);
    if (!parts) return off('CLI_CONFIG_KEY_UNSUPPORTED');
    if (parts[0] === 'hooks' && (parts.length === 1 || parts[1] === 'PreToolUse')) return off('CLI_HOOK_DEFINITION_CONFLICT');
    if (parts[0] === 'hooks' && parts[1] === 'UserPromptSubmit') promptConflict = true;
  }
  // Codex hashes the normalized event group, including the platform-resolved
  // command and async's default. This was matched against hooks/list on the CLI.
  const tool = ownHook({ nodeExecutable, hookFile, runtimeConfigFile, configEvent: 'PreToolUse', eventName: 'preToolUse', hashEvent: 'pre_tool_use', matcher });
  const flags = ['-c', tool.definition];
  const result = { args: undefined, enabled: true, command: tool.command, matcher, expectedHash: tool.expectedHash };
  if (promptHookFile !== undefined) {
    if (promptConflict || !text(promptHookFile)) {
      result.promptHook = { enabled: false, eventName: 'userPromptSubmit', matcher: null, command: null,
        reason: promptConflict ? 'CLI_PROMPT_HOOK_DEFINITION_CONFLICT' : 'PROMPT_HOOK_ARGUMENTS_INVALID' };
    } else {
      const { definition, ...prompt } = ownHook({ nodeExecutable, hookFile: promptHookFile, runtimeConfigFile,
        configEvent: 'UserPromptSubmit', eventName: 'userPromptSubmit', hashEvent: 'user_prompt_submit', additionalContextLimit: 0 });
      result.promptHook = { enabled: true, ...prompt };
      flags.push('-c', definition);
    }
  }
  result.args = [...flags, ...args];
  return result;
}

function replaceNested(value, parts, replacement) {
  if (!parts.length) {
    if (record(value) || Array.isArray(value)) return { error: 'HOOK_STATE_VALUE_CONFLICT' };
    return { value: replacement, changed: value !== replacement };
  }
  if (value !== undefined && !record(value)) return { error: 'HOOK_STATE_ANCESTOR_CONFLICT' };
  const [key, ...rest] = parts, current = value ?? {};
  const result = replaceNested(Object.hasOwn(current, key) ? current[key] : undefined, rest, replacement);
  if (result.error) return result;
  return result.changed ? { value: { ...current, [key]: result.value }, changed: true } : { value, changed: false };
}
function mergeState(left, right) {
  if (!record(left) || !record(right)) {
    return stableSerialize(left) === stableSerialize(right) ? { value: left } : { error: 'HOOK_STATE_ALIAS_CONFLICT' };
  }
  let value = left;
  for (const [key, child] of Object.entries(right)) {
    if (!text(key)) return { error: 'HOOK_STATE_KEY_INVALID' };
    const result = Object.hasOwn(left, key) ? mergeState(left[key], child) : { value: child };
    if (result.error) return result;
    value = { ...value, [key]: result.value };
  }
  return { value };
}
function extractState(config) {
  const rest = { ...config };
  let state = {};
  for (const [name, value] of Object.entries(config)) {
    const parts = parseKey(name);
    if (!parts) {
      if (/^["']?hooks/u.test(name)) return { error: 'HOOK_CONFIG_KEY_UNSUPPORTED' };
      continue;
    }
    if (parts[0] !== 'hooks') continue;
    let fragment;
    if (parts.length === 1) {
      if (!record(value) || Object.keys(value).some(child => child !== 'state')) return { error: 'HOST_HOOK_DEFINITION_CONFLICT' };
      fragment = Object.hasOwn(value, 'state') ? value.state : {};
    } else {
      if (parts[1] !== 'state') return { error: 'HOST_HOOK_DEFINITION_CONFLICT' };
      fragment = parts.slice(2).reduceRight((child, key) => ({ [key]: child }), value);
    }
    if (!record(fragment)) return { error: 'HOOK_STATE_ANCESTOR_CONFLICT' };
    const result = mergeState(state, fragment);
    if (result.error) return result;
    state = result.value;
    delete rest[name];
  }
  return { config: rest, state };
}

/** Trusts all configured own hooks atomically in the natural task request. */
export function prepareToolPolicyTrust({ message, inventory, registration } = {}) {
  const no = reason => ({ message, changed: false, ready: false, reason });
  if (!record(message) || !['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) return no('NOT_A_NATURAL_LIFECYCLE');
  if (!registration?.enabled || !text(registration.command) || registration.matcher !== matcher
    || !/^sha256:[a-f0-9]{64}$/u.test(registration.expectedHash ?? '')) return no('HOOK_NOT_REGISTERED');
  if (!record(message.params) || (message.params.config != null && !record(message.params.config))) return no('HOST_CONFIG_INVALID');
  if (!Array.isArray(inventory?.data)) return no('HOOK_INVENTORY_INVALID');
  const desired = [{ ...registration, eventName: 'preToolUse' }];
  if (registration.promptHook?.enabled) {
    const prompt = registration.promptHook;
    if (prompt.eventName !== 'userPromptSubmit' || prompt.matcher !== null || !text(prompt.command) || prompt.additionalContextLimit !== 0
      || !/^sha256:[a-f0-9]{64}$/u.test(prompt.expectedHash ?? '')) return no('PROMPT_HOOK_REGISTRATION_INVALID');
    desired.push(prompt);
  }
  const ownHooks = [];
  for (const expected of desired) {
    const found = new Map();
    for (const entry of inventory.data) {
      if (!Array.isArray(entry?.hooks)) return no('HOOK_INVENTORY_INVALID');
      for (const hook of entry.hooks) {
        if (hook?.eventName !== expected.eventName || hook.handlerType !== 'command' || hook.source !== 'sessionFlags'
          || hook.command !== expected.command || (hook.matcher ?? null) !== expected.matcher) continue;
        if (!text(hook.key) || hook.currentHash !== expected.expectedHash
          || (hook.async !== undefined && hook.async !== false)
          || (hook.timeoutSec !== undefined && hook.timeoutSec !== 5)
          || (expected.eventName === 'userPromptSubmit' && hook.additionalContextLimit !== 0)) return no('HOOK_IDENTITY_MISMATCH');
        found.set(hook.key, hook);
      }
    }
    if (found.size !== 1) return no(found.size ? 'HOOK_IDENTITY_AMBIGUOUS' : 'OWN_HOOK_NOT_OBSERVED');
    const hook = found.values().next().value;
    ownHooks.push({ key: hook.key, eventName: expected.eventName, command: hook.command,
      matcher: expected.matcher, currentHash: hook.currentHash, source: 'sessionFlags',
      ...(expected.eventName === 'userPromptSubmit' ? { additionalContextLimit: 0 } : {}),
      ...(text(hook.sourcePath) ? { sourcePath: hook.sourcePath } : {}) });
  }
  if (new Set(ownHooks.map(hook => hook.key)).size !== ownHooks.length) return no('HOOK_IDENTITY_AMBIGUOUS');
  const key = ownHooks[0].key;
  const originalConfig = message.params.config ?? {};
  const extracted = extractState(originalConfig);
  if (extracted.error) return no(extracted.error);
  let state = extracted.state;
  for (const hook of ownHooks) {
    for (const [field, value] of [['enabled', true], ['trusted_hash', hook.currentHash]]) {
      const result = replaceNested(state, [hook.key, field], value);
      if (result.error) return no(result.error);
      state = result.value;
    }
  }
  // The backend consumes this complete override table. A hooks parent object
  // or individual hooks.state.<key> leaves can silently leave the hook untrusted.
  // Lower config-layer states are still merged by Codex (real CLI verified).
  const config = { ...extracted.config, 'hooks.state': state };
  const changed = stableSerialize(config) !== stableSerialize(originalConfig);
  return { message: changed ? { ...message, params: { ...message.params, config } } : message, changed, ready: true,
    key, ownHookKeys: ownHooks.map(hook => hook.key), ownHooks };
}
