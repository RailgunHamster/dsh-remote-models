import { isDeepStrictEqual } from 'node:util';
import { AsyncResource } from 'node:async_hooks';
import { parseDocument, planOperations, SyncError } from './core.js';
import { readSource } from './transport.js';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const levelName = level => `${level.charAt(0).toUpperCase()}${level.slice(1)}`;

/**
 * A provider's `reasoning` field is its default thinking level, but the host
 * only reports it per model when that model declares the level. Mirror that
 * resolution so the panel can say which level "Default" means and which models
 * a provider-level default leaves unusable.
 */
export function summariseDefaults(doc) {
  return Object.entries(doc?.providers ?? {}).map(([provider, profile]) => {
    const level = typeof profile?.reasoning === 'string' ? profile.reasoning : null;
    const models = (Array.isArray(profile?.models) ? profile.models : []).map(model => {
      const declared = model?.reasoningEfforts === false ? null : Object.keys(model?.reasoningEfforts ?? {}).filter(name => THINKING_LEVELS.includes(name));
      return { id: model?.id, levels: declared ?? [], supported: level === null ? null : (declared === null ? false : declared.includes(level)) };
    });
    return {
      provider,
      level,
      label: level === null ? null : `Default (${levelName(level)})`,
      models,
      unsupported: level === null ? [] : models.filter(model => model.supported === false).map(model => model.id),
    };
  });
}

export class Synchronizer {
  constructor({ settings, llm, thresholds, getOptions, resolveCredential, logger, read = readSource }) {
    Object.assign(this, { settings, llm, thresholds, getOptions, resolveCredential, logger, read });
    this.state = { running: false, lastAttempt: null, lastSuccess: null, lastError: null, providers: [], defaults: [], changes: 0, modelThresholds: {configured:false,rules:0,changes:0} };
    this.closed = false;
    // Config Editor enters HMR's transaction queue. Timers created from a
    // volatile-update callback must retain the original startup context.
    this.scheduler = new AsyncResource('dsh-remote-models:scheduler');
  }
  status() {
    const o = this.getOptions();
    return { ...structuredClone(this.state), version:'0.2.2', enabled: o.enabled, configured: !!o.url, intervalSeconds: o.intervalSeconds, mode: o.mode,
      modelThresholdsSupported:!!this.thresholds,thresholdTargets:this.thresholds?.inspect()??[] };
  }
  start() { this.schedule(0); }
  schedule(delay) {
    clearTimeout(this.timer);
    if (!this.closed && this.getOptions().enabled && this.getOptions().url) {
      this.timer = this.scheduler.runInAsyncScope(() => setTimeout(() => void this.sync(), delay));
      this.timer.unref?.();
    }
  }
  reconfigure() {
    this.configurationChanged = true;
    this.activeAbort?.abort();
    this.cache = undefined;
    this.schedule(0);
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.activeAbort?.abort();
    await this.pending;
    this.scheduler.emitDestroy();
  }
  sync(signal) {
    if (this.closed) return Promise.resolve(this.status());
    if (this.pending) return this.pending;
    clearTimeout(this.timer);
    this.pending = this.run(signal).finally(() => {
      this.pending = undefined;
      const delay = this.configurationChanged ? 0 : this.getOptions().intervalSeconds * 1000;
      this.configurationChanged = false;
      this.schedule(delay);
    });
    return this.pending;
  }
  async run(signal) {
    const options = structuredClone(this.getOptions());
    this.activeAbort = new AbortController();
    const abort = AbortSignal.any([this.activeAbort.signal, ...(signal ? [signal] : [])]);
    Object.assign(this.state, { running: true, lastAttempt: new Date().toISOString() });
    try {
      if (!options.url) throw new SyncError('NO_SOURCE', 'Set a remote configuration URL first');
      const headers = {};
      const resolve = async ref => {
        const value = await this.resolveCredential(ref);
        if (!value) throw new SyncError('MISSING_CREDENTIAL', 'A configuration-source credential is missing');
        return value;
      };
      if (options.bearerTokenRef) headers.Authorization = `Bearer ${await resolve(options.bearerTokenRef)}`;
      if (options.basicAuth?.passwordRef) {
        if (options.bearerTokenRef) throw new SyncError('INVALID_AUTH', 'Use either Basic or Bearer authentication');
        headers.Authorization = 'Basic ' + Buffer.from(`${options.basicAuth.username}:${await resolve(options.basicAuth.passwordRef)}`).toString('base64');
      }
      for (const [header, ref] of Object.entries(options.headerRefs ?? {})) headers[header] = await resolve(ref);
      const cached = this.cache && isDeepStrictEqual(this.cache.options, options) ? this.cache.result : undefined;
      const result = await this.read(options, cached, headers, abort);
      const doc = parseDocument(result.text);
      if (abort.aborted || this.closed || !isDeepStrictEqual(this.getOptions(), options)) throw new SyncError('CANCELLED', 'Configuration source changed; stale result was discarded');
      const descriptor = this.settings.describe().find(row => row.ns === options.targetEntryId);
      if (!descriptor || !this.settings.writable) throw new SyncError('NO_TARGET', 'The target model adapter is not writable or has not finished loading');
      const ops = planOperations(doc, descriptor, this.llm.listConfigurableProviders(), options);
      if(doc.modelThresholds!==undefined&&!this.thresholds)throw new SyncError('NO_COMPACTION_EDITOR','This host cannot synchronize model compaction thresholds');
      let thresholdPlan;
      try{thresholdPlan=this.thresholds?.prepare(doc);}catch{throw new SyncError('COMPACTION_REJECTED','Model thresholds conflict with the local compaction configuration; global settings were retained');}
      try{
       await thresholdPlan?.commit(abort);
       if(abort.aborted||this.closed||!isDeepStrictEqual(this.getOptions(),options))throw new SyncError('CANCELLED','Configuration changed; stale synchronization was discarded');
       if (ops.length) {
        try { await this.settings.mutate(options.targetEntryId, ops, descriptor.revision); }
        catch (error) {
          throw new SyncError(error?.code === 'SETTINGS_CONFLICT' ? 'CONFLICT' : 'REJECTED',
            error?.code === 'SETTINGS_CONFLICT' ? 'Local settings changed during synchronization; retry' : 'dsh rejected the provider configuration; check protocols, models, and parameter values');
        }
       }
      }catch(error){
        try{await thresholdPlan?.rollback();}catch{throw new SyncError('ROLLBACK_CONFLICT','Concurrent compaction changes prevented a rollback; retry synchronization');}
        if(error instanceof SyncError)throw error;
        throw new SyncError('COMPACTION_REJECTED','dsh rejected model threshold changes; previous configuration was restored');
      }
      this.cache = { options, result };
      Object.assign(this.state, { lastSuccess: new Date().toISOString(), lastError: null, providers: Object.keys(doc.providers), defaults: summariseDefaults(doc), changes: ops.length+(thresholdPlan?.changes??0),
        modelThresholds:{configured:thresholdPlan?.configured??false,rules:thresholdPlan?.rules??0,targets:thresholdPlan?.targetCount??0,changes:thresholdPlan?.changes??0,skipped:thresholdPlan?.skipped??[]} });
    } catch (error) {
      this.state.lastError = { code: error instanceof SyncError ? error.code : 'SYNC_FAILED', message: error instanceof SyncError ? error.message : 'Synchronization failed; local configuration was retained' };
      if (!this.closed && this.state.lastError.code !== 'CANCELLED') this.logger?.warn(`remote-models: ${this.state.lastError.code}: ${this.state.lastError.message}`);
    } finally { this.state.running = false; }
    return this.status();
  }
}
