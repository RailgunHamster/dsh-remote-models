import { isDeepStrictEqual } from 'node:util';

export class SyncError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (message) => { throw new SyncError('INVALID_DOCUMENT', message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const providerFields = new Set(['apiKeyEnv','displayName','api','baseURL','models','modelOverrides','compat',
  'defaultContextWindow','defaultMaxTokens','defaultInput','headers','reasoning','thinkingBudgets','cacheRetention',
  'transport','timeoutMs','websocketConnectTimeoutMs','streamIdleTimeoutMs','maxRequestImageBytes','maxRequestImages',
  'imageOffloadCountQuantum','requestImagePixelBudget','requestImageMaxBytes','retryPolicy']);

// Settings describes schemas as a uid/reference table. Materialize only their
// literal defaults; never evaluate schema functions or remote configuration.
// The adapter adds e.g. model.compat.chatTemplateArgs = {} on load. Comparing
// an unexpanded remote model to that view would schedule the same write forever.
function withSchemaDefaults(value, ref, refs, depth = 0) {
  const node = typeof ref === 'number' ? refs?.[ref] : ref;
  if (!node || depth > 32) return value;
  if (value === undefined && Object.hasOwn(node.meta ?? {}, 'default')) value = structuredClone(node.meta.default);
  if (node.type === 'object' && plain(value)) {
    const result = { ...value };
    for (const [key, child] of Object.entries(node.dict ?? {})) {
      const next = withSchemaDefaults(result[key], child, refs, depth + 1);
      if (next !== undefined) result[key] = next;
    }
    return result;
  }
  if (node.type === 'dict' && plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withSchemaDefaults(child, node.inner, refs, depth + 1)]));
  if (node.type === 'array' && Array.isArray(value)) return value.map(child => withSchemaDefaults(child, node.inner, refs, depth + 1));
  return value;
}

function providerSchema(descriptor) {
  const {schema} = descriptor;
  const root = schema?.refs?.[schema.uid] ?? schema;
  const providersRef = root?.dict?.providers;
  const providers = typeof providersRef === 'number' ? schema.refs[providersRef] : providersRef;
  return {ref: providers?.inner, refs: schema?.refs};
}

function checkTree(value, depth = 0) {
  if (depth > 32) fail('JSON nesting exceeds 32 levels');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Unsafe JSON property');
    checkTree(child, depth + 1);
  }
}

/** Only JSON data enters this path; remote files never become Loader patches or JavaScript. */
export function parseDocument(text) {
  let doc;
  try { doc = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { fail('Configuration must be valid JSON'); }
  checkTree(doc);
  if (!plain(doc) || doc.version !== 1 || !plain(doc.providers)) fail('Expected {"version":1,"providers":{...}}');
  if (Object.keys(doc).some(key => !['version', 'providers', 'modelThresholds', '$schema'].includes(key))) fail('Unknown document field');
  if(doc.modelThresholds!==undefined){
    if(!Array.isArray(doc.modelThresholds)||doc.modelThresholds.length>4096)fail('modelThresholds must be an array of at most 4096 routes');
    const routes=new Set();
    for(const rule of doc.modelThresholds){
      if(!plain(rule)||Object.keys(rule).some(key=>!['provider','model','thresholdRatio'].includes(key))||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rule.provider)||typeof rule.model!=='string'||!rule.model.trim()||rule.model.length>512||/[\x00-\x1f\x7f]/.test(rule.model)||
        (rule.thresholdRatio!==null&&(!Number.isFinite(rule.thresholdRatio)||rule.thresholdRatio<=0||rule.thresholdRatio>=1)))fail('Invalid model threshold; only provider, model, and thresholdRatio (0–1 or null) are allowed');
      const route=rule.provider+'\u0000'+rule.model;if(routes.has(route))fail('Duplicate model threshold route');routes.add(route);
    }
  }
  if (Object.keys(doc.providers).length > 256) fail('Too many providers (maximum 256)');
  for (const [id, profile] of Object.entries(doc.providers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || !plain(profile)) fail('Invalid provider ID or profile');
    if (Object.keys(profile).some(key => !providerFields.has(key))) fail(`Unknown field in provider ${id}`);
    if (profile.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv)) fail(`Invalid credential reference in ${id}`);
    if (profile.baseURL !== undefined) {
      let url; try { url = new URL(profile.baseURL); } catch { fail(`Invalid endpoint in ${id}`); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(`Invalid endpoint in ${id}`);
    }
    if (profile.headers !== undefined) {
      if (!plain(profile.headers)) fail(`Invalid headers in ${id}`);
      for (const [key, value] of Object.entries(profile.headers)) {
        if (/authorization|api[-_]?key|token|cookie|secret/i.test(key)) fail(`Store authentication in local credentials, not remote headers (${id})`);
        if (typeof value !== 'string') fail(`Invalid header value in ${id}`);
      }
    }
    if (profile.models !== undefined) {
      if (!Array.isArray(profile.models) || profile.models.length === 0) fail(`Provider ${id} needs a non-empty model list`);
      const ids = new Set();
      for (const model of profile.models) {
        if (!plain(model) || typeof model.id !== 'string' || !model.id.trim() || ids.has(model.id)) fail(`Empty or duplicate model ID in ${id}`);
        ids.add(model.id);
        for (const key of ['contextWindow','maxTokens']) {
          if (model[key] !== undefined && (!Number.isSafeInteger(model[key]) || model[key] < 1)) fail(`Invalid ${key} in ${id}`);
        }
      }
    }
  }
  return doc;
}

