# dsh-remote-models · 远程模型配置

把个人账号使用的**自定义提供商**放在远程 JSON 文件中。插件启动时拉取，之后默认每 300 秒刷新；模型设置页底部可修改地址、刷新间隔、开关自动同步或立即同步。通过 dsh 的 Settings 服务校验并原子保存；生效于后续模型请求，不需要重启，也不打断正在运行的请求。

适配并验证的宿主：DeepSeek Harness `0.2.2-rc.1`，Cordis `4.1.x`，schemastery `3.18.4+`，Node.js ≥ 24.9。其他 dsh 版本需要重新验证 Settings/Connection/Tools 接口。

## 配置源

模型目录只在**一处**维护（任意一台你控制的机器上的一个 JSON 文件），其余设备只读同步。它属于个人账号使用的模型目录：使用同一份目录的设备需要各自拥有各模型服务的凭据；它不绑定 DSH 账号登录状态，也不自动获取或同步账号密钥。

可用的取法：普通 HTTP(S) 静态文件、WebDAV 路径、SSH 读取远端文件、或挂载后的网络共享。文档里所有示例使用占位地址，按自己的部署替换。

## JSON 格式

```json
{
  "version": 1,
  "providers": {
    "personal-gateway": {
      "displayName": "个人中转站",
      "api": "openai-completions",
      "baseURL": "https://gateway.example/v1",
      "apiKeyEnv": "PERSONAL_GATEWAY_API_KEY",
      "models": [{ "id": "example-model", "contextWindow": 131072, "maxTokens": 32768, "input": ["text"] }]
    }
  }
}
```

`providers` 就是 `dsh-llm-pi-ai` 的提供商字典。协议、模型、推理档位、容量、compat 等字段由当前安装的适配器做最终校验。模型数组整体替换，未指定的提供商字段保留本机值。`apiKeyEnv` 是凭据引用名称，不能写 API Key 明文；认证用的 headers 也不能放进远程文档。

只同步自定义提供商（模型设置页标记“自定义”的条目）；内置目录提供商（如 `openai-codex`、`zai-coding-cn`）由原有配置继续管理。默认保留本机已有的 `apiKeyEnv` 和部署 headers；新机器需在模型设置页填自己的 Key。

## 安装与配置

在插件管理器安装本目录，或用 `npm pack` 生成 tgz 后安装。推荐通过 dsh 自带插件管理器安装，使 bundle 选择和热加载由宿主管理。模型设置页底部出现“远程模型配置”。

profile 覆盖行（合并到已有 patch，不能覆盖整个文件）：

```yaml
- id: remote-models
  config:
    source:
      enabled: true
      url: webdavs://models.example.com/dav/models.json
      basicAuth:
        username: models-reader
        passwordRef: MODELS_DAV_PASSWORD
      intervalSeconds: 300
```

URL 支持：

| 地址形式 | 用法 |
|---|---|
| `https://host/path/models.json`、`http://…` | 普通 JSON 文件，支持 ETag/Last-Modified 条件请求 |
| `webdavs://host/dav/path/models.json`、`webdav://…` | 分别等价于 HTTPS/HTTP GET，无需 PROPFIND |
| `ssh://user@host:22/absolute/path/models.json` | 默认远端 POSIX `cat`；复用 OpenSSH 配置，严格校验主机密钥 |
| `ssh://windows-host/D:/share/models.json` | `sshShell: powershell`，Windows 远端固定的编码文件读取命令 |
| `file://server/share/path/models.json` | 网络共享；依赖运行 dsh 的系统账户有读权限 |

WebDAV Basic 认证：在本机 dsh 凭据库保存 `MODELS_DAV_PASSWORD`，source 中设置 `basicAuth: { username: your-account, passwordRef: MODELS_DAV_PASSWORD }`。Bearer 认证使用 `bearerTokenRef`；其他请求头使用 `headerRefs: { X-Access-Token: MODELS_SOURCE_TOKEN }`。只存引用，不在 URL 或 patch 写密码。

完整 source 字段：`enabled`、`url`、`intervalSeconds`（10–86400）、`timeoutSeconds`（默认 20，最大 120）、`maxBytes`（默认 1 MiB，最大 10 MiB）、`targetEntryId`（默认 `llm-pi-ai`）、`sshShell`、`basicAuth`、`bearerTokenRef`、`headerRefs`、`preserveLocalAuth`（默认 true）、`mode`（默认 merge）、`allowEmpty`（默认 false）、`overrides`。

如果某台电脑的本地模型端口不同，可设置 `overrides: { local-gateway: { baseURL: 'http://127.0.0.1:8000/v1' } }`；本机覆盖优先于远程值。source 中的这些设置都是本机配置，不会反写远程文件。

## 同步与回退

- 默认 `merge` 只新增/更新文件列出的自定义提供商，未列出的本机条目保留。需要删除时在模型设置页移除并从远程文件去掉；可选 `replace-custom` 会移除文件未列出的自定义条目，使用前确认文件完整。继承自 bundle 的提供商无法在此模式删除，插件会拒绝该次写入。
- 空文档默认拒绝；确实需要空目录时设置 `allowEmpty: true`。
- 一次同步只有一次带 revision 的 Settings mutation；JSON 错误、无效模型、网络失败、并发修改冲突均不写入。原有有效配置保存在 profile 中，断网或重启仍可使用。
- 手工在模型页修改受管字段，会在下次同步时被远程值覆盖；长期更改应修改远程 JSON 或配置本机 `overrides`。
- 停用插件/自动同步会停止轮询，已经保存的提供商配置保留。需要回退模型列表时修改远程 JSON 并立即同步。
- SSH 读取 Windows 路径会启动远端 PowerShell，但仅执行固定的文件读取操作。远程 JSON 从不作为插件、Loader patch、脚本或提示词执行。

