// src/panel/html.ts — 面板占位页模板（纯函数、无逻辑、不依赖 vscode）
// 注：运行时 import i18n 的 t（getLang 由扩展激活时 initI18n 设置，模块本身不依赖 vscode），
// 供工具条文案翻译使用；其余页面函数仍沿用调用方注入 T 的方式。
import { t } from '../i18n';
import type { MsgKey } from '../i18n';

/** 翻译函数签名（把 i18n.t 传入模板） */
export type T = (key: MsgKey, vars?: Record<string, string | number>) => string;

/** 面板内按钮发回扩展的消息类型（含桥接跳转与握手回执三类） */
export type PanelMessage =
  | { type: 'retry' }
  | { type: 'reconnect' }
  | { type: 'openExternal' }
  | { type: 'restart' }
  | { type: 'stop' }
  | { type: 'copyUrl' }
  | { type: 'showLogs' }
  | { type: 'bridgeOpenExternal'; url: string }
  | { type: 'bridgeOpenFile'; path: string; cwd?: string }
  | { type: 'bridgeAck'; ok: boolean }
  | { type: 'addFileContext' }
  | { type: 'toggleAutoFollow' };

/** 渲染上下文 */
export interface PageCtx {
  /** 内联脚本的 CSP nonce */
  nonce: string;
  /** webview.cspSource（本地资源来源） */
  cspSource: string;
  /** 允许加载 iframe 的目标地址（DSH 服务地址） */
  frameHosts: string[];
}

/** CSP：最小权限——只放行目标 iframe 与带 nonce 的内联脚本 */
function csp(ctx: PageCtx): string {
  return [
    "default-src 'none'",
    `frame-src ${ctx.frameHosts.join(' ')}`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${ctx.nonce}'`,
    `img-src ${ctx.cspSource} data:`,
  ].join('; ');
}

/** 通用样式（使用 VS Code 主题变量，自动适配浅色/深色主题） */
const STYLE = `
body { margin: 0; padding: 0; height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
body.frame-body { display: block; }
.center { text-align: center; max-width: 90%; }
p { margin: 8px 0 16px; opacity: 0.9; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; margin: 4px; cursor: pointer; border-radius: 2px; }
button:hover { background: var(--vscode-button-hoverBackground); }
.spinner { width: 28px; height: 28px; border: 3px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; margin: 0 auto 12px; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
iframe.frame { position: fixed; inset: 0; width: 100%; height: 100%; border: none; }
.ctx-bar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-sideBar-border); font-size: 12px; flex-shrink: 0; }
.ctx-bar .ctx-file { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.9; }
.ctx-bar button { padding: 2px 8px; margin: 0; font-size: 12px; }
.ctx-bar label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
body.frame-body.has-bar { display: flex; flex-direction: column; }
.has-bar iframe.frame { position: static; flex: 1; }
`;

/** 按钮点击 → postMessage 的内联脚本（nonce 放行） */
const BUTTON_SCRIPT = `
const vscode = acquireVsCodeApi();
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  vscode.postMessage({ type: btn.dataset.action });
});
document.addEventListener('change', (e) => {
  const box = e.target.closest('input[type="checkbox"][data-action="toggleAutoFollow"]');
  if (!box) return;
  vscode.postMessage({ type: 'toggleAutoFollow' });
});
`;

/**
 * 桥接握手脚本（内联，nonce 放行，紧随 BUTTON_SCRIPT 之后、共用其声明的 vscode）。
 * 职责：
 *  - 上行：向 iframe 下发 { kind:'bridgeHello', token } 握手消息，接收其 bridgeAck 回执，
 *    并把 iframe 上行消息（openExternal / openFile）转发给扩展侧处理。
 * 安全约束：上行仅接收「目标 origin」且「source 为 iframe 内容窗口」的消息，防止其它站点伪造。
 * @param token 握手防伪凭据（与桥接侧 isBridgeMessage 校验的一致）
 * @param allowedOrigin 允许的消息来源 origin（由 DSH 页面地址推导，如 http://127.0.0.1:3080）
 */
function bridgeHandshakeScript(token: string, allowedOrigin: string): string {
  return `
// dsh-bridge-handshake：DSH 页面桥接握手与消息路由（上行转发）
const iframeEl = document.getElementById('dsh-frame');
if (iframeEl) {
  const iframeSrc = iframeEl.src;
  // 握手 token 与允许的 DSH 页面 origin
  const TOKEN = ${JSON.stringify(token)};
  const ALLOWED_ORIGIN = ${JSON.stringify(allowedOrigin)};
  window.addEventListener('message', (e) => {
    const d = e.data;
    // —— 上行：iframe 发来的消息，origin + source 双重校验 ——
    if (e.origin !== ALLOWED_ORIGIN || e.source !== iframeEl.contentWindow) return;
    // 握手回执：统一形状 { kind:'bridgeAck', ok }（不带 token 字段），只读 ok
    if (d && d.kind === 'bridgeAck') { vscode.postMessage({ type: 'bridgeAck', ok: d.ok === true }); return; }
    // 打开外链：转发给扩展 → vscode.env.openExternal
    if (d && d.kind === 'openExternal' && typeof d.url === 'string') { vscode.postMessage({ type: 'bridgeOpenExternal', url: d.url }); return; }
    // 打开文件：转发给扩展 → showTextDocument（携带可选 cwd）
    if (d && d.kind === 'openFile' && typeof d.path === 'string') {
      vscode.postMessage({ type: 'bridgeOpenFile', path: d.path, cwd: typeof d.cwd === 'string' ? d.cwd : undefined });
    }
  });
  // iframe 加载完成后下发握手消息（携带 token）
  iframeEl.addEventListener('load', () => {
    iframeEl.contentWindow.postMessage({ kind: 'bridgeHello', token: TOKEN }, iframeSrc);
  });
}`;
}

