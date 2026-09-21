import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existingServer } from '../server/startup.js';

test('second start recognizes current and earlier AEZ servers', async () => {
  assert.equal(await existingServer(3100, async () => Response.json({service:'aez-live',status:'ok'})), true);
  assert.equal(await existingServer(3100, async url => Response.json(url.endsWith('/health') ? {status:'ok'} : {googleClientId:'client'})), true);
});
test('unavailable or unrelated service is not considered AEZ', async () => {
  assert.equal(await existingServer(3100, async () => {throw new Error('offline');}), false);
  assert.equal(await existingServer(3100, async () => Response.json({status:'other'})), false);
});
