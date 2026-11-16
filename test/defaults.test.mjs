import test from 'node:test';
import assert from 'node:assert/strict';
import { summariseDefaults } from '../lib/synchronizer.js';

const doc = providers => ({ version: 1, providers });

test('a provider default is spelled out with its level', () => {
  const [row] = summariseDefaults(doc({
    'personal-a': {
      reasoning: 'xhigh',
      models: [{ id: 'model-large', reasoningEfforts: { low: 'low', xhigh: 'xhigh' } }],
    },
  }));
  assert.equal(row.provider, 'personal-a');
  assert.equal(row.level, 'xhigh');
  assert.equal(row.label, 'Default (Xhigh)');
  assert.deepEqual(row.unsupported, []);
  assert.equal(row.models[0].supported, true);
});

test('a model that does not declare the provider default is reported', () => {
  const [, row] = summariseDefaults(doc({
    ok: { reasoning: 'high', models: [{ id: 'a', reasoningEfforts: { high: 'high' } }] },
    'personal-b': {
      reasoning: 'high',
      models: [
        { id: 'model-fast', reasoningEfforts: { low: 'low', high: 'high' } },
        { id: 'model-small', reasoningEfforts: { off: null, low: 'low', medium: 'medium' } },
      ],
    },
  }));
  assert.equal(row.label, 'Default (High)');
  assert.deepEqual(row.unsupported, ['model-small']);
});

test('no provider default stays unlabelled so the client falls back to the server wording', () => {
  const [row] = summariseDefaults(doc({ 'personal-a': { models: [{ id: 'm', reasoningEfforts: { low: 'low' } }] } }));
  assert.equal(row.level, null);
  assert.equal(row.label, null);
  assert.deepEqual(row.unsupported, []);
  assert.equal(row.models[0].supported, null);
});

test('a non-reasoning model cannot take a provider default', () => {
  const [row] = summariseDefaults(doc({ p: { reasoning: 'low', models: [{ id: 'plain', reasoningEfforts: false }] } }));
  assert.deepEqual(row.unsupported, ['plain']);
});

test('an empty document yields no rows', () => {
  assert.deepEqual(summariseDefaults({ version: 1, providers: {} }), []);
  assert.deepEqual(summariseDefaults(undefined), []);
});
