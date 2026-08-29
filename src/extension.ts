// src/extension.ts — 插件入口：装配各模块、注册命令、监听配置变更
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initI18n, t } from './i18n';
import { readConfig, type DshConfig } from './config';
import { probeService } from './service/detect';
import { createProcessRunner } from './service/process';
import { ServiceManager, type ManagerOptions } from './service/manager';
import { DshPanelProvider } from './panel/provider';
import { StatusBarController } from './statusbar';
import { resolveWorkspaceRoot } from './workspaceRoot';
import {
  installBridge,
  uninstallBridge,
  createNodeFs,
  type BridgeInstallResult,
} from './bridge/installer';
import { evaluateBridgeStatus, bridgeWarningText } from './bridge/status';
import { ContextController } from './context/controller';
import { createCurrentFileTracker, describeFileRef } from './context/tracker';

let manager: ServiceManager | null = null;
let output: vscode.OutputChannel | null = null;
let tracker: ReturnType<typeof createCurrentFileTracker> | null = null;
let panelPrimary: DshPanelProvider | null = null;
let panelSecondary: DshPanelProvider | null = null;

/** globalState 键：用户点击「不再提示」后置 true，持久静默桥接降级警告 */
const BRIDGE_SILENCE_KEY = 'dsh.bridgeWarningSilenced';
/** 握手超时（毫秒）：面板打开且服务就绪后，此时间内无任何 bridgeAck 视为握手失败 */
const HANDSHAKE_TIMEOUT_MS = 3000;
/** 激活后评估桥接状态的延迟（毫秒）：略大于握手超时，给握手回执留出时间 */
const BRIDGE_EVAL_DELAY_MS = 3500;

/** DshConfig → ManagerOptions（探测 3s、轮询 0.5s，与规格一致） */
function toManagerOptions(config: DshConfig): ManagerOptions {
  return {
    host: config.host,
    port: config.port,
    extraArgs: config.extraArgs,
    autoStart: config.autoStart,
    // 子进程工作目录兜底：按 dsh.workspaceRootIndex 解析工作区根目录，让 dsh web 以工作区为 cwd
    cwd: resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], config.workspaceRootIndex),
    timeoutMs: 3000,
    pollMs: 500,
  };
}

