// src/links/preference.ts — 「外链在哪里打开」的偏好存储与决策（纯逻辑，不依赖 vscode）
//
// 背景（本机实测，VS Code 1.137）：
// - 内置 simple-browser 扩展用 proposed 的 externalUriOpener 注册了 simpleBrowser.open，
//   但其 canOpenExternalUri 只对 localhost/127.0.0.1/::1 等回环主机名返回 Default，
//   对其它域名一律返回 None——所以普通 http(s) 外链不会进 VS Code 内置浏览器。
// - 第三方扩展不能用该 proposed API，只能在扩展侧拦截并用
//   `vscode.commands.executeCommand('simpleBrowser.show', url)` 打开。
// - 因此「在哪里打开」由本模块决策，宿主只负责执行。
//
// 设计：配置项 dsh.openLinksIn（ask/simpleBrowser/external）+ 可选的"记住我的选择"。
// 记住的值优先生效；配置项是未记住时的默认值。

/** 打开外链的去向 */
export type LinkTarget = 'simpleBrowser' | 'external';

/** dsh.openLinksIn 的允许取值（ask = 每次询问） */
export type OpenLinksIn = 'ask' | LinkTarget;

/** 默认值：询问。不预设用户偏好，且在目标站点禁止被 iframe 嵌入时用户能立刻明白原因。 */
export const DEFAULT_OPEN_LINKS_IN: OpenLinksIn = 'ask';

/** 决策输入：配置项当前值 + 用户已记住的选择 */
export interface OpenLinksPolicy {
  /** 归一化后的 dsh.openLinksIn 值 */
  configured: OpenLinksIn;
  /** 用户此前"记住"的选择；未记住为 undefined */
  remembered?: LinkTarget;
}

/**
 * 把 dsh.openLinksIn 的原始值归一化为合法取值（非法/缺失一律回退询问）。
 * 与 config.ts 的布尔缺省处理保持一致：只有明确提供了合法值才采用。
 */
export function normalizeOpenLinksIn(raw: unknown): OpenLinksIn {
  return raw === 'simpleBrowser' || raw === 'external' || raw === 'ask' ? raw : DEFAULT_OPEN_LINKS_IN;
}

/**
 * 决策"这次要不要询问用户"。
 * @returns 需要询问返回 null；否则返回已确定的去向（记住的值优先于配置项）
 */
export function resolveLinkTarget(policy: OpenLinksPolicy): LinkTarget | null {
  if (policy.remembered !== undefined) return policy.remembered;
  if (policy.configured === 'ask') return null;
  return policy.configured;
}

/** 记忆存储抽象（生产接 VS Code globalState；测试用内存 Map） */
export interface LinkPreferenceStore {
  get(): LinkTarget | undefined;
  set(value: LinkTarget): void;
}

/** 创建内存实现（供测试与无 globalState 场景使用） */
export function createMemoryPreferenceStore(): LinkPreferenceStore {
  let value: LinkTarget | undefined;
  return {
    get: () => value,
    set: (v) => {
      value = v;
    },
  };
}
