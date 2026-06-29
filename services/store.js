const { makeId, makeShareCode } = require('../utils/format');

const STORAGE_KEY = 'mahjong_tables_v1';
const OPENID_KEY = 'mahjong_local_openid_v1';
const MODE_KEY = 'mahjong_store_mode_v1';
const NOTICE_SEEN_KEY = 'mahjong_notice_seen_v1';
const CLOUD_TIMEOUT_MS = 6000;

const avatarColors = ['#6b9fe8', '#45b7a8', '#f16f5d', '#8a7ee8', '#d69a25', '#5f7285'];

let cachedMe = null;
const avatarUrlCache = {};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeNotification(type, targetOpenid, title, content, extra) {
  return {
    id: makeId('notice'),
    type,
    targetOpenid: targetOpenid || '',
    title: String(title || '').trim(),
    content: String(content || '').trim(),
    createdAt: Date.now(),
    ...extra
  };
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

function getSeenNoticeMap() {
  return wx.getStorageSync(NOTICE_SEEN_KEY) || {};
}

function setSeenNoticeMap(map) {
  wx.setStorageSync(NOTICE_SEEN_KEY, map);
}

function isNoticeSeen(tableId, noticeId) {
  const openid = cachedMe && cachedMe.openid ? cachedMe.openid : getLocalOpenid();
  const seenMap = getSeenNoticeMap();
  const key = `${tableId}:${openid}`;
  const seenIds = seenMap[key] || [];
  return seenIds.includes(noticeId);
}

function markNoticeSeen(tableId, noticeId) {
  const openid = cachedMe && cachedMe.openid ? cachedMe.openid : getLocalOpenid();
  const seenMap = getSeenNoticeMap();
  const key = `${tableId}:${openid}`;
  const seenIds = seenMap[key] || [];
  if (!seenIds.includes(noticeId)) {
    seenIds.push(noticeId);
    seenMap[key] = seenIds.slice(-50);
    setSeenNoticeMap(seenMap);
  }
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
    avatarFileId: '',
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

function safeLog(label, value) {
  try {
    console.log(label, value);
  } catch (error) {
    console.log(label, String(value));
  }
}

function isCloudAvatarUrl(avatarUrl) {
  return /^cloud:\/\//.test(String(avatarUrl || ''));
}

function isTempAvatarUrl(avatarUrl) {
  const value = String(avatarUrl || '');
  return /^wxfile:\/\//.test(value) || /^http:\/\/tmp\//.test(value) || /^https?:\/\/tmp\//.test(value);
}

function isRemoteAvatarUrl(avatarUrl) {
  return /^https?:\/\//.test(String(avatarUrl || '')) && !isTempAvatarUrl(avatarUrl);
}

function getAvatarExtension(avatarUrl) {
  const matched = String(avatarUrl || '').match(/\.([a-zA-Z0-9]+)(?:\?|#|$)/);
  return matched ? matched[1].toLowerCase() : 'jpg';
}

async function uploadCloudAvatar(avatarUrl) {
  if (!avatarUrl || isCloudAvatarUrl(avatarUrl)) return avatarUrl || '';
  if (isRemoteAvatarUrl(avatarUrl)) return '';
  if (!wx.cloud || !wx.cloud.uploadFile) return avatarUrl;
  const me = await ensureMe();
  if (me.mode !== 'cloud') return avatarUrl;
  const extension = getAvatarExtension(avatarUrl);
  const cloudPath = `avatars/${me.openid}/${Date.now()}.${extension}`;
  const { fileID } = await wx.cloud.uploadFile({
    cloudPath,
    filePath: avatarUrl
  });
  return fileID || avatarUrl;
}

async function resolveCloudAvatarUrl(avatarFileId, fallbackUrl) {
  if (!isCloudAvatarUrl(avatarFileId) || !wx.cloud || !wx.cloud.getTempFileURL) {
    return fallbackUrl || avatarFileId || '';
  }
  if (avatarUrlCache[avatarFileId]) return avatarUrlCache[avatarFileId];
  try {
    const result = await wx.cloud.getTempFileURL({
      fileList: [avatarFileId]
    });
    const file = result.fileList && result.fileList[0];
    if (file && file.tempFileURL) {
      avatarUrlCache[avatarFileId] = file.tempFileURL;
      return file.tempFileURL;
    }
  } catch (error) {
    console.error('[avatar getTempFileURL error]', error);
  }
  return fallbackUrl || avatarFileId;
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
  const payload = {
    action,
    ...data
  };
  safeLog('[tableOps request]', payload);
  let result = null;
  try {
    const response = await withTimeout(
      wx.cloud.callFunction({
        name: 'tableOps',
        data: payload
      }),
      '云端操作超时'
    );
    safeLog('[tableOps response]', response);
    result = response.result;
  } catch (error) {
    console.error('[tableOps callFunction error]', {
      action,
      payload,
      error,
      message: error && error.message,
      errCode: error && error.errCode,
      errMsg: error && error.errMsg
    });
    throw error;
  }
  if (!result || !result.ok) {
    console.error('[tableOps business error]', {
      action,
      payload,
      result
    });
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

async function normalizeCloudTable(table) {
  if (!table) return null;
  const id = table._id || table.id;
  const players = await Promise.all((table.players || []).map(async (player, index) => {
    const avatarFileId = player.avatarFileId || (isCloudAvatarUrl(player.avatarUrl) ? player.avatarUrl : '');
    const fallbackUrl = isCloudAvatarUrl(player.avatarUrl) ? '' : (player.avatarUrl || '');
    return {
      ...player,
      id: player.id || player._id || `${id}_player_${index}`,
      avatarUrl: fallbackUrl || await resolveCloudAvatarUrl(avatarFileId, ''),
      avatarFileId,
      avatarColor: player.avatarColor || avatarColors[index % avatarColors.length]
    };
  }));
  return {
    ...table,
    id,
    players,
    records: (table.records || []).map((record, index) => ({
      ...record,
      id: record.id || `${id}_record_${index}`
    })),
    notifications: (table.notifications || []).map((item, index) => ({
      ...item,
      id: item.id || `${id}_notice_${index}`
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
  const players = playerNames.map((name, index) => normalizePlayer(name, index, index === 0));
  if (players[0] && payload.ownerAvatarUrl) {
    players[0].avatarUrl = payload.ownerAvatarUrl;
    players[0].avatarFileId = payload.ownerAvatarUrl;
  }
  const table = {
    id: makeId('table'),
    name: payload.name || '麻将计分桌',
    shareCode: makeShareCode(),
    ownerOpenid: getLocalOpenid(),
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    endedAt: null,
    muted: false,
    players,
    records: [],
    notifications: []
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
  player.avatarFileId = avatarUrl || player.avatarFileId || '';
  player.joinedAt = Date.now();
  table.updatedAt = Date.now();
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
    player.avatarFileId = payload.avatarUrl || '';
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
  table.updatedAt = Date.now();
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
  table.updatedAt = Date.now();
  if (toPlayer.openid) {
    table.notifications = table.notifications || [];
    table.notifications.unshift(makeNotification(
      'undo',
      toPlayer.openid,
      '计分已撤销',
      `${fromPlayer.name} 撤销了给你的 ${record.amount} 分`,
      {
        tableId,
        fromPlayerId,
        toPlayerId,
        amount: record.amount,
        recordId: record.id
      }
    ));
  }
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
    let localResult = null;
    try {
      localResult = await localTask();
    } catch (localError) {
      throw error;
    }
    if (!localResult) throw error;
    setStoredMode('local');
    return localResult;
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
      return Promise.all(tables.map(normalizeCloudTable));
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
    async () => {
      const savedPayload = { ...payload };
      if (savedPayload.ownerAvatarUrl) {
        savedPayload.ownerAvatarUrl = await uploadCloudAvatar(savedPayload.ownerAvatarUrl);
      }
      return normalizeCloudTable(await callTableOp('createTable', savedPayload));
    }
  );
}

async function joinTable(tableId, playerId, name, avatarUrl) {
  return withCloudFallback(
    async () => {
      const savedAvatarUrl = await uploadCloudAvatar(avatarUrl);
      return callTableOp('joinTable', { tableId, playerId, name, avatarFileId: savedAvatarUrl });
    },
    () => joinTableLocal(tableId, playerId, name, avatarUrl)
  );
}

async function updateMyProfile(tableId, payload) {
  return withCloudFallback(
    async () => {
      const savedPayload = { ...payload };
      if (savedPayload.avatarUrl !== undefined) {
        savedPayload.avatarFileId = await uploadCloudAvatar(savedPayload.avatarUrl);
        delete savedPayload.avatarUrl;
      }
      return callTableOp('updateMyProfile', { tableId, ...savedPayload });
    },
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