/** 插件激活：VS Code 启动完成后调用 */
export function activate(context: vscode.ExtensionContext): void {
  // 语言规则：vscode.env.language 以 zh- 开头 → 中文，其余一律英文
  initI18n(vscode.env.language);
  output = vscode.window.createOutputChannel('DSH');

  const { config, errors } = readConfig();
  for (const err of errors) output?.appendLine(`[config] ${err}`);

  // —— 桥接状态（单一状态，两个面板共享，避免多个面板重复触发定时器）——
  // install：桥接安装结果；桥接禁用时为 null（不安装、不评估、不弹警告）。
  // handshakeOk：握手回执（onBridgeAck 写入）；undefined=尚未握手，true/false=握手成败。
  let install: BridgeInstallResult | null = null;
  let handshakeOk: boolean | undefined;
  let handshakeTimer: NodeJS.Timeout | undefined;
  let evalTimer: NodeJS.Timeout | undefined;
  let panelOpened = false; // 是否已有面板打开过（触发握手超时的前提之一）
  let warningShown = false; // 本次会话是否已弹过降级警告（防止重复弹）

  /** 桥接安装参数（dshHome / bridgeSourceDir 全插件共用，避免三处重复拼接） */
  const installOpts = {
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    bridgeSourceDir: join(__dirname, 'bridge-client'),
    fs: createNodeFs(),
  };

  /**
   * 安全安装桥接：installBridge 的 IO 异常会直接抛出（Task 2 已知局限），
   * 此处 try/catch 捕获后按 degraded 处理（原因写入日志），绝不影响面板其它功能。
   */
  function safeInstallBridge(): BridgeInstallResult {
    try {
      return installBridge(installOpts);
    } catch (err) {
      output?.appendLine(`[bridge] install failed: ${String(err)}`);
      return { status: 'degraded', reason: String(err) };
    }
  }

  // 激活时安装桥接：bridge.enabled=false 时不安装、不注入握手脚本、不评估、不弹警告
  if (config.bridgeEnabled) {
    install = safeInstallBridge();
  }

  /** 清除握手超时定时器（收到回执或重试时调用） */
  function clearHandshakeTimer(): void {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
    }
  }

  /**
   * 启动握手超时（幂等）：面板已打开且服务已就绪、且尚未回执时，3 秒内无 bridgeAck 视为失败。
   * 服务未就绪时没有 iframe、握手不可能发生，因此不在此刻启动定时器，
   * 避免「服务启动慢」被误判为桥接降级；待 manager 进入 ready 后由 onChange 再触发。
   */
  function startHandshakeTimeout(): void {
    if (install === null) return; // 桥接被禁用：无握手脚本，不启动定时器
    if (handshakeOk !== undefined || handshakeTimer !== undefined) return;
    if (!panelOpened) return;
    if (manager?.getSnapshot().state !== 'ready') return;
    handshakeTimer = setTimeout(() => {
      handshakeTimer = undefined;
      // 3 秒内无任何 bridgeAck → 判定握手失败（degraded）
      if (handshakeOk === undefined) {
        handshakeOk = false;
        evaluateAndWarn(); // 握手刚失败，立即评估（不必再等固定延迟）
      }
    }, HANDSHAKE_TIMEOUT_MS);
  }

  /** 面板握手回执回调（两个面板共享）：记录结果并取消超时（握手已发生，无论成败） */
  function onBridgeAck(ok: boolean): void {
    handshakeOk = ok;
    clearHandshakeTimer();
  }

  /** 任一面板首次打开：标记已打开并尝试启动握手超时（幂等，不重复建定时器） */
  function onPanelFirstOpen(): void {
    panelOpened = true;
    startHandshakeTimeout();
  }

  /**
   * 评估桥接状态并在 degraded 时弹警告。
   * 静默条件（任一为真则不弹）：设置项 dsh.bridge.silenceWarning、globalState 静默标志、
   * 或本次会话已弹过；安装/握手成功（ok / pending-restart）也不弹。
   */
  function evaluateAndWarn(): void {
    if (install === null) return; // 桥接被禁用，不评估
    const status = evaluateBridgeStatus(install, handshakeOk);
    if (status !== 'degraded') return;
    if (readConfig().config.silenceWarning) return; // 设置项静默
    if (context.globalState.get<boolean>(BRIDGE_SILENCE_KEY)) return; // 「不再提示」静默
    if (warningShown) return; // 本次会话已弹过
    warningShown = true;
    const text = bridgeWarningText(status);
    if (text === null) return; // 防御性兜底（degraded 必有文案）
    void vscode.window
      .showWarningMessage(t(text), t('bridge.retryNow'), t('bridge.neverAgain'))
      .then((choice) => {
        if (choice === t('bridge.retryNow')) {
          void retryBridge(); // 重试安装：重新 installBridge + 重启服务
        } else if (choice === t('bridge.neverAgain')) {
          void context.globalState.update(BRIDGE_SILENCE_KEY, true); // 不再提示
        }
      });
  }

  /** 调度一次桥接状态评估（可重复调用；重复调用会重置定时器，只保留最后一次） */
  function scheduleEvaluation(): void {
    if (evalTimer) clearTimeout(evalTimer);
    evalTimer = setTimeout(() => {
      evalTimer = undefined;
      evaluateAndWarn();
    }, BRIDGE_EVAL_DELAY_MS);
  }

  /** 重试安装桥接（命令 dsh.bridge.retry 与警告「重试安装」按钮共用） */
  async function retryBridge(): Promise<void> {
    try {
      if (!readConfig().config.bridgeEnabled) return; // 桥接被禁用：不重试
      // 重新安装（异常降级并记日志，不中断重试流程）
      install = safeInstallBridge();
      // 重置握手状态：重启后 iframe 重载会重新握手，onBridgeAck 会写入新结果
      handshakeOk = undefined;
      clearHandshakeTimer();
      // 清警告静默（globalState 标志），允许后续再次弹出降级警告
      await context.globalState.update(BRIDGE_SILENCE_KEY, false);
      warningShown = false;
      // 重启服务，触发面板 iframe 重载与重新握手
      await manager?.restart();
      // 重启后重新评估一次（留出握手回执时间）
      scheduleEvaluation();
    } catch (err) {
      // 重试失败只记日志：命令入口是 void 调用，异常不能成为未处理拒绝
      output?.appendLine(`[bridge] retry failed: ${String(err)}`);
    }
  }

  /** 卸载桥接（命令 dsh.bridge.uninstall）：删除 profile 条目与目录，提示需重启 DSH 服务生效 */
  async function uninstallBridgeCmd(): Promise<void> {
    try {
      uninstallBridge(installOpts);
      void vscode.window.showInformationMessage(t('bridge.uninstalled'));
    } catch (err) {
      output?.appendLine(`[bridge] uninstall failed: ${String(err)}`);
      void vscode.window.showWarningMessage(t('bridge.uninstallFailed', { message: String(err) }));
    }
  }

  manager = new ServiceManager(toManagerOptions(config), {
    probeService,
    processRunner: createProcessRunner(),
    log: (line) => output?.appendLine(line),
  });
  manager.setExitBehavior(!config.stopOnExit);

  // —— 上下文联动装配：控制器 + 当前文件跟踪器 ——
  const controller = new ContextController({
    manager,
    getWorkspaceRoot: () =>
      resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], readConfig().config.workspaceRootIndex),
    getAutoFollow: () => readConfig().config.autoFollow,
    setAutoFollow: async (v) => {
      await vscode.workspace.getConfiguration('dsh').update('context.autoFollow', v, true);
    },
    messages: {
      t,
      showInformation: (m) => void vscode.window.showInformationMessage(m),
      showWarning: (m) => void vscode.window.showWarningMessage(m),
      // 注:简报原样返回 vscode 的 Thenable,而 ControllerMessages.showInputBox 要求 Promise,
      // 严格模式下类型不兼容,用 Promise.resolve 包装(语义等价)。
      showInputBox: (o) => Promise.resolve(vscode.window.showInputBox({ prompt: o.prompt, placeHolder: o.placeHolder })),
    },
  });

  // 防抖跟踪器：结算后驱动自动跟随与工具条刷新
  tracker = createCurrentFileTracker({ debounceMs: readConfig().config.followDebounceMs });
  tracker.onSettled((absPath) => {
    if (absPath !== undefined && readConfig().config.autoFollow) {
      void controller.autoInject(absPath);
    }
    // 注:panel 已按 9f 提升为模块级可空变量,回调内需 ?.(简报原样会触发 strict null checks 报错)
    panelPrimary?.refreshContextBar();
    panelSecondary?.refreshContextBar();
  });

  // 工作区根目录解析：多根工作区按 dsh.workspaceRootIndex 取根（越界回退第一个）。
  // 该 getter 仅用于 provider 的文件相对路径解析（openFile 的 workspaceRoot 兜底基准）。
  const workspaceRootGetter = (): string | undefined =>
    resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], readConfig().config.workspaceRootIndex);
  // 桥接启用 getter：随时读取最新配置，供 readyPage 决定是否注入握手脚本
  const bridgeEnabledGetter = (): boolean => readConfig().config.bridgeEnabled;

  /** 两个面板共享的上下文依赖(当前文件标签/自动跟随/加入动作) */
  function makeContextPanelDeps() {
    return {
      getFileLabel: () => {
        const p = tracker?.getCurrent();
        return p === undefined ? null : describeFileRef(p, workspaceRootGetter()).ref;
      },
      getAutoFollow: () => readConfig().config.autoFollow,
      addFileContext: () => {
        const p = tracker?.getCurrent();
        if (p === undefined) {
          void vscode.window.showWarningMessage(t('ctx.noActiveFile'));
          return;
        }
        void controller.addFileContext(p);
      },
      toggleAutoFollow: () => controller.toggleAutoFollow(),
    };
  }

  // 左右两侧各一个 provider 实例，共享同一 manager（服务状态一致）
  panelPrimary = new DshPanelProvider(
    manager,
    () => {
      void showSecondaryGuideOnce(context); // 首次打开面板弹一次入口引导
      onPanelFirstOpen(); // 面板打开：标记并尝试启动握手超时
    },
    onBridgeAck, // onBridgeAck：桥接握手回执 → handshakeOk（Task 7 状态评估）
    workspaceRootGetter, // workspaceRoot：文件相对路径解析的兜底基准
    bridgeEnabledGetter, // bridgeEnabled：dsh.bridge.enabled 驱动握手脚本注入
    makeContextPanelDeps(),
  );
  panelSecondary = new DshPanelProvider(
    manager,
    onPanelFirstOpen, // 辅助侧边栏首次打开同样触发握手超时
    onBridgeAck,
    workspaceRootGetter,
    bridgeEnabledGetter,
    makeContextPanelDeps(),
  );
  new StatusBarController(manager);

  // 服务就绪后启动握手超时（若面板已打开）
  manager.onChange((s) => {
    if (s.state === 'ready') {
      startHandshakeTimeout(); // 服务就绪：若面板已打开，启动握手超时
    }
  });

  context.subscriptions.push(
    // 第三参数：隐藏面板时保留 webview（iframe 不销毁、DSH 页面会话不丢）
    vscode.window.registerWebviewViewProvider('dsh.panel', panelPrimary, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('dsh.panel.secondary', panelSecondary, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dsh.openPanel', () => openPanel()),
    vscode.commands.registerCommand('dsh.openSecondary', () => openSecondary(context)),
    vscode.commands.registerCommand('dsh.openExternal', () => openExternal()),
    vscode.commands.registerCommand('dsh.restart', () => void manager?.restart()),
    vscode.commands.registerCommand('dsh.stop', () => void manager?.stop()),
    vscode.commands.registerCommand('dsh.copyUrl', () => copyUrl()),
    vscode.commands.registerCommand('dsh.showLogs', () => output?.show()),
    vscode.commands.registerCommand('dsh.bridge.retry', () => void retryBridge()),
    vscode.commands.registerCommand('dsh.bridge.uninstall', () => void uninstallBridgeCmd()),
    // —— 上下文联动命令 ——
    // 注:tracker 为模块级可空变量,命令回调内访问需 ?.(回调仅在激活后触发,tracker 必已赋值,语义等价)
    vscode.commands.registerCommand('dsh.addFileContext', () => {
      const p = tracker?.getCurrent();
      if (p === undefined) {
        void vscode.window.showWarningMessage(t('ctx.noActiveFile'));
        return;
      }
      void controller.addFileContext(p);
    }),
    vscode.commands.registerCommand('dsh.askAboutFile', () => {
      const p = tracker?.getCurrent();
      if (p === undefined) {
        void vscode.window.showWarningMessage(t('ctx.noActiveFile'));
        return;
      }
      void controller.askAboutFile(p);
    }),
    vscode.commands.registerCommand('dsh.sendSelection', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        void vscode.window.showWarningMessage(t('ctx.noSelection'));
        return;
      }
      void controller.sendSelection({
        fileAbsPath: ed.document.uri.fsPath,
        startLine: ed.selection.start.line + 1, // 1-based 行号(与编辑器显示一致)
        code: ed.document.getText(ed.selection),
      });
    }),
    vscode.commands.registerCommand('dsh.addPathContext', (uri?: vscode.Uri) => {
      if (uri) void controller.addFileContext(uri.fsPath);
    }),
    vscode.commands.registerCommand('dsh.askAboutPath', (uri?: vscode.Uri) => {
      if (uri) void controller.askAboutFile(uri.fsPath);
    }),
    vscode.commands.registerCommand('dsh.openContextPanel', () => openPanel()),
    // —— 活动编辑器跟踪：驱动工具条显示与自动跟随 ——
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      const doc = ed?.document;
      tracker?.setFile(doc !== undefined && doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined);
    }),
    // —— 工作区自适应：切换项目时自动重启服务(cwd)+ 幂等注册新工作区 ——
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void (async () => {
        const snap = await manager?.reconfigure(toManagerOptions(readConfig().config));
        const root = resolveWorkspaceRoot(
          vscode.workspace.workspaceFolders ?? [],
          readConfig().config.workspaceRootIndex,
        );
        if (snap?.state === 'ready' && root !== undefined) {
          await controller.registerWorkspace(); // 失败静默(内部已捕获)
        }
      })();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dsh')) onConfigChanged();
    }),
    { dispose: () => manager?.dispose() },
  );

  // 激活后延迟评估一次桥接状态：degraded 且未静默时弹警告
  scheduleEvaluation();
}

