#!/usr/bin/env node
/**
 * Make the host model picker spell out the provider's default thinking level,
 * and keep that default selectable:
 *
 *   - the effort menu always offers `Default (Xhigh)` for a provider this
 *     plugin manages, so an explicit pick can be undone;
 *   - the effort label (menu cell and composer trigger) reads `Default (Xhigh)`
 *     while no explicit level is chosen, and the level name afterwards.
 *
 * The effort UI lives in the shipped client bundle
 * `@deepseek-ai/dsh-client-ui-model-selection`, which exposes no slot for it, so
 * this is a file patch: idempotent, backed up once, re-appliable after a dsh
 * upgrade reinstalls the package.
 *
 * Usage:
 *   node scripts/patch-model-picker-default.mjs [path/to/client.js]
 *   node scripts/patch-model-picker-default.mjs --revert
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PKG = path.join('@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-model-selection', 'lib', 'client.js');

/** Every replacement is anchored on text the pristine bundle contains exactly once. */
const EDITS = [
  {
    name: 'separate the explicit effort from the provider default',
    from: 'const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;',
    to: 'const explicitEffort = state.current?.reasoningEffort; const providerDefault = reasoning?.defaultEffort; '
      + 'const providerDefaultName = providerDefault === void 0 ? void 0 : reasoning.efforts.find((level) => level.id === providerDefault)?.name ?? providerDefault; '
      + 'const effectiveEffort = explicitEffort ?? providerDefault;',
    count: 1,
  },
  {
    name: 'label the resolved default',
    from: ': effectiveEffort === void 0 ? t("effort.providerDefault")',
    to: ': explicitEffort === void 0 && providerDefaultName !== void 0 '
      + '&& (globalThis.__dshRemoteModelProviders?.has(currentChoice?.group?.id) ?? false) '
      + '? `${t("effort.providerDefault")} (${providerDefaultName})` '
      + ': effectiveEffort === void 0 ? t("effort.providerDefault")',
    count: 1,
  },
  {
    name: 'offer the default row',
    from: 'const effortChoices = (0, react.useMemo)(() => reasoning === void 0 ? [] : [...reasoning.defaultEffort === void 0 ? [{',
    to: 'const showProviderDefault = reasoning !== void 0 && (reasoning.defaultEffort === void 0 || (providerDefaultName !== void 0 '
      + '&& (globalThis.__dshRemoteModelProviders?.has(currentChoice?.group?.id) ?? false))); '
      + 'const effortChoices = (0, react.useMemo)(() => reasoning === void 0 ? [] : [...showProviderDefault ? [{',
    count: 1,
  },
  {
    name: 'name the default row',
    from: 'label: t("effort.providerDefault")',
    to: 'label: providerDefaultName === void 0 ? t("effort.providerDefault") : `${t("effort.providerDefault")} (${providerDefaultName})`',
    count: 1,
  },
  {
    name: 'mark exactly one row: the default until an explicit level is picked',
    from: 'effectiveEffort === level.effort',
    to: '(level.effort === void 0 ? explicitEffort === void 0 : (showProviderDefault ? explicitEffort !== void 0 && effectiveEffort === level.effort : effectiveEffort === level.effort))',
    count: 3,
  },
  {
    name: 'recompute when the managed provider or default changes',
    from: '}))], [reasoning, t]);',
    to: '}))], [reasoning, t, showProviderDefault, providerDefaultName]);',
    count: 1,
  },
];

const MARKER = 'showProviderDefault';

function npmGlobalRoot() {
  // `npm` is a .cmd shim on Windows, so execFileSync without a shell cannot run it.
  try {
    const [command, args] = process.platform === 'win32'
      ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'npm root -g']]
      : ['sh', ['-c', 'npm root -g']];
    return execFileSync(command, args, { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return '';
  }
}

function globalRoots() {
  return [
    process.env.DSH_GLOBAL_ROOT,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules') : '',
    npmGlobalRoot(),
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs', 'node_modules') : '',
  ].filter(Boolean);
}

function resolveTarget(explicit) {
  if (explicit) return explicit;
  for (const root of globalRoots()) {
    const full = path.join(root, PKG);
    if (fs.existsSync(full)) return full;
  }
  return '';
}

const args = process.argv.slice(2);
const revert = args.includes('--revert');
const explicitTarget = args.find(arg => !arg.startsWith('--'));

const target = resolveTarget(explicitTarget);
if (!target || !fs.existsSync(target)) {
  console.error(`client bundle not found: ${target || '(unresolved)'}`);
  process.exit(2);
}

const backup = `${target}.bak-before-default-label`;
let source = fs.readFileSync(target, 'utf8');

if (revert) {
  if (!fs.existsSync(backup)) {
    console.error(`no backup to restore: ${backup}`);
    process.exit(2);
  }
  fs.copyFileSync(backup, target);
  console.log(`reverted ${target}`);
  process.exit(0);
}

if (source.includes(MARKER)) {
  console.log('already patched');
  process.exit(0);
}

if (source.includes('providerDefaultName')) {
  // An older patch shape: start over from the pristine backup so the anchors match.
  if (!fs.existsSync(backup)) {
    console.error('the bundle carries an older patch and no backup exists to restore it');
    process.exit(3);
  }
  fs.copyFileSync(backup, target);
  source = fs.readFileSync(target, 'utf8');
  console.log('restored the backup to re-patch with the current shape');
}

for (const edit of EDITS) {
  const found = source.split(edit.from).length - 1;
  if (found !== edit.count) {
    console.error(`anchor mismatch for "${edit.name}" (found ${found}, expected ${edit.count}); the shipped bundle changed, review the patch`);
    process.exit(3);
  }
}

if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
for (const edit of EDITS) source = source.split(edit.from).join(edit.to);
fs.writeFileSync(target, source);
console.log(`patched ${target}`);
console.log('reload the web page to pick it up');