Web 与 Electron 使用 Connection 的认证 Fetch 通道（`/api/remote-models/status`、`/api/remote-models/sync`，兼容 `rpc.call` 信封）。客户端通过宿主提供的 Connection 调用；desktop 实测使用应用自有的随机 loopback HTTP 后台端口，无需单独启动固定 3080 的 Web。另提供状态与手动同步：认证后的 `GET /api/remote-models/status`、`POST /api/remote-models/sync`；仅 owner Peer 可调用。dsh 智能体工具 `remote_models` 的 `action` 为 `status` 或 `sync`，调用与界面相同的实现。HTTP 接口继承宿主认证与 Host/Origin 检查。

0.1.6 修复模型设置界面缺少 `remote.settings` 注入声明导致一直显示“正在加载”的问题；后台同步、模型源和本机凭据保持原样。升级后刷新已有 Web 页面，desktop 重新打开模型设置页；若旧客户端代码仍驻留，重启桌面应用。

0.1.7 在比较模型配置前按宿主 schema 展开字面量默认值，避免宿主补入空兼容参数后，后续轮询误判为需要重复写入。

## 默认档位的显示（0.2.2 – 0.2.5）

`source` 里的每个提供商可以用 provider 级 `reasoning` 声明默认思考档位（例如 `"reasoning": "xhigh"`）。宿主只在**该模型自己声明了这一档**时才把它当作默认，所以“Default”这个词本身不说明具体是哪一档。

- 配置页底部「远程模型配置」列出 `各提供商默认档位`，例如 `personal-a → Default (Xhigh)`，并标出没有这一档、会被 provider 默认挡下的模型（这类模型发请求会以 `UNSUPPORTED_REASONING_EFFORT` 失败）。
- 推理等级（菜单行与输入框触发器）显示 `Default (Xhigh)`：只在“没有手动选过档位、且该提供商由本插件管理”时出现。判断依据是插件把 `status.providers` 写进 `globalThis.__dshRemoteModelProviders`，宿主侧那处文案由 `scripts/patch-model-picker-default.mjs` 打补丁实现（宿主包没有对应插槽）。
- 0.2.3 曾在模型名旁加过徽标（插槽 `conversation.input.model.label`）；该插槽会整段替换模型名，且内置路由会满屏出现 `Default (...)`，0.2.4 起已移除。

宿主 `@deepseek-ai/dsh-client-ui-model-selection` 里的“Default”行文本属于宿主 UI，插件不改写它。dsh 升级会覆盖上面的补丁，重跑一次 `scripts/patch-model-picker-default.mjs` 即可（`--revert` 还原）。

## 模型级压缩阈值（0.2.1）

共享 JSON 可添加顶层 `modelThresholds`，仅包含按提供商与模型 ID 绑定的比例：

```json
"modelThresholds": [
  { "provider": "personal-gateway", "model": "example-model", "thresholdRatio": 0.7 }
]
```

这个数组是模型级 `thresholdRatio` 的完整覆盖表。列出的比例更新到现有 compaction-basic 配置和各预设中已存在的同类条目；未列出的模型级比例被移除，随后继承各端原有全局值。`null` 也表示移除该模型级比例。省略整个 `modelThresholds` 字段可兼容旧文件，不操作压缩配置；显式 `[]` 清除模型级比例覆盖。

全局 `thresholdRatio`、auto、保留长度、headroom、总结模型等不变，其他模型级参数也保留。仅编辑已存在的压缩条目，不启用用户关闭的压缩功能。通过 dsh 原生 ConfigEditor 持久化与重载；新会话使用新预设，已运行会话可能继续保留原预设版本。检查或切换预设应在空闲时进行，不强制重置会话。

`source.mode: replace-custom` 时，以远程文件中的自定义提供商及模型名单为准，源中删除的旧自定义项会在各端移除；内置目录提供商、各端本机凭据及 `source.overrides` 保留。升级时先让所有客户端加载 0.2.1，再向源文件加入新字段；旧版本不识别该字段。

每个 Settings 或配置编辑操作使用宿主校验与持久化。多个预设逐个应用；模型写入失败时尝试回滚本轮阈值修改，遇到并发修改会保留用户新值并报告冲突。动态表达式生成的压缩配置不自动改写。新机器恢复须先配置本机凭据，再同步；远程 JSON 从不执行代码。

## 开发验证

`npm install --ignore-scripts`，`npm test`。测试覆盖参数校验、原子更新、凭据保留、内置路由保护、错误回退、ETag、超时/大小限制、跨域重定向、SSH 参数引用和插件卸载。

`scripts/patch-model-picker-default.mjs` 是给宿主模型选择器打“Default (档位)”文案的补丁脚本：默认从 `npm root -g` 定位包，先备份再改，可重复执行；`--revert` 从备份还原。
