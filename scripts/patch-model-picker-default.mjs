#!/usr/bin/env node
/**
 * Make the host model picker's "Default" effort label spell out the level it
 * resolves to (`Default (Xhigh)`), for the provider-level `reasoning` default.
 *
 * The composer's effort label lives in the shipped client bundle
 * `@deepseek-ai/dsh-client-ui-model-selection`, which exposes no slot for it, so
 * this is a file patch: idempotent, backed up once, and re-appliable after a
 * dsh upgrade reinstalls the package.
 *
 * Usage:
 *   node scripts/patch-model-picker-default.mjs [path/to/client.js]
 *   node scripts/patch-model-picker-default.mjs --revert
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PKG = path.join('@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-model-selection', 'lib', 'client.js');
const ANCHOR_A = 'const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;';
const PATCH_A = 'const explicitEffort = state.current?.reasoningEffort; const providerDefault = reasoning?.defaultEffort; '
  + 'const providerDefaultName = providerDefault === void 0 ? void 0 : reasoning.efforts.find((level) => level.id === providerDefault)?.name ?? providerDefault; '
  + 'const effectiveEffort = explicitEffort ?? providerDefault;';
const ANCHOR_B = ': effectiveEffort === void 0 ? t("effort.providerDefault")';
const PATCH_B = ': explicitEffort === void 0 && providerDefaultName !== void 0 '
  + '&& (globalThis.__dshRemoteModelProviders?.has(currentChoice?.group?.id) ?? false) '
  + '? `${t("effort.providerDefault")} (${providerDefaultName})` '
  + ': effectiveEffort === void 0 ? t("effort.providerDefault")';

const args = process.argv.slice(2);
const revert = args.includes('--revert');
const candidates = args.filter(arg => !arg.startsWith('--'));

function resolveTarget() {
  if (candidates.length) return candidates[0];
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return path.join(root, PKG);
  } catch {
    return '';
  }
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const target = resolveTarget();
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

if (source.includes('__dshRemoteModelProviders')) {
  console.log('already patched');
  process.exit(0);
}
if (source.includes('providerDefaultName')) {
  // An older patch shape without the managed-provider gate: start over from the
  // pristine backup so the anchors below still match.
  if (!fs.existsSync(backup)) {
    console.error('the bundle carries an older patch and no backup exists to restore it');
    process.exit(3);
  }
  fs.copyFileSync(backup, target);
  source = fs.readFileSync(target, 'utf8');
  console.log('restored the backup to re-patch with the current shape');
}

const a = count(source, ANCHOR_A);
const b = count(source, ANCHOR_B);
if (a !== 1 || b !== 1) {
  console.error(`anchor mismatch (A=${a}, B=${b}); the shipped bundle changed, review the patch`);
  process.exit(3);
}

if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
source = source.replace(ANCHOR_A, PATCH_A).replace(ANCHOR_B, PATCH_B);
fs.writeFileSync(target, source);
console.log(`patched ${target}`);
console.log('reload the web page to pick it up');
