const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const clone = (x) => structuredClone(x);

function harness() {
  const collections = new Map();
  let openid = 'alice';
  let security = 'pass';
  let fileDeletionStatus = 0;
  const removedFiles = [];
  const map = (name) => { if (!collections.has(name)) collections.set(name, new Map()); return collections.get(name); };
  function collection(name) {
    const records = map(name);
    return {
      doc(id) {
        return {
          async get() { if (!records.has(id)) throw new Error('document does not exist'); return { data: { ...clone(records.get(id)), _id: id } }; },
          async set({ data }) { records.set(id, clone(data)); },
          async update({ data }) { if (!records.has(id)) throw new Error('document does not exist'); records.set(id, { ...records.get(id), ...clone(data) }); },
          async remove() { records.delete(id); }
        };
      },
      where(filter) {
        const query = { skipCount: 0, limitCount: 100, sortKey: '_id', direction: 'asc',
          field() { return this; }, skip(n) { this.skipCount = n; return this; }, limit(n) { this.limitCount = n; return this; },
          orderBy(key, direction) { this.sortKey = key; this.direction = direction; return this; },
          async get() {
            let values = [...records.entries()].map(([id, v]) => ({ ...clone(v), _id: id }));
            values = values.filter((v) => Object.entries(filter).every(([k, expected]) => {
              if (expected && expected.op === 'in') return expected.values.some((x) => Array.isArray(v[k]) ? v[k].includes(x) : v[k] === x);
              if (expected && expected.op === 'gt') return v[k] > expected.value;
              return v[k] === expected;
            }));
            values.sort((a, b) => (a[this.sortKey] < b[this.sortKey] ? -1 : a[this.sortKey] > b[this.sortKey] ? 1 : 0) * (this.direction === 'desc' ? -1 : 1));
            return { data: values.slice(this.skipCount, this.skipCount + this.limitCount) };
          }
        }; return query;
      }
    };
  }
  let serial = Promise.resolve();
  const db = { collection, command: { in: (values) => ({ op: 'in', values }), gt: (value) => ({ op: 'gt', value }) },
    runTransaction(fn) {
      const result = serial.then(async () => {
        const before = clone(collections);
        try { return await fn({ collection }); } catch (err) { collections.clear(); before.forEach((v, k) => collections.set(k, v)); throw err; }
      });
      serial = result.catch(() => {}); return result;
    }
  };
  const cloud = { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => db, getWXContext: () => ({ OPENID: openid }),
    openapi: { security: { async msgSecCheck() { if (security === 'error') throw new Error('offline'); return { errcode: 0, result: { suggest: security } }; } },
      wxacode: { async getUnlimited(args) { cloud.lastCode = args; return { buffer: Buffer.from('png') }; } } },
    async getTempFileURL({ fileList }) {
      return { fileList: fileList.map((fileID) => ({ fileID, tempFileURL: `https://tmp.example/${encodeURIComponent(fileID)}` })) };
    },
    async deleteFile({ fileList }) {
      removedFiles.push(...fileList);
      return { fileList: fileList.map((fileID) => ({ fileID, status: fileDeletionStatus })) };
    }
  };
  function load(file) {
    const module = { exports: {} };
    const context = { module, exports: module.exports, require(name) {
      if (name === 'wx-server-sdk') return cloud;
      if (name.startsWith('./')) return load(path.resolve(path.dirname(file), name + '.js'));
      return require(name);
    }, console: { log() {}, error() {} }, setTimeout, clearTimeout, Buffer, process: { env: {} } };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    return module.exports;
  }
  const api = load(path.resolve('cloudfunctions/tableOps/index.js')).main;
  return {
    api, cloud, db, collections, removedFiles, map, load,
    setUser(v) { openid = v; },
    setSecurity(v) { security = v; },
    setFileDeletionStatus(v) { fileDeletionStatus = v; }
  };
}
async function create(h) {
  const r = await h.api({ action: 'createTable', name: '周末积分', playerNames: ['甲'] });
  assert.equal(r.ok, true, r.message); return r.data;
}

