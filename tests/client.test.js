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

test('single round win trend gives exactly one winner per round', () => {
  const c = client();
  const page = c.load('pages/group-detail/group-detail.js');
  const now = 1_000_000;
  const players = [
    { id: 'p1', name: '甲' },
    { id: 'p2', name: '乙' },
    { id: 'p3', name: '丙' },
    { id: 'p4', name: '丁' }
  ];
  const table = {
    id: 't1',
    players,
    records: [
      { fromPlayerId: 'p2', toPlayerId: 'p1', amount: 5, type: 'score', createdAt: now },
      { fromPlayerId: 'p3', toPlayerId: 'p1', amount: 5, type: 'score', createdAt: now },
      { fromPlayerId: 'p4', toPlayerId: 'p1', amount: 5, type: 'score', createdAt: now },
      { fromPlayerId: 'p4', toPlayerId: 'p1', amount: 5, type: 'score', createdAt: now, revoked: true },
      { fromPlayerId: 'p1', toPlayerId: 'p2', amount: 3, type: 'score', createdAt: now + 60_000 },
      { fromPlayerId: 'p1', toPlayerId: 'p2', amount: 3, type: 'score', createdAt: now + 60_000 },
      { fromPlayerId: 'p3', toPlayerId: 'p2', amount: 3, type: 'score', createdAt: now + 60_000 },
      { fromPlayerId: 'p1', toPlayerId: 'p3', amount: 3, type: 'score', createdAt: now + 120_000 },
      { fromPlayerId: 'p2', toPlayerId: 'p3', amount: 3, type: 'score', createdAt: now + 120_000 },
      { fromPlayerId: 'p4', toPlayerId: 'p3', amount: 3, type: 'score', createdAt: now + 120_000 }
    ]
  };
  const result = page.buildRoundWinTrend(table);
  const series = JSON.parse(JSON.stringify(result.roundWinSeries.reduce((map, item) => {
    map[item.name] = item.values;
    return map;
  }, {})));
  const labels = Array.from(result.roundWinLabels);
  assert.deepEqual(labels, ['开始', '第1轮', '第2轮', '第3轮']);
  assert.deepEqual(series, {
    甲: [0, 1, 1, 1],
    乙: [0, 0, 1, 1],
    丙: [0, 0, 0, 1],
    丁: [0, 0, 0, 0]
  });
  const totalWins = result.roundWinSeries.reduce((sum, item) => sum + item.values[item.values.length - 1], 0);
  assert.equal(totalWins, labels.length - 1);
});

test('group win trend accumulates each round winner across tables', () => {
  const c = client();
  const page = c.load('pages/group-detail/group-detail.js');
  const players = (prefix) => [
    { id: `${prefix}1`, groupPlayerId: 'g1', name: '甲' },
    { id: `${prefix}2`, groupPlayerId: 'g2', name: '乙' },
    { id: `${prefix}3`, groupPlayerId: 'g3', name: '丙' },
    { id: `${prefix}4`, groupPlayerId: 'g4', name: '丁' }
  ];
  const tables = [
    {
      id: 't1',
      roundNo: 1,
      players: players('a'),
      records: [
        { fromPlayerId: 'a2', toPlayerId: 'a1', amount: 5, type: 'score', createdAt: 1000 },
        { fromPlayerId: 'a3', toPlayerId: 'a1', amount: 5, type: 'score', createdAt: 1000 }
      ]
    },
    {
      id: 't2',
      roundNo: 2,
      players: players('b'),
      records: [
        { fromPlayerId: 'b1', toPlayerId: 'b2', amount: 5, type: 'score', createdAt: 2000 }
      ]
    }
  ];
  const result = page.buildGroupWinTrend(tables);
  const series = JSON.parse(JSON.stringify(result.groupWinSeries.reduce((map, item) => {
    map[item.name] = item.values;
    return map;
  }, {})));
  assert.deepEqual(Array.from(result.groupWinLabels), ['第1局', '第2局']);
  assert.deepEqual(series, {
    甲: [1, 1],
    乙: [0, 1],
    丙: [0, 0],
    丁: [0, 0]
  });
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
