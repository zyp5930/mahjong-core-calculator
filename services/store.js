const { makeId, makeShareCode, normalizeScore } = require('../utils/format');

const STORAGE_KEY = 'mahjong_tables_v1';
const OPENID_KEY = 'mahjong_local_openid_v1';
const MODE_KEY = 'mahjong_store_mode_v1';
const NOTICE_SEEN_KEY = 'mahjong_notice_seen_v1';
const CLOUD_TIMEOUT_MS = 6000;
const AVATAR_URL_CACHE_TTL = 30 * 60 * 1000;

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

function normalizeFinalScores(finalScores) {
  return (finalScores || []).map((item) => ({
    ...item,
    rawScore: normalizeScore(item.rawScore),
    finalScore: normalizeScore(item.finalScore)
  }));
}

function normalizeGroupFinalScores(finalScores) {
  return (finalScores || []).map((item) => ({
    ...item,
    totalScore: normalizeScore(item.totalScore),
    roundScores: (item.roundScores || []).map((round) => ({
      ...round,
      score: normalizeScore(round.score)
    }))
  }));
}

function normalizeSettlement(settlement) {
  if (!settlement) return null;
  return {
    ...settlement,
    multiplier: normalizeScore(settlement.multiplier),
    finalScores: normalizeFinalScores(settlement.finalScores)
  };
}

function normalizeGroupSettlement(settlement) {
  if (!settlement) return null;
  return {
    ...settlement,
    finalScores: normalizeGroupFinalScores(settlement.finalScores)
  };
}

function getSettlementStatus(table) {
  if (table.settlementStatus) return table.settlementStatus;
  if (table.settlement) return 'settled';
  return table.status === 'ended' ? 'pending' : 'active';
}

function normalizeTableScores(table) {
  if (!table) return null;
  const id = table.id || table._id || '';
  return {
    ...table,
    id,
    groupId: table.groupId || id,
    roundNo: Number(table.roundNo) || 1,
    previousTableId: table.previousTableId || '',
    nextTableId: table.nextTableId || '',
    groupStatus: table.groupStatus || (table.groupSettlement ? 'settled' : 'active'),
    groupSettlement: normalizeGroupSettlement(table.groupSettlement),
    settlementStatus: getSettlementStatus(table),
    players: (table.players || []).map((player) => ({
      ...player,
      groupPlayerId: player.groupPlayerId || player.id,
      score: normalizeScore(player.score)
    })),
    settlement: normalizeSettlement(table.settlement),
    records: (table.records || []).map((record) => ({
      ...record,
      multiplier: record.multiplier ? normalizeScore(record.multiplier) : record.multiplier,
      finalScores: normalizeFinalScores(record.finalScores)
    }))
  };
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
  if (!isCloudAvatarUrl(avatarFileId)) {
    return fallbackUrl || avatarFileId || '';
  }
  if (!wx.cloud || !wx.cloud.getTempFileURL) return fallbackUrl || '';
  const cached = avatarUrlCache[avatarFileId];
  if (cached && Date.now() - cached.createdAt < AVATAR_URL_CACHE_TTL) return cached.url;
  try {
    const result = await wx.cloud.getTempFileURL({
      fileList: [avatarFileId]
    });
    const file = result.fileList && result.fileList[0];
    if (file && file.tempFileURL) {
      avatarUrlCache[avatarFileId] = {
        url: file.tempFileURL,
        createdAt: Date.now()
      };
      return file.tempFileURL;
    }
  } catch (error) {
    console.error('[avatar getTempFileURL error]', error);
  }
  return fallbackUrl || '';
}

function clearAvatarUrlCache(avatarFileId) {
  if (avatarFileId) {
    delete avatarUrlCache[avatarFileId];
    return;
  }
  Object.keys(avatarUrlCache).forEach((key) => {
    delete avatarUrlCache[key];
  });
}