test('invitation preview, membership and tampered inputs', async () => {
  const h = harness(), table = await create(h);
  assert.match(table.shareCode, /^[A-F0-9]{20}$/);
  h.setUser('bob');
  assert.equal((await h.api({ action: 'getTable', tableId: table._id })).ok, false);
  assert.equal((await h.api({ action: 'toggleMuted', tableId: table._id })).ok, false);
  const preview = await h.api({ action: 'getTableByShareCode', shareCode: table.shareCode });
  assert.equal(preview.data.invitePreview, true);
  assert.equal(preview.data.players.length, 0);
  assert.equal(preview.data.ownerOpenid, undefined);
  assert.equal((await h.api({ action: 'joinTable', tableId: table._id, name: '乙' })).ok, false);
  assert.equal((await h.api({ action: 'getTableByShareCode', shareCode: {} })).ok, false);
  assert.equal((await h.api({ action: 'joinTable', tableId: table._id, name: '乙', shareCode: table.shareCode })).ok, true);
  const member = await h.api({ action: 'getTable', tableId: table._id });
  assert.equal(member.ok, true);
  assert.equal(member.data.players[0].openid, 'member');
  assert.equal(member.data.participantOpenids, undefined);
});

test('content checks fail closed and prohibit custom avatars', async () => {
  const h = harness();
  for (const outcome of ['risky', 'review', 'error']) {
    h.setSecurity(outcome);
    assert.equal((await h.api({ action: 'createTable', name: '内容', playerNames: ['甲'] })).ok, false);
  }
  h.setSecurity('pass');
  assert.equal((await h.api({ action: 'createTable', name: '内容', playerNames: ['甲'], ownerAvatarUrl: 'cloud://foreign' })).ok, false);
  assert.equal(h.map('tables').size, 0);
});

test('selected avatar is accepted only from the caller path and returned as a temporary URL', async () => {
  const h = harness();
  const avatar = 'cloud://env/avatars/alice/avatar.jpg';
  const result = await h.api({ action: 'createTable', name: '头像测试', playerNames: ['甲'], ownerAvatarUrl: avatar });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.players[0].avatarFileId, undefined);
  assert.match(result.data.players[0].avatarUrl, /^https:\/\/tmp\.example\//);
});

test('scoring, undo, empty multiplier and group settlement work', async () => {
  const h = harness(), t = await create(h);
  h.setUser('bob'); await h.api({ action: 'joinTable', tableId: t._id, shareCode: t.shareCode, name: '乙' });
  h.setUser('alice');
  const raw = h.map('tables').get(t._id), from = raw.players[0].id, to = raw.players[1].id;
  const score = await h.api({ action: 'giveScore', tableId: t._id, fromPlayerId: from, toPlayerId: to, amount: 10 });
  assert.equal(score.ok, true, score.message);
  assert.equal(score.data.players[0].score, -10);
  assert.equal(score.data.players[1].score, 10);
  const undo = await h.api({ action: 'undoLastGive', tableId: t._id, fromPlayerId: from, toPlayerId: to });
  assert.equal(undo.ok, true, undo.message);
  assert.equal(undo.data.players[0].score, 0);
  assert.equal((await h.api({ action: 'settleTable', tableId: t._id, multiplier: '' })).ok, false);
  const settled = await h.api({ action: 'settleGroup', tableId: t._id, multiplier: 1 });
  assert.equal(settled.ok, true, settled.message);
  assert.equal(settled.data.groupStatus, 'settled');
});

test('rate limit persists across requests', async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) assert.equal((await h.api({ action: 'getTableByShareCode', shareCode: 'ABC123' })).ok, true);
  assert.equal((await h.api({ action: 'getTableByShareCode', shareCode: 'ABC123' })).ok, false);
});

