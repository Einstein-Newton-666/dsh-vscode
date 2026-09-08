// test/proxy.test.ts — 本地代办代理的单元测试（假上游模拟 DSH 服务）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { createDshProxy, type ProxyTarget } from '../src/service/proxy';

/** 启动假上游（模拟 DSH：记录请求头、按路径回响应；upgrade 连接登记以便清理） */
async function serveUpstream(
  handler: http.RequestListener,
  onUpgrade?: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void,
): Promise<{ server: http.Server; port: number; seen: { host?: string; cookie?: string }[]; upgradeSockets: Duplex[] }> {
  const seen: { host?: string; cookie?: string }[] = [];
  const upgradeSockets: Duplex[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, cookie: req.headers.cookie });
    handler(req, res);
  });
  // upgrade 连接不归 closeAllConnections 管（Node 语义：升级后由用户负责），登记以便 closeUp 清理
  server.on('upgrade', (req, socket, head) => {
    upgradeSockets.push(socket);
    onUpgrade?.(req, socket, head);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, seen, upgradeSockets };
}

/** 启动代办并返回访问地址 */
async function startProxy(getTarget: () => ProxyTarget | null): Promise<{ proxy: ReturnType<typeof createDshProxy>; base: string }> {
  const proxy = createDshProxy({ getTarget });
  await proxy.start();
  return { proxy, base: proxy.baseUrl };
}

/** 关闭假上游：手动销毁 upgrade 连接 + 断全部连接 + close，避免测试进程挂起 */
function closeUp(up: { server: http.Server; upgradeSockets: Duplex[] }): void {
  for (const s of up.upgradeSockets) s.destroy();
  up.server.closeAllConnections?.();
  up.server.close();
}

test('转发：Host 重写为上游、注入会话 cookie，路径/查询/方法原样', async () => {
  const up = await serveUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`host=${req.headers.host ?? ''} cookie=${req.headers.cookie ?? ''} url=${req.url}`);
  });
  const target = { url: `http://127.0.0.1:${up.port}`, cookie: 'dsh-auth-x=v1' };
  const { proxy, base } = await startProxy(() => target);
  try {
    const res = await fetch(`${base}some/path?a=1`);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(body.includes(`host=127.0.0.1:${up.port}`), `Host 应重写为上游 authority：${body}`);
    assert.ok(body.includes('cookie=dsh-auth-x=v1'), '应注入会话 cookie');
    assert.ok(body.includes('url=/some/path?a=1'), '路径查询应原样透传');
    // 上游视角只收到一次请求，且 Host 是上游地址（不是代办端口）
    assert.deepEqual(up.seen, [{ host: `127.0.0.1:${up.port}`, cookie: 'dsh-auth-x=v1' }]);
  } finally {
    await proxy.stop();
    closeUp(up);
  }
});

test('转发：Origin 重写为上游 origin（页面从代办端口加载，POST 的 Origin 是代办端口，上游 CSRF 校验会 403）', async () => {
  const up = await serveUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`origin=${req.headers.origin ?? ''}`);
  });
  const target = { url: `http://127.0.0.1:${up.port}`, cookie: 'dsh-auth-x=v1' };
  const { proxy, base } = await startProxy(() => target);
  try {
    const proxyOrigin = base.replace(/\/$/, '');
    const res = await fetch(`${base}api/settings/describe`, {
      method: 'POST',
      headers: { origin: proxyOrigin, 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(
      body.includes(`origin=http://127.0.0.1:${up.port}`),
      `Origin 应重写为上游 origin（而非代办端口 ${proxyOrigin}）：${body}`,
    );
  } finally {
    await proxy.stop();
    closeUp(up);
  }
});

test('无会话 cookie 的目标：不注入 Cookie 头', async () => {
  const up = await serveUpstream((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  const { proxy, base } = await startProxy(() => ({ url: `http://127.0.0.1:${up.port}` }));
  try {
    await fetch(base);
    assert.equal(up.seen[0].cookie, undefined, '无 cookie 时不注入 Cookie 头');
  } finally {
    await proxy.stop();
    closeUp(up);
  }
});

test('剥离上游 set-cookie（iframe 不落 Strict cookie），其余响应头透传', async () => {
  const up = await serveUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'dsh-auth-x=v1; Path=/; HttpOnly', 'x-custom': 'yes' });
    res.end('{"ok":true}');
  });
  const { proxy, base } = await startProxy(() => ({ url: `http://127.0.0.1:${up.port}`, cookie: 'dsh-auth-x=v1' }));
  try {
    const res = await fetch(base);
    assert.equal(res.headers.get('x-custom'), 'yes');
    assert.equal(res.headers.get('set-cookie'), null, 'set-cookie 应被剥离');
    assert.equal(await res.text(), '{"ok":true}');
  } finally {
    await proxy.stop();
    closeUp(up);
  }
});