/** 工具条下行监听:扩展推送 {kind:'updateContextBar'} 时更新标签与开关 */
const CONTEXT_BAR_SCRIPT = `
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.kind !== 'updateContextBar') return;
  const label = document.getElementById('dsh-ctx-label');
  if (label) label.textContent = d.fileLabel ?? '';
  const box = document.getElementById('dsh-ctx-autofollow');
  if (box) box.checked = d.autoFollow === true;
});
`;

/** 工具条状态(由 provider 传入,不传则不渲染) */
export interface ContextBarState {
  fileLabel: string | null;
  autoFollow: boolean;
}

/** 工具条 HTML:当前文件标签 + 加入按钮 + 自动跟随开关 */
function contextBarHtml(t: T, state: ContextBarState): string {
  return `<div id="dsh-ctx-bar" class="ctx-bar">
<span class="ctx-file">${t('ctx.currentFile')}: <span id="dsh-ctx-label">${escapeHtml(state.fileLabel ?? '')}</span></span>
<button data-action="addFileContext">${t('ctx.add')}</button>
<label><input type="checkbox" id="dsh-ctx-autofollow" data-action="toggleAutoFollow"${state.autoFollow ? ' checked' : ''}> ${t('ctx.autoFollow')}</label>
</div>`;
}

/** HTML 转义（防御性，消息来自 i18n 但转义不费事） */
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * 页面外壳：公共骨架 + BUTTON_SCRIPT，可选追加额外内联脚本（如桥接握手脚本）。
 * @param extraScripts 追加在 BUTTON_SCRIPT 之后、</body> 之前的内联脚本（含 <script> 标签）
 */
function shell(ctx: PageCtx, title: string, bodyClass: string, body: string, extraScripts = ''): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp(ctx)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body class="${bodyClass}">${body}
<script nonce="${ctx.nonce}">${BUTTON_SCRIPT}</script>${extraScripts}
</body>
</html>`;
}

/** 加载中占位页 */
export function loadingPage(t: T, ctx: PageCtx): string {
  return shell(ctx, t('panel.loading'), '', `<div class="center"><div class="spinner"></div><p>${t('panel.loading')}</p></div>`);
}

/** 启动失败占位页：原因 + 重试 + 查看日志 */
export function errorPage(t: T, ctx: PageCtx, message: string): string {
  return shell(
    ctx,
    t('panel.errorTitle'),
    '',
    `<div class="center"><p>${t('panel.errorTitle')}</p><p>${escapeHtml(message)}</p>
<button data-action="retry">${t('panel.retry')}</button>
<button data-action="showLogs">${t('panel.showLogs')}</button></div>`,
  );
}

/** 服务断开占位页：重连 + 查看日志 */
export function disconnectedPage(t: T, ctx: PageCtx): string {
  return shell(
    ctx,
    t('panel.disconnectedTitle'),
    '',
    `<div class="center"><p>${t('panel.disconnectedTitle')}</p>
<button data-action="reconnect">${t('panel.reconnect')}</button>
<button data-action="showLogs">${t('panel.showLogs')}</button></div>`,
  );
}

/** 手动停止后的占位页 */
export function stoppedPage(t: T, ctx: PageCtx): string {
  return shell(
    ctx,
    t('status.stopped'),
    '',
    `<div class="center"><p>${t('status.stopped')}</p>
<button data-action="reconnect">${t('panel.reconnect')}</button></div>`,
  );
}

/**
 * 就绪页：全屏 iframe 加载真实 DSH 网页（无 sandbox，避免破坏页面自身功能）。
 * 桥接启用时注入握手脚本，让顶层 webview 与 DSH 页面 iframe 建立握手并转发跳转消息。
 * @param bridge 桥接配置（可选，向后兼容既有调用）：token 为握手凭据，enabled 为是否注入握手脚本
 * @param contextBar 上下文工具条状态（可选，不传则不渲染工具条，向后兼容）
 */
export function readyPage(
  url: string,
  ctx: PageCtx,
  bridge?: { token: string; enabled: boolean },
  contextBar?: ContextBarState,
): string {
  // 桥接启用时注入握手脚本；未传入或 enabled=false 时保持向后兼容，不注入
  const extraScripts = bridge?.enabled
    ? `<script nonce="${ctx.nonce}">${bridgeHandshakeScript(bridge.token, new URL(url).origin)}</script>`
    : '';
  // 传入 contextBar 时渲染工具条（下行监听脚本 + DOM）；不传则保持向后兼容
  const bar = contextBar
    ? `<script nonce="${ctx.nonce}">${CONTEXT_BAR_SCRIPT}</script>${contextBarHtml(t, contextBar)}`
    : '';
  const bodyClass = contextBar ? 'frame-body has-bar' : 'frame-body';
  return shell(ctx, 'DSH', bodyClass, `${bar}<iframe id="dsh-frame" class="frame" src="${url}"></iframe>`, extraScripts);
}
