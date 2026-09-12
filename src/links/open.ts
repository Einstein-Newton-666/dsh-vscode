// src/links/open.ts — 按用户偏好打开面板内点击的外链（VS Code 薄封装）
//
// 与 bridge/host.ts 的分工：
// - host.ts 只做协议白名单与路径安全，并通过注入的 openExternal 回调打开链接；
// - 本模块就是注入进去的那个实现：按 dsh.openLinksIn + 用户「记住的选择」决定
//   在 VS Code 内置浏览器（simpleBrowser.show）还是系统浏览器（env.openExternal）打开。
//
// 重要限制（本机实测 VS Code 1.137，实现前请勿假设可以绕过）：
// Simple Browser 内部是 <iframe sandbox="allow-scripts allow-forms allow-same-origin allow-downloads">。
// 目标站点若发送 X-Frame-Options: DENY / frame-ancestors，页面会是空白——这是 iframe 的固有约束，
// 不是本模块的缺陷。因此「询问」是默认策略：让用户在有选择权的前提下自行判断。
import * as vscode from 'vscode';
import { t, type MsgKey } from '../i18n';
import {
  resolveLinkTarget,
  type LinkPreferenceStore,
  type LinkTarget,
  type OpenLinksIn,
} from './preference';

/** VS Code 内置浏览器（simple-browser 扩展）注册的命令；存在性在运行时探测 */
export const SIMPLE_BROWSER_COMMAND = 'simpleBrowser.show';

/** QuickPick 条目：标准条目 + 去向 + 是否「记住我的选择」 */
export interface LinkTargetPickItem extends vscode.QuickPickItem {
  target: LinkTarget;
  remember: boolean;
}

/** 文案键 → 文案函数（注入以便单测断言，且不依赖 i18n 初始化时机） */
export type Translate = (key: MsgKey) => string;

/**
 * 构造 QuickPick 选项（纯函数，可单测）。
 * 四条：本次在 VS Code 内 / 本次用系统浏览器 / 始终在 VS Code 内 / 始终用系统浏览器。
 */
export function buildLinkPickItems(tr: Translate): LinkTargetPickItem[] {
  return [
    {
      label: tr('link.openInVscode'),
      description: tr('link.openInVscodeDesc'),
      target: 'simpleBrowser',
      remember: false,
    },
    {
      label: tr('link.openInSystem'),
      description: tr('link.openInSystemDesc'),
      target: 'external',
      remember: false,
    },
    {
      label: tr('link.alwaysVscode'),
      description: tr('link.alwaysVscodeDesc'),
      target: 'simpleBrowser',
      remember: true,
    },
    {
      label: tr('link.alwaysSystem'),
      description: tr('link.alwaysSystemDesc'),
      target: 'external',
      remember: true,
    },
  ];
}

/**
 * 询问用户这次在哪里打开（纯函数，注入 showQuickPick）。
 * @returns 选中的条目；用户取消（Esc/关闭）返回 null
 */
export function askLinkTarget(
  tr: Translate,
  showQuickPick: (
    items: LinkTargetPickItem[],
    options: { placeHolder: string },
  ) => Promise<LinkTargetPickItem | undefined>,
): Promise<LinkTargetPickItem | null> {
  return showQuickPick(buildLinkPickItems(tr), { placeHolder: tr('link.pickPlaceholder') }).then(
    (picked) => picked ?? null,
  );
}

/** 打开器依赖（全部可注入，便于单测） */
export interface LinkOpenerDeps {
  /** 偏好存储（生产接 VS Code globalState） */
  store: LinkPreferenceStore;
  /** dsh.openLinksIn 的当前值 */
  configured: () => OpenLinksIn;
  /** 在 VS Code 内置浏览器打开 */
  openSimpleBrowser: (url: string) => Promise<void>;
  /** 在系统浏览器打开 */
  openExternal: (url: string) => Promise<void>;
  /** 内置浏览器命令可用性探测（simple-browser 可能被策略/设置禁用） */
  hasSimpleBrowser: () => Promise<boolean>;
  /** 询问去向；返回 null = 用户取消 */
  prompt: () => Promise<{ target: LinkTarget; remember: boolean } | null>;
  /** 提示（降级时告知用户） */
  warn: (message: string) => void;
  /** 文案函数（默认取运行时字典） */
  tr?: Translate;
}

/**
 * 按偏好打开一个 http(s) 外链。
 * 流程：记住的选择 → 配置项 → （ask 时）询问 → 执行 → 内置浏览器不可用时降级系统浏览器。
 * @returns 实际使用的去向；用户取消返回 null
 */
export async function openLinkByPreference(
  url: string,
  deps: LinkOpenerDeps,
): Promise<LinkTarget | null> {
  const tr = deps.tr ?? t;
  const decided = resolveLinkTarget({ configured: deps.configured(), remembered: deps.store.get() });

  let target: LinkTarget;
  if (decided !== null) {
    target = decided;
  } else {
    const picked = await deps.prompt();
    if (picked === null) return null; // 用户取消：静默返回，不打扰
    target = picked.target;
    if (picked.remember) deps.store.set(target);
  }

  if (target === 'simpleBrowser') {
    // 探测而非假设：禁用 simple-browser 的组织策略下该命令不存在
    const available = await deps.hasSimpleBrowser().catch(() => false);
    if (!available) {
      deps.warn(tr('link.simpleBrowserUnavailable'));
      await deps.openExternal(url);
      return 'external';
    }
    await deps.openSimpleBrowser(url);
    return 'simpleBrowser';
  }

  await deps.openExternal(url);
  return 'external';
}

/**
 * 生产装配：把 vscode API 接到上面的决策逻辑上。
 * 返回的函数签名与 bridge/host.ts 的 BridgeMessageDeps.openExternal 一致，可直接注入。
 */
export function createLinkOpener(deps: {
  store: LinkPreferenceStore;
  configured: () => OpenLinksIn;
  log?: (line: string) => void;
}): (url: string) => Promise<void> {
  return async (url: string) => {
    const target = await openLinkByPreference(url, {
      store: deps.store,
      configured: deps.configured,
      openSimpleBrowser: async (u) => {
        await vscode.commands.executeCommand(SIMPLE_BROWSER_COMMAND, u);
      },
      openExternal: async (u) => {
        await vscode.env.openExternal(vscode.Uri.parse(u));
      },
      hasSimpleBrowser: async () =>
        (await vscode.commands.getCommands(true)).includes(SIMPLE_BROWSER_COMMAND),
      prompt: () =>
        askLinkTarget(t, (items, options) =>
          Promise.resolve(vscode.window.showQuickPick<LinkTargetPickItem>(items, options)),
        ),
      warn: (m) => void vscode.window.showWarningMessage(m),
    });
    if (target !== null) deps.log?.(`[links] 打开外链(${target}): ${url}`);
  };
}