/** Build one atomic Settings mutation; other routes and local authentication survive. */
export function planOperations(doc, descriptor, directory, options) {
  const current = descriptor.value?.providers ?? {};
  const catalog = new Set(directory.filter(row => row.declared !== true).map(row => row.provider));
  const custom = new Set(directory.filter(row => row.settingsNs === options.targetEntryId && row.declared === true).map(row => row.provider));
  const ids = Object.keys(doc.providers);
  if (!ids.length && !options.allowEmpty) throw new SyncError('EMPTY_DOCUMENT', 'Empty provider documents require allowEmpty: true');
  const ops = [];
  const schema = providerSchema(descriptor);
  for (const id of ids) {
    if (catalog.has(id)) throw new SyncError('BUILTIN_PROVIDER', `Provider ${id} is built in; only custom providers may be synchronized`);
    if (directory.some(row => row.provider === id && row.settingsNs !== options.targetEntryId)) {
      throw new SyncError('PROVIDER_CONFLICT', `Provider ${id} belongs to another adapter`);
    }
    const next = { ...structuredClone(current[id] ?? {}), ...structuredClone(doc.providers[id]), ...structuredClone(options.overrides?.[id] ?? {}) };
    if (options.preserveLocalAuth !== false && current[id]) {
      if (current[id].apiKeyEnv !== undefined) next.apiKeyEnv = current[id].apiKeyEnv;
      // Include deployment-only headers a shared document should never erase.
      if (current[id].headers !== undefined) next.headers = { ...next.headers, ...current[id].headers };
    }
    // Native Settings descriptors contain optional schema properties with undefined
    // values. The Settings write seam accepts lossless JSON only (unlike an HTTP
    // round trip, an in-process call does not strip those properties for us).
    const jsonNext = JSON.parse(JSON.stringify(withSchemaDefaults(next, schema.ref, schema.refs)));
    const jsonCurrent = current[id] === undefined ? undefined : JSON.parse(JSON.stringify(current[id]));
    if (!isDeepStrictEqual(jsonNext, jsonCurrent)) ops.push({ op: 'set', path: ['providers', id], value: jsonNext });
  }
  if (options.mode === 'replace-custom') {
    for (const id of custom) {
      if (Object.hasOwn(current, id) && !Object.hasOwn(doc.providers, id)) {
        // Settings unset restores inherited providers; refuse to pretend those were deleted.
        if (Object.hasOwn(descriptor.base?.providers ?? {}, id)) throw new SyncError('INHERITED_PROVIDER', `Cannot remove inherited provider ${id}`);
        ops.push({ op: 'unset', path: ['providers', id] });
      }
    }
  }
  return ops;
}