test('resumable deletion clears historical identity and cross-round summaries, preserves other scores', async () => {
  const h = harness(), t = await create(h);
  h.setUser('bob'); await h.api({ action: 'joinTable', tableId: t._id, shareCode: t.shareCode, name: '乙' });
  h.setUser('alice');
  const raw = h.map('tables').get(t._id), p = raw.players[0];
  p.avatarFileId = 'cloud://env.bucket/avatars/alice/old.jpg';
  raw.players[1].score = 10;
  raw.records = [{ fromPlayerId: p.id, fromPlayerName: '甲', toPlayerId: raw.players[1].id, toPlayerName: '乙', operatorOpenid: 'alice', amount: 10 }];
  raw.notifications = [{ targetOpenid: 'bob', fromPlayerId: p.id, content: '甲给分' }];
  h.map('tables').set('z_other_round', { ...clone(raw), ownerOpenid: 'bob', participantOpenids: ['bob'], players: [clone(raw.players[1])], records: [],
    groupSettlement: { finalScores: [{ groupPlayerId: p.groupPlayerId, name: '甲', totalScore: -10 }] } });
  const orphan = 'cloud://env.bucket/avatars/alice/orphan.jpg';
  h.map('legacy_avatar_files').set('legacy1', { ownerOpenid: 'alice', fileID: orphan });
  let r = await h.api({ action: 'deleteMyData' });
  assert.equal(r.ok, true, r.message);
  assert.equal((await h.api({ action: 'getTable', tableId: t._id })).ok, false);
  for (let i = 0; !r.data.done && i < 20; i++) { r = await h.api({ action: 'deleteMyData' }); assert.equal(r.ok, true, r.message); }
  assert.equal(r.data.done, true);
  const clean = h.map('tables').get(t._id);
  assert.equal(clean.ownerOpenid, 'bob');
  assert.equal(clean.players[0].openid, '');
  assert.equal(clean.players[0].name, '已删除成员');
  assert.equal(clean.players[1].score, 10);
  assert.equal(clean.notifications.length, 0);
  assert.equal(clean.records[0].operatorOpenid, '');
  assert.equal(h.map('tables').get('z_other_round').groupSettlement.finalScores[0].name, '已删除成员');
  assert.equal(h.removedFiles.includes(orphan), true);
  assert.equal(h.removedFiles.includes(p.avatarFileId), true);
  assert.equal(h.map('privacy_jobs').size, 0);
  assert.equal(h.map('privacy_locks').size, 0);
  assert.equal((await h.api({ action: 'listTables' })).data.length, 0);
  assert.equal((await h.api({ action: 'getTable', tableId: t._id })).ok, false);
});

test('QR code uses release and denies non-members', async () => {
  const h = harness(), t = await create(h), code = h.load(path.resolve('cloudfunctions/tableCode/index.js')).main;
  h.setUser('bob'); assert.equal((await code({ shareCode: t.shareCode })).ok, false);
  h.setUser('alice'); assert.equal((await code({ shareCode: t.shareCode })).ok, true);
  assert.equal(h.cloud.lastCode.envVersion, 'release');
  assert.equal(h.cloud.lastCode.checkPath, true);
  assert.ok(h.cloud.lastCode.scene.length <= 32);
});

test('ended tables reject new members', async () => {
  const h = harness(), table = await create(h);
  assert.equal((await h.api({ action: 'endTable', tableId: table._id })).ok, true);
  h.setUser('bob');
  const joined = await h.api({ action: 'joinTable', tableId: table._id, shareCode: table.shareCode, name: '乙' });
  assert.equal(joined.ok, false);
  assert.match(joined.message, /结束|失效/);
});

test('concurrent next-round requests create only one table', async () => {
  const h = harness(), table = await create(h);
  assert.equal((await h.api({ action: 'endTable', tableId: table._id })).ok, true);
  const [left, right] = await Promise.all([
    h.api({ action: 'startNextTable', tableId: table._id }),
    h.api({ action: 'startNextTable', tableId: table._id })
  ]);
  assert.equal(left.ok, true, left.message);
  assert.equal(right.ok, true, right.message);
  assert.equal(left.data._id, right.data._id);
  assert.equal(h.map('tables').size, 2);
});

test('failed avatar deletion remains resumable and is not reported complete', async () => {
  const h = harness(), table = await create(h);
  const raw = h.map('tables').get(table._id);
  raw.players[0].avatarFileId = 'cloud://env.bucket/avatars/alice/old.jpg';
  h.setFileDeletionStatus(-1);

  let result;
  for (let batch = 0; batch < 10; batch += 1) {
    result = await h.api({ action: 'deleteMyData' });
    if (!result.ok) break;
  }
  assert.equal(result.ok, false);
  assert.equal(h.map('privacy_jobs').size, 1);

  h.setFileDeletionStatus(0);
  for (let batch = 0; batch < 10; batch += 1) {
    result = await h.api({ action: 'deleteMyData' });
    assert.equal(result.ok, true, result.message);
    if (result.data.done) break;
  }
  assert.equal(result.data.done, true);
  assert.equal(h.map('privacy_jobs').size, 0);
});

module.exports = { harness, create };