/** 打开面板：聚焦视图（VS Code 自动打开视图所在的侧边栏，左/右皆可） */
async function openPanel(): Promise<void> {
  await vscode.commands.executeCommand('dsh.panel.focus');
}

/** 在外部浏览器打开 DSH 页面 */
async function openExternal(): Promise<void> {
  const s = manager?.getSnapshot();
  if (!s || s.state !== 'ready' || !s.url) {
    void vscode.window.showWarningMessage(t('info.notReady'));
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(s.url));
}

/** 复制 DSH 页面地址到剪贴板 */
async function copyUrl(): Promise<void> {
  const s = manager?.getSnapshot();
  if (!s || s.state !== 'ready' || !s.url) {
    void vscode.window.showWarningMessage(t('info.notReady'));
    return;
  }
  await vscode.env.clipboard.writeText(s.url);
  void vscode.window.showInformationMessage(t('info.urlCopied', { url: s.url }));
}

/** 一次性引导：告知 DSH 面板可通过左侧活动栏与右侧辅助侧边栏的图标打开 */
async function showSecondaryGuideOnce(context: vscode.ExtensionContext): Promise<void> {
  const KEY = 'dsh.secondaryGuideShown';
  if (context.globalState.get(KEY)) return;
  await vscode.window.showInformationMessage(t('guide.secondaryText'), t('guide.gotIt'));
  void context.globalState.update(KEY, true);
}

