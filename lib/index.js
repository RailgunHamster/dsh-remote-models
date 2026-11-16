import z from '@deepseek-ai/schemastery';
import { Synchronizer } from './synchronizer.js';
import { ModelThresholds } from './thresholds.js';

export const name = 'remote-models';
export const inject = ['settings', 'llm', 'configEditor'];
const ref = z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const Config = z.object({
  source: z.object({
    enabled: z.boolean().default(true),
    url: z.string().default(''),
    intervalSeconds: z.number().step(1).min(10).max(86400).default(300),
    timeoutSeconds: z.number().step(1).min(1).max(120).default(20),
    maxBytes: z.number().step(1).min(1024).max(10485760).default(1048576),
    targetEntryId: z.string().default('llm-pi-ai'),
    mode: z.union(['merge','replace-custom']).default('merge'),
    allowEmpty: z.boolean().default(false),
    preserveLocalAuth: z.boolean().default(true),
    sshShell: z.union(['posix','powershell']).default('posix'),
    bearerTokenRef: ref,
    basicAuth: z.object({ username: z.string().required(), passwordRef: ref.required() }).default(null),
    headerRefs: z.dict(ref).default({}),
    overrides: z.dict(z.dict(z.any())).default({}),
  }).default({}).volatile(),
});

export function apply(ctx, config) {
  const sync = new Synchronizer({
    settings: ctx.settings, llm: ctx.llm, getOptions: () => config.source.get(), logger: ctx.logger,
    thresholds: new ModelThresholds(ctx.configEditor),
    resolveCredential: async reference => (await ctx.get('credentials')?.resolve(reference))?.value,
  });
  ctx.effect(() => { sync.start(); return () => sync.close(); });
  let lastOptions = config.source.get();
  ctx.on('loader/volatile-update', () => {
    const next = config.source.get();
    if (next === lastOptions) return;
    lastOptions = next;
    sync.reconfigure();
  });
  ctx.inject(['connection'], child => {
    // Connection's exact Fetch routes work on Web and in-process carriers and
    // admit owner Peers only. Keep their JSON envelope compatible with rpc.call.
    for (const [path, methods, action] of [
      ['/api/remote-models/status', ['GET','POST'], () => sync.status()],
      ['/api/remote-models/sync', ['POST'], request => sync.sync(request.signal)],
    ]) child.effect(() => child.connection.fetch.register({
      path, methods, requestBody: 'buffered',
      fetch: async request => {
        const headers = {'Cache-Control':'no-store'};
        if (request.method === 'POST' && request.headers.get('content-type')?.split(';')[0] === 'application/json') {
          let envelope;
          try { envelope = await request.json(); } catch { return Response.json({error:'Invalid JSON'}, {status:400,headers}); }
          if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string' || envelope.rpcId.length > 128 || envelope.method !== path.slice(5)) {
            return Response.json({error:'Invalid request envelope'}, {status:400,headers});
          }
          return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:await action(request)}}, {headers});
        }
        return Response.json(await action(request), {headers});
      },
    }));
  });
  ctx.inject(['tools'], child => {
    child.effect(() => child.tools.register({
      name: 'remote_models', description: 'Inspect remote custom-model synchronization status, or synchronize the configured personal model JSON now.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['status','sync'] } }, required: ['action'], additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => args.action === 'sync' ? sync.sync(exec.signal) : sync.status(),
    }));
  });
}