test('目标未就绪（getTarget=null）→ 503', async () => {
  const { proxy, base } = await startProxy(() => null);
  try {
    const res = await fetch(base);
    assert.equal(res.status, 503);
  } finally {
    await proxy.stop();
  }
});

test('上游 401 → 透传的同时触发 onAuthFailure（会话失效自愈信号）', async () => {
  const up = await serveUpstream((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  });
  let failures = 0;
  const proxy = createDshProxy({
    getTarget: () => ({ url: `http://127.0.0.1:${up.port}`, cookie: 'dsh-auth-x=v1' }),
    onAuthFailure: () => { failures += 1; },
  });
  await proxy.start();
  try {
    const res = await fetch(proxy.baseUrl);
    assert.equal(res.status, 401, '401 应照常透传给客户端');
    assert.equal(await res.text(), 'dsh web authentication required; reopen the URL printed by dsh web.\n');
    assert.equal(failures, 1, '应恰好触发一次 onAuthFailure');
  } finally {
    await proxy.stop();
    closeUp(up);
  }
});

test('POST 大请求体（1MB）完整透传', async () => {
  const big = Buffer.alloc(1024 * 1024, 0x5a); // 1MB
  const up = await serveUpstream((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      res.writeHead(200);
      res.end(`len=${body.length} eq=${body.equals(big) ? 'yes' : 'no'}`);
    });
  });
  const { proxy, base } = await startProxy(() => ({ url: `http://127.0.0.1:${up.port}` }));
  try {
    const res = await fetch(base, { method: 'POST', body: big });
    assert.equal(await res.text(), `len=${big.length} eq=yes`);
  } finally {
    await proxy.stop();
    closeUp(up);
  }
});

test('chunked 流式响应完整透传（SSE 场景）', async () => {
  const up = await serveUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: 1\n\n');
    setTimeout(() => {
      res.write('data: 2\n\n');
      res.end('data: 3\n\n');
    }, 30);
  });
  const { proxy, base } = await startProxy(() => ({ url: `http://127.0.0.1:${up.port}` }));
  try {
    const res = await fetch(base);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(await res.text(), 'data: 1\n\ndata: 2\n\ndata: 3\n\n');
  } finally {
    await proxy.stop();
    closeUp(up);
  }
});

test('WebSocket 升级透传（101 + 双向数据）', async () => {
  const up = await serveUpstream((_req, _res) => {}, (_req, socket) => {
    // 目标端：回 101，然后原样回显收到的字节
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(d));
  });
  const { proxy, base } = await startProxy(() => ({ url: `http://127.0.0.1:${up.port}` }));
  const proxyPort = new URL(base).port;
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(Number(proxyPort), '127.0.0.1', () => {
        sock.write(
          'GET /ws HTTP/1.1\r\nHost: 127.0.0.1:1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let buf = '';
      const timer = setTimeout(() => reject(new Error('WS 测试超时')), 3000);
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.includes('ping-echo')) {
          clearTimeout(timer);
          sock.destroy();
          resolve(buf);
        } else if (buf.includes('\r\n\r\n')) {
          // 101 已收到：发一帧文本测试回显
          sock.write('ping-echo');
        }
      });
      sock.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    assert.ok(result.includes('101 Switching Protocols'), '代理应透传 101');
    assert.ok(result.includes('ping-echo'), '升级后的双向数据应透传');
  } finally {
    await proxy.stop();
    closeUp(up);
  }
});
