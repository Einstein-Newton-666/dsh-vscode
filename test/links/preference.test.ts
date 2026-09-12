// test/links/preference.test.ts — 外链打开偏好：归一化 / 决策 / 存储（纯逻辑）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOpenLinksIn,
  resolveLinkTarget,
  createMemoryPreferenceStore,
  DEFAULT_OPEN_LINKS_IN,
} from '../../src/links/preference';

test('normalizeOpenLinksIn 只接受三个合法值，其余回退 ask', () => {
  assert.equal(normalizeOpenLinksIn('ask'), 'ask');
  assert.equal(normalizeOpenLinksIn('simpleBrowser'), 'simpleBrowser');
  assert.equal(normalizeOpenLinksIn('external'), 'external');
  // 非法/缺失一律回退默认（与 config.ts 的缺省处理一致）
  assert.equal(normalizeOpenLinksIn(undefined), DEFAULT_OPEN_LINKS_IN);
  assert.equal(normalizeOpenLinksIn(''), 'ask');
  assert.equal(normalizeOpenLinksIn('SimpleBrowser'), 'ask'); // 大小写敏感，不猜测
  assert.equal(normalizeOpenLinksIn(123), 'ask');
  assert.equal(normalizeOpenLinksIn(null), 'ask');
});

test('resolveLinkTarget：记住的值优先于配置项', () => {
  // 配置为 external，但用户记住 simpleBrowser → 以记住的为准
  assert.equal(resolveLinkTarget({ configured: 'external', remembered: 'simpleBrowser' }), 'simpleBrowser');
  assert.equal(resolveLinkTarget({ configured: 'simpleBrowser', remembered: 'external' }), 'external');
});

test('resolveLinkTarget：未记住时按配置项；ask 返回 null 表示需要询问', () => {
  assert.equal(resolveLinkTarget({ configured: 'simpleBrowser' }), 'simpleBrowser');
  assert.equal(resolveLinkTarget({ configured: 'external' }), 'external');
  assert.equal(resolveLinkTarget({ configured: 'ask' }), null);
});

test('内存偏好存储可读可写', () => {
  const store = createMemoryPreferenceStore();
  assert.equal(store.get(), undefined);
  store.set('simpleBrowser');
  assert.equal(store.get(), 'simpleBrowser');
  store.set('external');
  assert.equal(store.get(), 'external');
});
