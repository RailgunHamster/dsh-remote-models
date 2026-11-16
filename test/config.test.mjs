import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../lib/index.js';
test('plugin activates with a dormant source and no authentication', () => {
  const config=Config({});const source=config.source.get();
  assert.equal(source.url,'');assert.ok(source.basicAuth == null);assert.equal(source.intervalSeconds,300);
});
test('credentials are references and refresh intervals are bounded', () => {
  assert.throws(()=>Config({source:{intervalSeconds:0}}));
  assert.throws(()=>Config({source:{bearerTokenRef:'literal secret'}}));
  assert.equal(Config({source:{basicAuth:{username:'account',passwordRef:'DAV_PASSWORD'}}}).source.get().basicAuth.passwordRef,'DAV_PASSWORD');
});
