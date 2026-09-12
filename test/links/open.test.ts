// test/links/open.test.ts — 外链打开流程：选项构造 / 询问 / 决策执行 / 降级（全程注入假实现）
// 注意：open.ts 顶层 `import * as vscode`，测试环境由 vscode-stub 提供最小对象；
// 被测函数均通过依赖注入取用外部能力，不触碰真实 vscode API。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLinkByPreference, buildLinkPickItems, askLinkTarget, type LinkTargetPickItem } from '../../src/links/open';
import { createMemoryPreferenceStore, type LinkTarget } from '../../src/links/preference';

/** 测试用文案函数：直接回显键，便于断言"选项来自哪个键" */
const tr = (key: string): string => key;

/** 构造一个记录调用的依赖包，按需覆盖 */
function makeDeps(overrides: {
  configured?: 'ask' | LinkTarget;
  remembered?: LinkTarget;
  hasSimpleBrowser?: boolean;
  pick?: LinkTargetPickItem | null;
} = {}) {
  const calls: string[] = [];
  const warnings: string[] = [];
  const store = createMemoryPreferenceStore();
  if (overrides.remembered !== undefined) store.set(overrides.remembered);
  return {
    calls,
    warnings,
    store,
    deps: {
      store,
      configured: () => overrides.configured ?? ('ask' as const),
      openSimpleBrowser: async (u: string) => {
        calls.push(`simpleBrowser:${u}`);
      },
      openExternal: async (u: string) => {
        calls.push(`external:${u}`);
      },
      hasSimpleBrowser: async () => overrides.hasSimpleBrowser ?? true,
      prompt: async () =>
        overrides.pick === undefined
          ? null
          : overrides.pick === null
            ? null
            : { target: overrides.pick.target, remember: overrides.pick.remember },
      warn: (m: string) => {
        warnings.push(m);
      },
      tr,
    },
  };
}

test('buildLinkPickItems 产出四条选项，两条为「记住」型', () => {
  const items = buildLinkPickItems(tr);
  assert.equal(items.length, 4);
  assert.deepEqual(
    items.map((i) => i.target),
    ['simpleBrowser', 'external', 'simpleBrowser', 'external'],
  );
  assert.deepEqual(
    items.map((i) => i.remember),
    [false, false, true, true],
  );
  // 文案来自 i18n 键（注入的 tr 回显键名）
  assert.equal(items[0].label, 'link.openInVscode');
  assert.equal(items[2].label, 'link.alwaysVscode');
});

test('askLinkTarget：用户取消返回 null', async () => {
  const picked = await askLinkTarget(tr, async () => undefined);
  assert.equal(picked, null);
});

test('askLinkTarget：透传选中条目与占位文案', async () => {
  let seenPlaceholder = '';
  const picked = await askLinkTarget(tr, async (items, options) => {
    seenPlaceholder = options.placeHolder;
    return items[1];
  });
  assert.equal(picked?.target, 'external');
  assert.equal(seenPlaceholder, 'link.pickPlaceholder');
});

test('配置为 simpleBrowser：不询问，直接开内置浏览器', async () => {
  const { deps, calls } = makeDeps({ configured: 'simpleBrowser' });
  const used = await openLinkByPreference('https://a.b', deps);
  assert.equal(used, 'simpleBrowser');
  assert.deepEqual(calls, ['simpleBrowser:https://a.b']);
});

test('配置为 external：不询问，直接开系统浏览器', async () => {
  const { deps, calls } = makeDeps({ configured: 'external' });
  const used = await openLinkByPreference('https://a.b', deps);
  assert.equal(used, 'external');
  assert.deepEqual(calls, ['external:https://a.b']);
});

test('ask + 用户取消：不打开任何东西，也不提示', async () => {
  const { deps, calls, warnings } = makeDeps({ configured: 'ask', pick: null });
  const used = await openLinkByPreference('https://a.b', deps);
  assert.equal(used, null);
  assert.deepEqual(calls, []);
  assert.deepEqual(warnings, []);
});

test('ask + 选择「本次在 VS Code 内」：打开且不写入记忆', async () => {
  const { deps, calls, store } = makeDeps({
    configured: 'ask',
    pick: { label: 'x', target: 'simpleBrowser', remember: false },
  });
  const used = await openLinkByPreference('https://a.b', deps);
  assert.equal(used, 'simpleBrowser');
  assert.deepEqual(calls, ['simpleBrowser:https://a.b']);
  assert.equal(store.get(), undefined, '非「记住」型选项不应写入偏好');
});

test('ask + 选择「始终用系统浏览器」：写入记忆，下次不再询问', async () => {
  const { deps, store } = makeDeps({
    configured: 'ask',
    pick: { label: 'x', target: 'external', remember: true },
  });
  await openLinkByPreference('https://a.b', deps);
  assert.equal(store.get(), 'external');

  // 第二次：即使配置仍是 ask，也应命中记忆而跳过询问
  const second = makeDeps({ configured: 'ask' });
  second.store.set('external');
  const used = await openLinkByPreference('https://a.c', second.deps);
  assert.equal(used, 'external');
  assert.deepEqual(second.calls, ['external:https://a.c']);
});

test('记住的值优先于配置项', async () => {
  const { deps, calls } = makeDeps({ configured: 'external', remembered: 'simpleBrowser' });
  const used = await openLinkByPreference('https://a.b', deps);
  assert.equal(used, 'simpleBrowser');
  assert.deepEqual(calls, ['simpleBrowser:https://a.b']);
});

test('内置浏览器不可用：提示用户并降级到系统浏览器', async () => {
  const { deps, calls, warnings } = makeDeps({ configured: 'simpleBrowser', hasSimpleBrowser: false });
  const used = await openLinkByPreference('https://a.b', deps);
  assert.equal(used, 'external');
  assert.deepEqual(calls, ['external:https://a.b']);
  assert.deepEqual(warnings, ['link.simpleBrowserUnavailable']);
});

test('内置浏览器探测抛错：同样降级而不是让链接静默失败', async () => {
  const { deps, calls, warnings } = makeDeps({ configured: 'simpleBrowser' });
  deps.hasSimpleBrowser = async () => {
    throw new Error('commands unavailable');
  };
  const used = await openLinkByPreference('https://a.b', deps);
  assert.equal(used, 'external');
  assert.deepEqual(calls, ['external:https://a.b']);
  assert.equal(warnings.length, 1);
});
