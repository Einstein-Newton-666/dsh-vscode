// test/context/dshApi.test.ts — DSH 信封协议客户端单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDshApi, DshApiError } from '../../src/context/dshApi';

/** 假 fetch:记录请求并返回预置响应 */
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input, init) => {
    // 注:项目 tsconfig 无 DOM lib,fetch 类型来自 @types/node,input 为 string | URL | Request;
    // URL 用 href,Request 用 url(与简报原写法 input.url 语义等价)。
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    return handler(url, init ?? {});
  }) as typeof fetch;
}

function okResponse(value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId: 'r1', result: { ok: true, value } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('call 构造正确信封:POST /api/<method>,body 含 type/rpcId/method/payload', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const api = createDshApi('http://127.0.0.1:3080/', {
    fetchImpl: fakeFetch((url, init) => {
      captured = { url, init };
      return okResponse({ hello: 1 });
    }),
  });
  const value = await api.call<{ hello: number }>('workspace.create', { path: '/tmp/x' });
  assert.deepEqual(value, { hello: 1 });
  assert.equal(captured!.url, 'http://127.0.0.1:3080/api/workspace.create');
  const body = JSON.parse(captured!.init.body as string);
  assert.equal(body.type, 'client-request');
  assert.equal(body.method, 'workspace.create');
  assert.deepEqual(body.payload, { path: '/tmp/x' });
  assert.equal(typeof body.rpcId, 'string');
  assert.ok(body.rpcId.length > 0);
});

test('rpcId 递增且带前缀', async () => {
  const seen: string[] = [];
  const api = createDshApi('http://127.0.0.1:3080', {
    rpcIdPrefix: 'probe',
    fetchImpl: fakeFetch((_url, init) => {
      seen.push((JSON.parse(init.body as string) as { rpcId: string }).rpcId);
      return okResponse({});
    }),
  });
  await api.call('a.b');
  await api.call('a.b');
  assert.deepEqual(seen, ['probe-1', 'probe-2']);
});

test('RPC 错误(result.ok=false)→ DshApiError kind=rpc 且带 code', async () => {
  const api = createDshApi('http://127.0.0.1:3080', {
    fetchImpl: fakeFetch(() =>
      new Response(
        JSON.stringify({
          type: 'server-response',
          rpcId: 'r1',
          result: { ok: false, error: { code: 'bad-request', message: 'invalid payload' } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  });
  await assert.rejects(api.call('session.prompt', {}), (err: unknown) => {
    assert.ok(err instanceof DshApiError);
    assert.equal((err as DshApiError).kind, 'rpc');
    assert.equal((err as DshApiError).code, 'bad-request');
    assert.match((err as DshApiError).message, /invalid payload/);
    return true;
  });
});

test('404 → kind=unsupported;5xx → kind=network;非 JSON → kind=network', async () => {
  const notFound = createDshApi('http://127.0.0.1:3080', {
    fetchImpl: fakeFetch(() => new Response('not found', { status: 404 })),
  });
  await assert.rejects(notFound.call('sessions.list', {}), (err: unknown) => (err as DshApiError).kind === 'unsupported');

  const serverError = createDshApi('http://127.0.0.1:3080', {
    fetchImpl: fakeFetch(() => new Response('oops', { status: 500 })),
  });
  await assert.rejects(serverError.call('session.list'), (err: unknown) => (err as DshApiError).kind === 'network');

  const malformed = createDshApi('http://127.0.0.1:3080', {
    fetchImpl: fakeFetch(() => new Response('{not json', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  });
  await assert.rejects(malformed.call('session.list'), (err: unknown) => (err as DshApiError).kind === 'network');
});

test('fetch 抛错(网络失败/超时 abort)→ kind=network', async () => {
  const api = createDshApi('http://127.0.0.1:3080', {
    fetchImpl: (() => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch,
  });
  await assert.rejects(api.call('session.list'), (err: unknown) => (err as DshApiError).kind === 'network');
});

test('四个封装方法映射正确的方法名与 payload 形状', async () => {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const api = createDshApi('http://127.0.0.1:3080', {
    fetchImpl: fakeFetch((_url, init) => {
      const body = JSON.parse(init.body as string);
      calls.push({ method: body.method, payload: body.payload });
      const value = body.method === 'session.list'
        ? { items: [{ sessionId: 's1', updatedAt: 1 }] }
        : body.method === 'session.prompt'
          ? { accepted: true }
          : body.method === 'session.create'
            ? { sessionId: 's9' }
            : { workspace: { workspaceId: 'w1', path: '/p', title: 'p', sessionIds: [], createdAt: 'x', updatedAt: 'x' }, created: true };
      return okResponse(value);
    }),
  });
  await api.workspaceCreate('/p');
  await api.sessionList();
  await api.sessionCreate({ cwd: '/p' });
  await api.sessionPrompt({ sessionId: 's9', text: 'hi' });
  assert.deepEqual(calls.map((c) => c.method), ['workspace.create', 'session.list', 'session.create', 'session.prompt']);
  assert.deepEqual(calls[3].payload, {
    sessionId: 's9',
    mode: 'queue',
    content: [{ type: 'text', text: 'hi' }],
  });
});
