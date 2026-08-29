// test/integration/dsh-context.test.ts — 真实 dsh web 的上下文注入链路
// 无 dsh 命令的环境自动跳过;随机空闲端口;独立 DSH_HOME 目录(见下方说明)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeService } from '../../src/service/detect';
import { createProcessRunner } from '../../src/service/process';
import { ServiceManager } from '../../src/service/manager';
import { createDshApi, DshApiError, type DshApi, type WorkspaceView } from '../../src/context/dshApi';
import { buildContextMessage, findTargetSession, injectContext } from '../../src/context/injector';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const hasDsh = spawnSync('dsh', ['--version'], { timeout: 5000 }).status === 0;

// 独立 DSH_HOME:node --test 按文件并行,两个集成测试文件若共享同一目录会互相干扰
// (实测偶发 workspace.create 404,根因为并行 dsh 进程争用同一 HOME 的初始化)。此处
// 分配独立临时目录并写入进程环境,子进程(spawn)继承后互不影响。
const dshHome = mkdtempSync(join(tmpdir(), 'dsh-it-home-'));
process.env.DSH_HOME = dshHome;

// dsh 0.1.1-rc.2 启动时序(实测):首页(含 __DSH_BOOT__ 标记)在 API 路由注册之前就可访问,
// 二者相差约 1 秒。ensureRunning 基于首页探测,返回 ready 后立即调用 workspace.create 会撞上
// 404 窗口(kind=unsupported)。这里轮询重试首次 workspace.create,直到成功或超时。
async function waitApiReady(
  api: DshApi,
  root: string,
  timeoutMs = 10000,
): Promise<{ workspace: WorkspaceView; created: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await api.workspaceCreate(root);
    } catch (err) {
      if (err instanceof DshApiError && err.kind === 'unsupported') {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      throw err;
    }
  }
  assert.fail(`等待 dsh API 就绪超时(${timeoutMs}ms):${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

// dsh 0.1.1-rc.2 行为差异(实证 0.1.0-rc.6 无此限制):
// queue 模式的 prompt 若在首轮 turn 尚未结束时到达,会被服务端吞掉,不写入 history。
// 因此两次注入之间需轮询等待首轮 turn/end 事件,确保消息固化后再注入第二条。
async function waitTurnEnd(api: DshApi, sessionId: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await api.call<{ events: Array<{ event: { type: string } }> }>('session.history', {
      sessionId,
      maxMessages: 50,
    });
    if (h.events.some((e) => e.event.type === 'turn/end')) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.fail(`等待会话首轮结束超时(${timeoutMs}ms)`);
}

test('上下文注入全链路:workspace 幂等 → 会话新建/复用 → prompt → history 验证', { skip: !hasDsh && 'dsh 命令不可用,跳过' }, async () => {
  const port = await freePort();
  const manager = new ServiceManager(
    { host: '127.0.0.1', port, extraArgs: [], autoStart: true, timeoutMs: 3000, pollMs: 300 },
    { probeService, processRunner: createProcessRunner(), log: () => {}, startTimeoutMs: 20000 },
  );
  try {
    const s = await manager.ensureRunning();
    assert.equal(s.state, 'ready');
    const api: DshApi = createDshApi(`http://127.0.0.1:${port}`);
    const root = process.cwd();

    // workspace.create 幂等(首次成功经 waitApiReady 等到 API 路由就绪)
    const w1 = await waitApiReady(api, root);
    const w2 = await api.workspaceCreate(root);
    assert.equal(w1.workspace.workspaceId, w2.workspace.workspaceId);
    assert.equal(w1.created, true);
    assert.equal(w2.created, false);

    // 首次注入:无会话 → 新建
    const r1 = await injectContext(api, { workspaceRoot: root, ref: 'src/extension.ts' });
    assert.equal(r1.created, true);
    // 等待首轮 turn 固化(见 waitTurnEnd 注释:dsh 0.1.1-rc.2 会吞掉 turn 进行中的 queue prompt)
    await waitTurnEnd(api, r1.sessionId);

    // 二次注入:复用同一会话
    const r2 = await injectContext(api, { workspaceRoot: root, ref: 'src/i18n.ts' });
    assert.equal(r2.created, false);
    assert.equal(r2.sessionId, r1.sessionId);

    // 会话定位:按 cwd 找到该会话
    const sessions = await api.sessionList();
    const found = findTargetSession(sessions, root);
    assert.equal(found?.sessionId, r1.sessionId);

    // history 验证消息落地(上下文式文案)
    await new Promise((r) => setTimeout(r, 500));
    const hist = await api.call<{
      events: Array<{ event: { type: string; data?: { content?: Array<{ type: string; text?: string }> } } }>;
    }>('session.history', { sessionId: r1.sessionId, maxMessages: 4 });
    const texts = hist.events
      .filter((e) => e.event.type === 'user/message')
      .flatMap((e) => e.event.data?.content ?? [])
      .map((c) => c.text ?? '');
    assert.ok(texts.some((t) => t.includes(buildContextMessage('src/extension.ts'))));
    assert.ok(texts.some((t) => t.includes(buildContextMessage('src/i18n.ts'))));
  } finally {
    await manager.stop();
    manager.dispose();
    rmSync(dshHome, { recursive: true, force: true });
  }
});
