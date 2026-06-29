const { makeId, makeShareCode } = require('../utils/format');

const STORAGE_KEY = 'mahjong_tables_v1';
const OPENID_KEY = 'mahjong_local_openid_v1';
const MODE_KEY = 'mahjong_store_mode_v1';
const CLOUD_TIMEOUT_MS = 6000;

const avatarColors = ['#6b9fe8', '#45b7a8', '#f16f5d', '#8a7ee8', '#d69a25', '#5f7285'];

let cachedMe = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getLocalOpenid() {
  let openid = wx.getStorageSync(OPENID_KEY);
  if (!openid) {
    openid = makeId('local_openid');
    wx.setStorageSync(OPENID_KEY, openid);
  }
  return openid;
}

function readTables() {
  return wx.getStorageSync(STORAGE_KEY) || [];
}

function writeTables(tables) {
  wx.setStorageSync(STORAGE_KEY, tables);
}

function getTableIndex(tables, tableId) {
  return tables.findIndex((item) => item.id === tableId);
}

function normalizePlayer(name, index, isOwner) {
  const trimmed = String(name || '').trim() || `玩家${index + 1}`;
  return {
    id: makeId('player'),
    openid: isOwner ? getLocalOpenid() : '',
    name: trimmed,
    avatarUrl: '',
    score: 0,
    isOwner: !!isOwner,
    avatarColor: avatarColors[index % avatarColors.length],
    joinedAt: Date.now()
  };
}

function sortPlayers(players) {
  return players.slice().sort((left, right) => right.score - left.score);
}

function findMyPlayer(table) {
  const openid = cachedMe && cachedMe.openid ? cachedMe.openid : getLocalOpenid();
  return table.players.find((player) => player.openid === openid) || null;
}

function getStoredMode() {
  return wx.getStorageSync(MODE_KEY) || 'unknown';
}

function setStoredMode(mode) {
  wx.setStorageSync(MODE_KEY, mode);
}

function hasCloudReady() {
  const app = typeof getApp === 'function' ? getApp() : null;
  return !!(wx.cloud && app && app.globalData && app.globalData.envId);
}

function withTimeout(task, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, CLOUD_TIMEOUT_MS);

    task.then((result) => {
      clearTimeout(timer);
      resolve(result);
    }).catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function ensureMe() {
  if (cachedMe && (cachedMe.mode === 'cloud' || !hasCloudReady())) return cachedMe;
  if (!hasCloudReady()) {
    cachedMe = {
      openid: getLocalOpenid(),
      mode: 'local'
    };
    return cachedMe;
  }
  try {
    const { result } = await withTimeout(
      wx.cloud.callFunction({ name: 'login' }),
      '云登录超时'
    );
    cachedMe = {
      openid: result.openid,
      mode: 'cloud'
    };
    setStoredMode('cloud');
    return cachedMe;
  } catch (error) {
    cachedMe = {
      openid: getLocalOpenid(),
      mode: 'local'
    };
    setStoredMode('local');
    return cachedMe;
  }
}

async function callTableOp(action, data) {
  const { result } = await withTimeout(
    wx.cloud.callFunction({
      name: 'tableOps',
      data: {
        action,
        ...data
      }
    }),
    '云端操作超时'
  );
  if (!result || !result.ok) {
    throw new Error((result && result.message) || '云端操作失败');
  }
  return result.data;
}

async function getTableCode(shareCode) {
  const { result } = await withTimeout(
    wx.cloud.callFunction({
      name: 'tableCode',
      data: { shareCode }
    }),
    '二维码生成超时'
  );
  if (!result || result.ok === false) {
    throw new Error((result && result.message) || '二维码生成失败');
  }
  if (!result.buffer) {
    throw new Error('二维码生成失败');
  }
  return `data:image/png;base64,${result.buffer}`;
}

function normalizeCloudTable(table) {
  if (!table) return null;
  const id = table._id || table.id;
  return {
    ...table,
    id,
    players: (table.players || []).map((player, index) => ({
      ...player,
      id: player.id || player._id || `${id}_player_${index}`,
      avatarColor: player.avatarColor || avatarColors[index % avatarColors.length]
    })),
    records: (table.records || []).map((record, index) => ({
      ...record,
      id: record.id || `${id}_record_${index}`
    }))
  };
}

async function listTablesLocal() {
  return clone(readTables()).sort((left, right) => right.createdAt - left.createdAt);
}

