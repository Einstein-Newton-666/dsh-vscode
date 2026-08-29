// src/context/dshApi.ts — DSH HTTP 信封协议客户端(纯模块,不依赖 vscode)
// 协议实证(0.1.0-rc.6):
//   POST /api/<namespace>.<method>
//   请求: { type:'client-request', rpcId, method, payload }
//   响应: { type:'server-response', rpcId, result:{ ok:true, value } | { ok:false, error:{code,message} } }
// 注意:方法名用单数 namespace(session.list;复数 sessions.list 返回 404)。

export interface WorkspaceView {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  blank?: boolean;
  cwd?: string;
}

export type DshApiErrorKind = 'network' | 'rpc' | 'unsupported';

export class DshApiError extends Error {
  constructor(
    readonly kind: DshApiErrorKind,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DshApiError';
  }
}

interface RpcEnvelope {
  type: 'server-response';
  rpcId: string;
  result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
}

export interface DshApi {
  call<T>(method: string, payload?: unknown): Promise<T>;
  workspaceCreate(path: string): Promise<{ workspace: WorkspaceView; created: boolean }>;
  sessionList(): Promise<SessionSummary[]>;
  sessionCreate(opts: { cwd?: string; workspaceId?: string }): Promise<{ sessionId: string }>;
  sessionPrompt(opts: { sessionId: string; text: string }): Promise<void>;
}

export interface DshApiOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  rpcIdPrefix?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function createDshApi(baseUrl: string, opts: DshApiOptions = {}): DshApi {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prefix = opts.rpcIdPrefix ?? 'dsh-vscode';
  const base = baseUrl.replace(/\/+$/, '');
  let seq = 0;

  async function call<T>(method: string, payload: unknown = {}): Promise<T> {
    const rpcId = `${prefix}-${++seq}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new DshApiError('network', `request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) throw new DshApiError('unsupported', `DSH does not support ${method}`);
    if (!res.ok) throw new DshApiError('network', `DSH responded ${res.status}`);
    let body: RpcEnvelope;
    try {
      body = (await res.json()) as RpcEnvelope;
    } catch {
      throw new DshApiError('network', 'malformed DSH response');
    }
    if (body.type !== 'server-response' || !body.result) {
      throw new DshApiError('network', 'malformed DSH response');
    }
    if (!body.result.ok) {
      throw new DshApiError('rpc', body.result.error.message, body.result.error.code);
    }
    return body.result.value as T;
  }

  return {
    call,
    workspaceCreate: (path) => call<{ workspace: WorkspaceView; created: boolean }>('workspace.create', { path }),
    sessionList: () => call<{ items: SessionSummary[] }>('session.list').then((r) => r.items),
    sessionCreate: (o) => call<{ sessionId: string }>('session.create', o),
    sessionPrompt: (o) =>
      call<{ accepted: true }>('session.prompt', {
        sessionId: o.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: o.text }],
      }).then(() => undefined),
  };
}