/** 在辅助侧边栏打开：新版 VS Code（≥1.91）直接聚焦右侧视图；旧版回退聚焦+引导 */
async function openSecondary(context: vscode.ExtensionContext): Promise<void> {
  const cmds = await vscode.commands.getCommands(true);
  // 视图声明在 package.json 里，VS Code 会自动生成 <viewId>.focus 命令；
  // 存在即说明当前版本支持辅助侧边栏容器（≥1.91）
  if (cmds.includes('dsh.panel.secondary.focus')) {
    await vscode.commands.executeCommand('dsh.panel.secondary.focus');
    return;
  }
  // 旧版回退：聚焦辅助侧边栏（命令 ID 因版本而异，取存在者）+ 一次性移动引导
  const focusId = cmds.includes('workbench.action.focusSecondarySideBar')
    ? 'workbench.action.focusSecondarySideBar'
    : 'workbench.action.focusAuxiliaryBar';
  await vscode.commands.executeCommand(focusId);
  await vscode.commands.executeCommand('dsh.panel.focus');
  await showSecondaryGuideOnce(context);
}

/** 配置变更：host/port/cwd 变化时自动重启自启服务，退出策略与上下文设置实时生效 */
function onConfigChanged(): void {
  const m = manager;
  if (!m) return;
  const { config } = readConfig();
  void m.reconfigure(toManagerOptions(config));
  m.setExitBehavior(!config.stopOnExit);
  tracker?.setDebounceMs(config.followDebounceMs);
  panelPrimary?.refreshContextBar();
  panelSecondary?.refreshContextBar();
}

/** 插件停用：按 stopOnExit 决定是否停止自启服务（只杀插件自启的） */
export async function deactivate(): Promise<void> {
  const config = readConfig().config;
  if (config.stopOnExit) await manager?.stop();
  manager?.dispose();
}