async function getTableLocal(tableId) {
  const table = readTables().find((item) => item.id === tableId);
  return table ? clone(table) : null;
}

async function getTableByShareCodeLocal(shareCode) {
  const table = readTables().find((item) => item.shareCode === shareCode);
  return table ? clone(table) : null;
}

async function createTableLocal(payload) {
  const names = payload.playerNames.filter((item) => String(item || '').trim());
  const playerNames = names.length ? names : ['我', '玩家2', '玩家3', '玩家4'];
  const table = {
    id: makeId('table'),
    name: payload.name || '麻将计分桌',
    shareCode: makeShareCode(),
    ownerOpenid: getLocalOpenid(),
    status: 'active',
    createdAt: Date.now(),
    endedAt: null,
    muted: false,
    players: playerNames.map((name, index) => normalizePlayer(name, index, index === 0)),
    records: []
  };
  const tables = readTables();
  tables.unshift(table);
  writeTables(tables);
  return clone(table);
}

async function joinTableLocal(tableId, playerId, name, avatarUrl) {
  const tables = readTables();
  const index = getTableIndex(tables, tableId);
  if (index < 0) throw new Error('牌局不存在');
  const table = tables[index];
  const openid = getLocalOpenid();
  const existing = table.players.find((player) => player.openid === openid);
  if (existing) return clone(existing);

  let player = table.players.find((item) => item.id === playerId);
  if (!player && playerId) throw new Error('玩家不存在');
  if (player && player.openid) throw new Error('该玩家已被绑定');
  if (!player) {
    player = normalizePlayer(name, table.players.length, false);
    table.players.push(player);
  }
  player.openid = openid;
  player.name = String(name || player.name).trim() || player.name;
  player.avatarUrl = avatarUrl || player.avatarUrl || '';
  player.joinedAt = Date.now();
  writeTables(tables);
  return clone(player);
}

async function updateMyProfileLocal(tableId, payload) {
  const tables = readTables();
  const index = getTableIndex(tables, tableId);
  if (index < 0) throw new Error('牌局不存在');
  const table = tables[index];
  const player = table.players.find((item) => item.openid === getLocalOpenid());
  if (!player) throw new Error('请先加入牌局');

  const name = String((payload && payload.name) || '').trim();
  if (!name) throw new Error('请输入昵称');
  player.name = name;
  if (payload && payload.avatarUrl !== undefined) {
    player.avatarUrl = payload.avatarUrl || '';
  }
  writeTables(tables);
  return clone(player);
}

async function giveScoreLocal(tableId, fromPlayerId, toPlayerId, amount) {
  const value = Number(amount);
  if (!Number.isInteger(value) || value <= 0) throw new Error('请输入有效分数');
  if (fromPlayerId === toPlayerId) throw new Error('不能给自己计分');

  const tables = readTables();
  const index = getTableIndex(tables, tableId);
  if (index < 0) throw new Error('牌局不存在');
  const table = tables[index];
  if (table.status !== 'active') throw new Error('牌局已结束');

  const fromPlayer = table.players.find((player) => player.id === fromPlayerId);
  const toPlayer = table.players.find((player) => player.id === toPlayerId);
  if (!fromPlayer || !toPlayer) throw new Error('玩家不存在');

  fromPlayer.score -= value;
  toPlayer.score += value;
  table.records.unshift({
    id: makeId('record'),
    fromPlayerId,
    fromPlayerName: fromPlayer.name,
    toPlayerId,
    toPlayerName: toPlayer.name,
    amount: value,
    operatorOpenid: getLocalOpenid(),
    createdAt: Date.now(),
    revoked: false
  });
  writeTables(tables);
  return clone(table);
}

async function undoLastGiveLocal(tableId, fromPlayerId, toPlayerId) {
  const tables = readTables();
  const index = getTableIndex(tables, tableId);
  if (index < 0) throw new Error('牌局不存在');
  const table = tables[index];
  if (table.status !== 'active') throw new Error('牌局已结束');

  const fromPlayer = table.players.find((player) => player.id === fromPlayerId);
  const toPlayer = table.players.find((player) => player.id === toPlayerId);
  if (!fromPlayer || !toPlayer) throw new Error('玩家不存在');

  const openid = getLocalOpenid();
  const record = table.records.find((item) => (
    !item.revoked &&
    item.operatorOpenid === openid &&
    item.fromPlayerId === fromPlayerId &&
    item.toPlayerId === toPlayerId
  ));
  if (!record) throw new Error('没有可撤销的上次给分');

  fromPlayer.score += record.amount;
  toPlayer.score -= record.amount;
  record.revoked = true;
  record.revokedAt = Date.now();
  writeTables(tables);
  return clone(table);
}

