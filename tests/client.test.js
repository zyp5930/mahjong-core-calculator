const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function client(callFunction) {
  const storage = new Map(); const calls = []; let route = 'pages/join/join';
  const wx = { getStorageSync: (k) => storage.get(k), setStorageSync: (k,v) => storage.set(k,v), removeStorageSync: (k) => storage.delete(k),
    navigateTo: (v) => calls.push(v), reLaunch: (v) => calls.push(v),
    cloud: { callFunction: async (v) => {
      calls.push(v);
      return callFunction ? callFunction(v) : { result: { openid: 'me' } };
    } }
  };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} }; let page;
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
      require: (name) => load(path.resolve(path.dirname(file), name + '.js')), wx, Page: (v) => { page = v; },
      getApp: () => ({ globalData: { envId: 'test' } }), getCurrentPages: () => [{ route, options: { shareCode: 'ABC123' } }],
      setTimeout, clearTimeout, console
    }, { filename: file });
    const result = page || module.exports; cache.set(file, result); return result;
  }
  return { wx, calls, storage, load: (p) => load(path.resolve(p)), setRoute(r) { route = r; } };
}

test('cloud login only after consent; withdrawal invalidates even cached identity', async () => {
  const c = client(), store = c.load('services/store.js'), privacy = c.load('services/privacy.js');
  await assert.rejects(store.ensureMe(), /隐私/);
  assert.equal(c.calls.some((v) => v.name === 'login'), false);
  privacy.accept(); await store.ensureMe();
  assert.equal(c.calls.filter((v) => v.name === 'login').length, 1);
  privacy.revoke(); await assert.rejects(store.ensureMe(), /隐私/);
});

test('consent resumes shared invitation and is not preselected', () => {
  const c = client(), privacy = c.load('services/privacy.js');
  assert.throws(() => privacy.requireConsent());
  const legal = c.load('pages/legal/legal.js');
  assert.equal(legal.data.agreed, false);
  legal.accept(); assert.equal(privacy.hasConsent(), false);
  legal.data.agreed = true; legal.accept();
  assert.equal(c.calls.at(-1).url, '/pages/join/join?shareCode=ABC123');
});

test('all multiplier prompts start empty and have no money example', () => {
  const c = client();
  assert.equal(c.load('pages/home/home.js').data.settlementInputValue, '');
  assert.equal(c.load('pages/room/room.js').data.endInputValue, '');
  for (const name of ['home','room']) {
    for (const ext of ['js','wxml']) assert.equal(/(?:'0\.3'|例如 0\.3)/.test(fs.readFileSync(`pages/${name}/${name}.${ext}`, 'utf8')), false);
  }
});

test('store forwards complete tableOps payloads to the cloud function', async () => {
  const cloudTable = {
    _id: 'table-1',
    name: '周末积分',
    status: 'active',
    revision: 1,
    players: [],
    records: [],
    notifications: []
  };
  const c = client(async ({ name, data }) => {
    if (name === 'login') return { result: { openid: 'me' } };
    assert.equal(name, 'tableOps');
    return { result: { ok: true, data: cloudTable } };
  });
  const privacy = c.load('services/privacy.js');
  const store = c.load('services/store.js');
  privacy.accept();

  await store.createTable({ name: '周末积分', playerNames: ['甲'] });
  await store.getTable('table-1');
  await store.joinTable('table-1', '', '乙', '', 'ABC123');

  const requests = c.calls.filter((item) => item.name === 'tableOps').map((item) => item.data);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { action: 'createTable', name: '周末积分', playerNames: ['甲'] },
    { action: 'getTable', tableId: 'table-1' },
    { action: 'joinTable', tableId: 'table-1', playerId: '', name: '乙', avatarFileId: '', shareCode: 'ABC123' }
  ]);
});
