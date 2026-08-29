// test/html.test.ts — 面板占位页模板的单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initI18n, t } from '../src/i18n';
import { loadingPage, errorPage, disconnectedPage, stoppedPage, readyPage, type PageCtx } from '../src/panel/html';

function ctx(): PageCtx {
  return { nonce: 'abc123', cspSource: 'vscode-webview:', frameHosts: ['http://127.0.0.1:3080'] };
}

test('loadingPage 包含加载动画与本地化文案', () => {
  initI18n('zh-cn');
  const html = loadingPage(t, ctx());
  assert.ok(html.includes('spinner'));
  assert.ok(html.includes(t('panel.loading')));
});

test('errorPage 包含重试按钮并转义消息中的 HTML', () => {
  initI18n('en');
  const html = errorPage(t, ctx(), '<script>alert(1)</script>');
  assert.ok(html.includes('data-action="retry"'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('disconnectedPage 与 stoppedPage 都包含重连按钮', () => {
  const d = disconnectedPage(t, ctx());
  const s = stoppedPage(t, ctx());
  assert.ok(d.includes('data-action="reconnect"'));
  assert.ok(s.includes('data-action="reconnect"'));
});

test('readyPage 包含目标地址 iframe 且无 sandbox 属性', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  assert.ok(html.includes('<iframe id="dsh-frame" class="frame" src="http://127.0.0.1:3080/"></iframe>'));
  assert.ok(!html.includes('sandbox'));
});

test('readyPage 启用桥接时注入握手脚本', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // 握手脚本标记与 token 均需出现在产物中（脚本会向 iframe 下发 bridgeHello）
  assert.ok(html.includes('dsh-bridge-handshake'));
  assert.ok(html.includes('tok123'));
});

test('readyPage 握手脚本包含上行 bridgeHello 发送', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // iframe load 后向 iframe 发送 bridgeHello 握手消息（携带 token）
  assert.ok(html.includes("kind: 'bridgeHello'"), 'load 后应发送 bridgeHello');
  assert.ok(html.includes('token: TOKEN'), '握手消息应携带 token');
  // 不应再包含下行 syncWorkspace 转发逻辑（工作区同步已移除）
  assert.ok(!html.includes('syncWorkspace'), '脚本不应包含 syncWorkspace 下行转发');
});

test('readyPage 未启用桥接时不注入握手脚本', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  // 未传第三参（或 enabled=false）时保持向后兼容，不注入握手脚本
  assert.ok(!html.includes('dsh-bridge-handshake'));
});

test('CSP 声明 frame-src 与 script-src nonce', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  assert.ok(html.includes('frame-src http://127.0.0.1:3080'));
  assert.ok(html.includes("script-src 'nonce-abc123'"));
});

test('readyPage 传入 contextBar 时渲染工具条(标签/加入按钮/自动跟随开关)', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), undefined, { fileLabel: 'src/extension.ts', autoFollow: true });
  assert.ok(html.includes('id="dsh-ctx-bar"'), '应渲染工具条容器');
  assert.ok(html.includes('id="dsh-ctx-label"'), '应渲染文件标签');
  assert.ok(html.includes('src/extension.ts'), '应显示文件引用');
  assert.ok(html.includes('data-action="addFileContext"'), '应渲染加入按钮');
  assert.ok(html.includes('id="dsh-ctx-autofollow"'), '应渲染自动跟随开关');
  assert.ok(html.includes('checked'), 'autoFollow=true 时开关应为选中态');
});

test('readyPage 未传 contextBar 时不渲染工具条(向后兼容)', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  assert.ok(!html.includes('dsh-ctx-bar'));
});

test('工具条下行脚本:监听 updateContextBar 更新标签与开关', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), undefined, { fileLabel: null, autoFollow: false });
  assert.ok(html.includes("'updateContextBar'"), '应包含下行消息监听');
  assert.ok(html.includes('dsh-ctx-label'), '监听脚本应引用标签元素');
  assert.ok(html.includes('dsh-ctx-autofollow'), '监听脚本应引用开关元素');
});

test('工具条 fileLabel 为空时显示空标签', () => {
  initI18n('en');
  const html = readyPage('http://127.0.0.1:3080/', ctx(), undefined, { fileLabel: null, autoFollow: false });
  assert.ok(html.includes('Current file'), '无文件时仍显示「当前文件」前缀文案');
  assert.ok(html.includes('id="dsh-ctx-label"></span>'), '标签内容为空(不渲染 null 字样)');
});