async function toggleMutedLocal(tableId) {
  const tables = readTables();
  const index = getTableIndex(tables, tableId);
  if (index < 0) throw new Error('牌局不存在');
  tables[index].muted = !tables[index].muted;
  writeTables(tables);
  return clone(tables[index]);
}

async function endTableLocal(tableId) {
  const tables = readTables();
  const index = getTableIndex(tables, tableId);
  if (index < 0) throw new Error('牌局不存在');
  tables[index].status = 'ended';
  tables[index].endedAt = Date.now();
  writeTables(tables);
  return clone(tables[index]);
}

async function deleteTableLocal(tableId) {
  writeTables(readTables().filter((table) => table.id !== tableId));
}

async function withCloudFallback(cloudTask, localTask) {
  const me = await ensureMe();
  if (me.mode !== 'cloud') return localTask();
  try {
    const result = await cloudTask();
    setStoredMode('cloud');
    return result;
  } catch (error) {
    setStoredMode('local');
    return localTask();
  }
}

async function withCloudOnly(cloudTask) {
  const me = await ensureMe();
  if (me.mode !== 'cloud') {
    throw new Error('云开发连接失败，请检查云环境或重新编译');
  }
  const result = await cloudTask();
  setStoredMode('cloud');
  return result;
}

async function listTables() {
  return withCloudFallback(
    async () => {
      const tables = await callTableOp('listTables', {});
      return tables.map(normalizeCloudTable);
    },
    listTablesLocal
  );
}

async function getTable(tableId) {
  return withCloudFallback(
    async () => normalizeCloudTable(await callTableOp('getTable', { tableId })),
    () => getTableLocal(tableId)
  );
}

async function getTableByShareCode(shareCode) {
  return withCloudFallback(
    async () => normalizeCloudTable(await callTableOp('getTableByShareCode', { shareCode })),
    () => getTableByShareCodeLocal(shareCode)
  );
}

async function createTable(payload) {
  return withCloudOnly(
    async () => normalizeCloudTable(await callTableOp('createTable', payload))
  );
}

async function joinTable(tableId, playerId, name, avatarUrl) {
  return withCloudFallback(
    () => callTableOp('joinTable', { tableId, playerId, name, avatarUrl }),
    () => joinTableLocal(tableId, playerId, name, avatarUrl)
  );
}

async function updateMyProfile(tableId, payload) {
  return withCloudFallback(
    () => callTableOp('updateMyProfile', { tableId, ...payload }),
    () => updateMyProfileLocal(tableId, payload)
  );
}

async function giveScore(tableId, fromPlayerId, toPlayerId, amount) {
  return withCloudFallback(
    async () => normalizeCloudTable(await callTableOp('giveScore', { tableId, fromPlayerId, toPlayerId, amount })),
    () => giveScoreLocal(tableId, fromPlayerId, toPlayerId, amount)
  );
}

async function undoLastGive(tableId, fromPlayerId, toPlayerId) {
  return withCloudFallback(
    async () => normalizeCloudTable(await callTableOp('undoLastGive', { tableId, fromPlayerId, toPlayerId })),
    () => undoLastGiveLocal(tableId, fromPlayerId, toPlayerId)
  );
}

async function toggleMuted(tableId) {
  return withCloudFallback(
    async () => normalizeCloudTable(await callTableOp('toggleMuted', { tableId })),
    () => toggleMutedLocal(tableId)
  );
}

async function endTable(tableId) {
  return withCloudFallback(
    async () => normalizeCloudTable(await callTableOp('endTable', { tableId })),
    () => endTableLocal(tableId)
  );
}

async function deleteTable(tableId) {
  return withCloudFallback(
    () => callTableOp('deleteTable', { tableId }),
    () => deleteTableLocal(tableId)
  );
}

module.exports = {
  listTables,
  getTable,
  getTableByShareCode,
  createTable,
  joinTable,
  updateMyProfile,
  giveScore,
  undoLastGive,
  toggleMuted,
  endTable,
  deleteTable,
  findMyPlayer,
  sortPlayers,
  getLocalOpenid,
  ensureMe,
  getStoredMode,
  getTableCode
};