async function ensureMe() {
  if (cachedMe) return cachedMe;
  if (!hasCloudReady()) {
    throw new Error('云环境未初始化，请检查 app.js 中的 envId');
  }
  try {
    const { result } = await withTimeout(
      wx.cloud.callFunction({ name: 'login' }),
      '云登录超时'
    );
    if (!result || !result.openid) {
      throw new Error('云登录未返回用户身份');
    }
    cachedMe = {
      openid: result.openid,
      mode: 'cloud'
    };
    setStoredMode('cloud');
    return cachedMe;
  } catch (error) {
    setStoredMode('error');
    throw new Error((error && error.message) || '云登录失败，请检查云函数 login 是否已部署');
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
    if (
      error &&
      (error.errCode === -501000 ||
        String(error.message || error.errMsg || '').includes('response size exceeded'))
    ) {
      throw new Error('云端返回数据过大，请重新部署最新云函数后重试');
    }
    throw error;
  }
  if (!result || !result.ok) {
    console.error('[tableOps business error]', {
      action,
      payload,
      result
    });
    const message = (result && result.message) || '云端操作失败';
    if (message === '未知操作') {
      throw new Error('云函数 tableOps 未更新，请重新上传部署云函数');
    }
    throw new Error(message);
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

async function normalizeTable(table) {
  if (!table) return null;
  const id = table._id || table.id;
  const players = await Promise.all((table.players || []).map(async (player, index) => {
    const avatarFileId = player.avatarFileId || (isCloudAvatarUrl(player.avatarUrl) ? player.avatarUrl : '');
    const fallbackUrl = isCloudAvatarUrl(player.avatarUrl) ? '' : (player.avatarUrl || '');
    return {
      ...player,
      id: player.id || player._id || `${id}_player_${index}`,
      score: normalizeScore(player.score),
      avatarUrl: fallbackUrl || await resolveCloudAvatarUrl(avatarFileId, ''),
      avatarFileId,
      avatarColor: player.avatarColor || avatarColors[index % avatarColors.length]
    };
  }));
  return normalizeTableScores({
    ...table,
    id,
    players,
    settlement: table.settlement || null,
    records: (table.records || []).map((record, index) => ({
      ...record,
      id: record.id || `${id}_record_${index}`
    })),
    notifications: (table.notifications || []).map((item, index) => ({
      ...item,
      id: item.id || `${id}_notice_${index}`
    }))
  });
}

async function listTablesLocal() {
  return clone(readTables())
    .map((table) => normalizeTableScores(table))
    .sort((left, right) => right.createdAt - left.createdAt);
}

async function getTableLocal(tableId) {
  const table = readTables().find((item) => item.id === tableId);
  return table ? normalizeTableScores(clone(table)) : null;
}

async function getTableByShareCodeLocal(shareCode) {
  const table = readTables().find((item) => item.shareCode === shareCode);
  return table ? normalizeTableScores(clone(table)) : null;
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
    groupId: makeId('group'),
    roundNo: 1,
    previousTableId: '',
    nextTableId: '',
    groupStatus: 'active',
    groupSettlement: null,
    settlementStatus: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    endedAt: null,
    muted: false,
    players,
    records: [],
    notifications: [],
    settlement: null
  };
  table.players = table.players.map((player) => ({
    ...player,
    groupPlayerId: player.groupPlayerId || player.id
  }));
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
  player.groupPlayerId = player.groupPlayerId || player.id;
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
  if (toPlayer.openid) {
    table.notifications = table.notifications || [];
    table.notifications.unshift(makeNotification(
      'score',
      toPlayer.openid,
      '收到给分',
      `收到 ${fromPlayer.name} 的 ${value} 分`,
      {
        tableId,
        fromPlayerId,
        toPlayerId,
        amount: value,
        fromPlayerName: fromPlayer.name,
        toPlayerName: toPlayer.name
      }
    ));
  }
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

function buildSettlement(table, multiplier) {
  const settledAt = Date.now();
  const settledMultiplier = normalizeScore(multiplier);
  return {
    multiplier: settledMultiplier,
    settledAt,
    finalScores: (table.players || []).map((player) => {
      const rawScore = normalizeScore(player.score);
      const finalScore = normalizeScore(rawScore * settledMultiplier);
      return {
        playerId: player.id,
        groupPlayerId: player.groupPlayerId || player.id,
        name: player.name,
        rawScore,
        finalScore
      };
    })
  };
}

function applySettlement(table, multiplier) {
  const settlement = buildSettlement(table, multiplier);
  table.settlementStatus = 'settled';
  table.players = (table.players || []).map((player) => {
    const finalScore = settlement.finalScores.find((item) => item.playerId === player.id);
    return {
      ...player,
      score: finalScore ? finalScore.finalScore : Number(player.score) || 0
    };
  });
  table.records = table.records || [];
  table.records.unshift({
    id: makeId('record'),
    type: 'settlement',
    multiplier: settlement.multiplier,
    finalScores: settlement.finalScores,
    createdAt: settlement.settledAt,
    revoked: false
  });
  table.settlement = settlement;
}

function markTableEnded(table) {
  normalizeGroupPlayers(table);
  table.status = 'ended';
  table.settlementStatus = 'pending';
  table.endedAt = table.endedAt || Date.now();
  table.updatedAt = Date.now();
}

function settleTableWithMultiplier(table, multiplier) {
  const value = Number(multiplier);
  if (!Number.isFinite(value) || value <= 0) throw new Error('请输入有效倍率');
  if (table.settlement) return false;
  if (table.status === 'active') {
    markTableEnded(table);
  }
  if (table.status !== 'ended') throw new Error('请先结束本次对局');
  normalizeGroupPlayers(table);
  applySettlement(table, value);
  table.updatedAt = Date.now();
  return true;
}

function getGroupId(table) {
  return table.groupId || table.id;
}

function getGroupTables(tables, table) {
  const groupId = getGroupId(table);
  return tables
    .filter((item) => (item.groupId || item.id) === groupId)
    .sort((left, right) => (Number(left.roundNo) || 1) - (Number(right.roundNo) || 1) || left.createdAt - right.createdAt);
}

function normalizeGroupPlayers(table) {
  table.players = (table.players || []).map((player) => ({
    ...player,
    groupPlayerId: player.groupPlayerId || player.id
  }));
}

function buildNextTable(table) {
  const now = Date.now();
  const players = (table.players || []).map((player, index) => ({
    ...player,
    id: makeId('player'),
    groupPlayerId: player.groupPlayerId || player.id,
    score: 0,
    isOwner: player.openid === table.ownerOpenid || !!player.isOwner,
    avatarColor: player.avatarColor || avatarColors[index % avatarColors.length],
    joinedAt: player.joinedAt || now
  }));
  return {
    id: makeId('table'),
    name: table.name,
    shareCode: makeShareCode(),
    ownerOpenid: table.ownerOpenid,
    status: 'active',
    groupId: getGroupId(table),
    roundNo: (Number(table.roundNo) || 1) + 1,
    previousTableId: table.id,
    nextTableId: '',
    groupStatus: 'active',
    groupSettlement: null,
    settlementStatus: 'active',
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    muted: !!table.muted,
    participantOpenids: Array.from(new Set([
      ...(table.participantOpenids || []),
      ...players.map((player) => player.openid).filter(Boolean)
    ])),
    players,
    records: [],
    notifications: [],
    settlement: null
  };
}

function buildGroupSettlement(tables) {
  const endedTables = tables.filter((table) => table.status === 'ended' && table.settlement);
  const scoreMap = {};
  endedTables.forEach((table) => {
    const playerMap = (table.players || []).reduce((map, player) => {
      map[player.id] = player;
      return map;
    }, {});
    (table.settlement.finalScores || []).forEach((score) => {
      const player = playerMap[score.playerId] || {};
      const groupPlayerId = score.groupPlayerId || player.groupPlayerId || player.openid || score.playerId;
      if (!scoreMap[groupPlayerId]) {
        scoreMap[groupPlayerId] = {
          groupPlayerId,
          name: score.name || player.name || '玩家',
          totalScore: 0,
          roundScores: []
        };
      }
      const finalScore = normalizeScore(score.finalScore);
      scoreMap[groupPlayerId].name = score.name || player.name || scoreMap[groupPlayerId].name;
      scoreMap[groupPlayerId].totalScore = normalizeScore(scoreMap[groupPlayerId].totalScore + finalScore);
      scoreMap[groupPlayerId].roundScores.push({
        tableId: table.id,
        roundNo: Number(table.roundNo) || 1,
        score: finalScore
      });
    });
  });
  return {
    settledAt: Date.now(),
    tableCount: endedTables.length,
    finalScores: Object.values(scoreMap).sort((left, right) => right.totalScore - left.totalScore)
  };
}

async function endTableLocal(tableId) {
  const tables = readTables();
  const index = getTableIndex(tables, tableId);
  if (index < 0) throw new Error('牌局不存在');
  const table = tables[index];
  const ownerOpenid = getLocalOpenid();
  if (table.ownerOpenid !== ownerOpenid) throw new Error('只有桌主可以结束牌局');
  if (table.status !== 'active') throw new Error('牌局已结束');
  markTableEnded(table);
  writeTables(tables);
  return clone(table);
}

async function settleTableLocal(tableId, multiplier) {
  const tables = readTables();
  const index = getTableIndex(tables, tableId);
  if (index < 0) throw new Error('牌局不存在');
  const table = tables[index];
  if (table.ownerOpenid !== getLocalOpenid()) throw new Error('只有桌主可以结算牌局');
  settleTableWithMultiplier(table, multiplier);
  writeTables(tables);
  return clone(table);
}

async function startNextTableLocal(tableId) {
  const tables = readTables();
  const index = getTableIndex(tables, tableId);
  if (index < 0) throw new Error('牌局不存在');
  const table = tables[index];
  if (table.ownerOpenid !== getLocalOpenid()) throw new Error('只有桌主可以开启下一局');
  if (table.status !== 'ended') throw new Error('请先结束本次对局');
  if (table.groupStatus === 'settled' || table.groupSettlement) throw new Error('所有对局已结算，不能开启下一局');
  if (table.nextTableId) {
    const existingNext = tables.find((item) => item.id === table.nextTableId);
    if (existingNext) return clone(existingNext);
  }
  normalizeGroupPlayers(table);
  const nextTable = buildNextTable(table);
  table.groupId = getGroupId(table);
  table.nextTableId = nextTable.id;
  table.updatedAt = Date.now();
  tables.unshift(nextTable);
  writeTables(tables);
  return clone(nextTable);
}

async function settleGroupLocal(tableId, multiplier) {
  const tables = readTables();
  const index = getTableIndex(tables, tableId);
  if (index < 0) throw new Error('牌局不存在');
  const table = tables[index];
  if (table.ownerOpenid !== getLocalOpenid()) throw new Error('只有桌主可以结算所有对局');
  if (table.groupStatus === 'settled' && table.groupSettlement) return clone(table);
  const groupTables = getGroupTables(tables, table);
  const hasPendingSettlement = groupTables.some((item) => (
    (item.status === 'active' || item.status === 'ended') && !item.settlement
  ));
  if (hasPendingSettlement) {
    groupTables.forEach((item) => {
      if (!item.settlement) settleTableWithMultiplier(item, multiplier);
    });
  }
  if (groupTables.some((item) => item.status !== 'ended')) throw new Error('还有未结束的对局');
  const groupSettlement = buildGroupSettlement(groupTables);
  groupTables.forEach((item) => {
    item.groupId = getGroupId(table);
    item.groupStatus = 'settled';
    item.groupSettlement = groupSettlement;
    item.updatedAt = Date.now();
  });
  writeTables(tables);
  return clone(tables[index]);
}

async function deleteTableLocal(tableId) {
  writeTables(readTables().filter((table) => table.id !== tableId));
}

async function withCloudOnly(cloudTask) {
  const me = await ensureMe();
  if (me.mode !== 'cloud') throw new Error('云开发连接失败，请检查云环境或重新编译');
  const result = await cloudTask();
  setStoredMode('cloud');
  return result;
}

async function listTables() {
  return withCloudOnly(async () => {
    const tables = await callTableOp('listTables', {});
    return Promise.all(tables.map(normalizeTable));
  });
}

async function getTable(tableId) {
  return withCloudOnly(async () => normalizeTable(await callTableOp('getTable', { tableId })));
}

async function getTableByShareCode(shareCode) {
  return withCloudOnly(async () => normalizeTable(await callTableOp('getTableByShareCode', { shareCode })));
}

async function createTable(payload) {
  return withCloudOnly(
    async () => {
      const savedPayload = { ...payload };
      if (savedPayload.ownerAvatarUrl) {
        savedPayload.ownerAvatarUrl = await uploadCloudAvatar(savedPayload.ownerAvatarUrl);
      }
      return normalizeTable(await callTableOp('createTable', savedPayload));
    }
  );
}

async function joinTable(tableId, playerId, name, avatarUrl) {
  return withCloudOnly(async () => {
    const savedAvatarUrl = await uploadCloudAvatar(avatarUrl);
    return callTableOp('joinTable', { tableId, playerId, name, avatarFileId: savedAvatarUrl });
  });
}

async function updateMyProfile(tableId, payload) {
  return withCloudOnly(async () => {
    const savedPayload = { ...payload };
    if (savedPayload.avatarUrl !== undefined) {
      savedPayload.avatarFileId = await uploadCloudAvatar(savedPayload.avatarUrl);
      delete savedPayload.avatarUrl;
    }
    return callTableOp('updateMyProfile', { tableId, ...savedPayload });
  });
}

async function giveScore(tableId, fromPlayerId, toPlayerId, amount) {
  return withCloudOnly(async () => normalizeTable(
    await callTableOp('giveScore', { tableId, fromPlayerId, toPlayerId, amount })
  ));
}

async function undoLastGive(tableId, fromPlayerId, toPlayerId) {
  return withCloudOnly(async () => normalizeTable(
    await callTableOp('undoLastGive', { tableId, fromPlayerId, toPlayerId })
  ));
}

async function toggleMuted(tableId) {
  return withCloudOnly(async () => normalizeTable(await callTableOp('toggleMuted', { tableId })));
}

async function endTable(tableId) {
  return withCloudOnly(async () => normalizeTable(await callTableOp('endTable', { tableId })));
}

async function settleTable(tableId, multiplier) {
  return withCloudOnly(async () => normalizeTable(
    await callTableOp('settleTable', { tableId, multiplier })
  ));
}

async function startNextTable(tableId) {
  return withCloudOnly(async () => normalizeTable(await callTableOp('startNextTable', { tableId })));
}

async function settleGroup(tableId, multiplier) {
  return withCloudOnly(async () => normalizeTable(
    await callTableOp('settleGroup', { tableId, multiplier })
  ));
}

async function deleteTable(tableId) {
  return withCloudOnly(() => callTableOp('deleteTable', { tableId }));
}

async function deleteGroup(tableId) {
  return withCloudOnly(() => callTableOp('deleteGroup', { tableId }));
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
  settleTable,
  startNextTable,
  settleGroup,
  deleteTable,
  deleteGroup,
  findMyPlayer,
  sortPlayers,
  getLocalOpenid,
  ensureMe,
  getStoredMode,
  getTableCode,
  normalizeTable,
  clearAvatarUrlCache,
  isNoticeSeen,
  markNoticeSeen
};
