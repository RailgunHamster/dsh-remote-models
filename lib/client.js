window.__ModuleLoader__.load({
  id: 'dsh-remote-models',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const translations = {
      en: {thresholds:'Model compaction thresholds',title:'Remote model configuration',intro:'Update custom models and model compaction thresholds. API keys stay on this device.',url:'Configuration file URL',interval:'Refresh interval (seconds)',save:'Save',sync:'Sync now',refresh:'Refresh status',loading:'Loading…',enabled:'Enable automatic synchronization',never:'Not yet synchronized',success:'Last successful synchronization',failure:'Synchronization failed; previous configuration is retained',mode:'Merge providers; providers missing from the file stay on this device.',saved:'Saved',modeReplace:'Replace custom providers; missing custom providers will be removed.',defaultsTitle:'Provider default effort',defaultsServer:'Default (server)',defaultsBlocked:'not offered by {models}'},
      zh: {thresholds:'模型级压缩阈值',title:'远程模型配置',intro:'自动更新自定义模型和模型级压缩阈值，API Key 保留在本机。',url:'配置文件地址',interval:'刷新间隔（秒）',save:'保存',sync:'立即同步',refresh:'刷新状态',loading:'正在加载…',enabled:'启用自动同步',never:'尚未同步',success:'上次同步成功',failure:'同步失败，保留原有配置',mode:'合并更新；远程文件中未列出的本机提供商会保留。',saved:'已保存',modeReplace:'替换自定义提供商；远程文件中未列出的自定义提供商会移除。',defaultsTitle:'各提供商默认档位',defaultsServer:'Default (服务端)',defaultsBlocked:'{models} 没有这一档'},
    };
    const css = `.dsh-rm-card{margin-top:24px;padding:20px;border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:16px;background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary)}.dsh-rm-card h3{margin:0 0 8px;font-size:16px}.dsh-rm-card p{font-size:13px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.dsh-rm-card label{display:flex;flex-direction:column;gap:6px;font-size:13px;margin:12px 0}.dsh-rm-card input[type=url],.dsh-rm-card input[type=number],.dsh-rm-card input[type=text]{box-sizing:border-box;width:100%;padding:9px 12px;color:inherit;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:8px;font:inherit}.dsh-rm-card button{font:inherit;padding:7px 12px;border-radius:8px;border:1px solid var(--dsw-alias-settings-card-stroke);color:inherit;background:transparent;cursor:pointer}.dsh-rm-card button:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-rm-card button:disabled{opacity:.5;cursor:default}.dsh-rm-card .dsh-rm-check{flex-direction:row;align-items:center}.dsh-rm-actions{display:flex;gap:8px;flex-wrap:wrap}.dsh-rm-card .dsh-rm-error{color:var(--dsw-alias-state-error-primary)}.dsh-rm-card .dsh-rm-defaults p{font-size:12px;margin:2px 0}`;
    return {
      inject: ['slots','locale','remote','remote.settings','connection'],
      apply(ctx) {
        // Each typed Remote namespace is its own Cordis service dependency.
        // Capture it in this plugin's injected scope before registering the view.
        const settings = ctx.remote.settings;
        for (const [language, dict] of Object.entries(translations)) ctx.effect(() => ctx.locale.register('remote-models', language, dict));
        const t = ctx.locale.bind('remote-models');
        const call = async (action, signal) => {
          const response = await ctx.connection.rpc.call('/api', `remote-models/${action}`, {args:{}}, signal);
          if (!response.ok) throw new Error(response.error.message);
          return response.value;
        };
        // The model picker appends the resolved default only for providers this
        // document manages; it reads that set through this one shared global
        // (see scripts/patch-model-picker-default.mjs).
        const publishProviders = providers => {
          globalThis.__dshRemoteModelProviders = new Set(Array.isArray(providers) ? providers : []);
        };
        void call('status').then(status => publishProviders(status?.providers)).catch(() => {});
        function RemoteModels() {
          React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
          const [config, setConfig] = React.useState(null);
          const [url, setURL] = React.useState('');
          const [interval, setIntervalValue] = React.useState(300);
          const [enabled, setEnabled] = React.useState(true);
          const [status, setStatus] = React.useState(null);
          const [busy, setBusy] = React.useState(false);
          const [error, setError] = React.useState('');
          const [notice, setNotice] = React.useState('');
          const life = React.useRef(null);
          React.useEffect(() => {
            const abort = new AbortController(); life.current = abort;
            const load = async () => {
              const reply = await settings.describe();
              if (!reply.ok) throw new Error(reply.error.message);
              const row = reply.value.namespaces.find(x => x.ns === 'remote-models');
              if (!row) throw new Error('remote-models settings unavailable');
              if (abort.signal.aborted) return;
              setConfig(row); setURL(row.value.source.url); setIntervalValue(row.value.source.intervalSeconds); setEnabled(row.value.source.enabled);
              const initial = await call('status', abort.signal);
              setStatus(initial); publishProviders(initial?.providers);
            };
            void load().catch(e => { if (!abort.signal.aborted) setError(e.message); });
            const timer = setInterval(() => { void call('status', abort.signal).then(value => { if (!abort.signal.aborted) { setStatus(value); publishProviders(value?.providers); } }).catch(() => {}); }, 5000);
            return () => { abort.abort(); clearInterval(timer); };
          }, []);
          async function action(kind) {
            setBusy(true); setError(''); setNotice('');
            try {
              if (kind === 'save') {
                if (!Number.isInteger(Number(interval)) || Number(interval) < 10 || Number(interval) > 86400) throw new Error('10–86400 seconds');
                const reply = await settings.mutate('remote-models', [
                  {op:'set',path:['source','url'],value:url.trim()},
                  {op:'set',path:['source','intervalSeconds'],value:Number(interval)},
                  {op:'set',path:['source','enabled'],value:enabled},
                ], config.revision);
                if (!reply.ok) throw new Error(reply.error.message);
                setConfig(reply.value); setNotice(t('saved'));
              }
              const outcome = await call(kind === 'sync' ? 'sync' : 'status', life.current.signal);
              setStatus(outcome); publishProviders(outcome?.providers);
            } catch (e) { if (!life.current.signal.aborted) setError(e.message); }
            finally { if (!life.current.signal.aborted) setBusy(false); }
          }
          return h('section', {className:'dsh-rm-card'},
            h('style', null, css), h('h3', null, t('title')), h('p', null, t('intro')),
            !config ? h('p', null, t('loading')) : h(React.Fragment, null,
              h('label', null, t('url'), h('input', {type:'text',value:url,onChange:e=>setURL(e.target.value),placeholder:'https://…/models.json / ssh://host/path',spellCheck:false,disabled:busy})),
              h('label', null, t('interval'), h('input', {type:'number',min:10,max:86400,value:interval,onChange:e=>setIntervalValue(e.target.value),disabled:busy})),
              h('label', {className:'dsh-rm-check'}, h('input', {type:'checkbox',checked:enabled,onChange:e=>setEnabled(e.target.checked),disabled:busy}), t('enabled')),
              h('p', null, t(status?.mode === 'replace-custom' ? 'modeReplace' : 'mode')),
              h('div', {className:'dsh-rm-actions'}, ...['save','sync','refresh'].map(kind=>h('button', {key:kind,type:'button',disabled:busy || (kind==='sync'&&!config.value.source.url),onClick:()=>void action(kind)}, t(kind)))),
            ),
            h('p', {role:'status','aria-live':'polite'}, status?.lastSuccess ? `${t('success')}: ${new Date(status.lastSuccess).toLocaleString()} · ${status.providers.length}` : t('never')),
            status?.modelThresholds?.configured ? h('p', null, `${t('thresholds')}: ${status.modelThresholds.rules}`) : null,
            Array.isArray(status?.defaults) && status.defaults.length ? h('div', {className:'dsh-rm-defaults'},
              h('p', null, t('defaultsTitle')),
              ...status.defaults.map(row => h('p', {key:row.provider},
                `${row.provider} → ${row.label ?? t('defaultsServer')}` + (row.unsupported?.length ? ` · ${t('defaultsBlocked', {models:row.unsupported.join(', ')})}` : ''))),
            ) : null,
            status?.lastError ? h('p', {className:'dsh-rm-error',role:'alert'}, `${t('failure')} (${status.lastError.code}): ${status.lastError.message}`) : null,
            error ? h('p', {className:'dsh-rm-error',role:'alert'}, error) : null,
            notice ? h('p', {role:'status'}, notice) : null,
          );
        }
        ctx.slots.inject('settings.models.footer', () => ctx.slots.register({name:'settings.models.footer',id:'remote-models',order:50}, RemoteModels));
      },
    };
  },
});
