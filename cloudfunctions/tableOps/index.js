const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;
const avatarColors = ['#6b9fe8', '#45b7a8', '#f16f5d', '#8a7ee8', '#d69a25', '#5f7285'];

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeShareCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function normalizeScore(value) {
  const number = Number(value) || 0;
  return Number(number.toFixed(10));
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

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

function maskOpenid(openid) {
  if (!openid) return '';
  return `***${String(openid).slice(-6)}`;
}

function getValueSummary(value) {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return 'null';
  return typeof value;
}

function cleanForDb(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanForDb(item))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((result, key) => {
      const cleaned = cleanForDb(value[key]);
      if (cleaned !== undefined) {
        result[key] = cleaned;
      }
      return result;
    }, {});
  }
  return value === undefined ? undefined : value;
}

function findUndefinedPaths(value, prefix = 'data') {
  if (value === undefined) return [prefix];
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.reduce((paths, item, index) => (
      paths.concat(findUndefinedPaths(item, `${prefix}[${index}]`))
    ), []);
  }
  return Object.keys(value).reduce((paths, key) => (
    paths.concat(findUndefinedPaths(value[key], `${prefix}.${key}`))
  ), []);
}

function getTableSummary(table) {
  if (!table) return null;
  return {
    id: table._id || table.id || '',
    name: table.name,
    shareCode: table.shareCode,
    ownerOpenid: maskOpenid(table.ownerOpenid),
    status: table.status,
    playerCount: (table.players || []).length,
    recordCount: (table.records || []).length,
    participantCount: (table.participantOpenids || []).length,
    topLevelKeys: Object.keys(table),
    topLevelTypes: Object.keys(table).reduce((summary, key) => ({
      ...summary,
      [key]: getValueSummary(table[key])
    }), {})
  };
}

function getWriteSummary(data) {
  return {
    keys: Object.keys(data),
    types: Object.keys(data).reduce((summary, key) => ({
      ...summary,
      [key]: getValueSummary(data[key])
    }), {}),
    players: (data.players || []).map((player, index) => ({
      index,
      keys: Object.keys(player),
      id: player.id,
      openid: maskOpenid(player.openid),
      name: player.name,
      avatarUrlType: getValueSummary(player.avatarUrl),
      avatarFileIdType: getValueSummary(player.avatarFileId),
      score: player.score
    })),
    records: (data.records || []).map((record, index) => ({
      index,
      keys: Object.keys(record),
      id: record.id,
      amount: record.amount,
      revokedAtType: getValueSummary(record.revokedAt)
    }))
  };
}

function buildTableListItem(table) {
  if (!table) return null;
  return {
    _id: table._id || table.id || '',
    name: table.name,
    shareCode: table.shareCode,
    ownerOpenid: table.ownerOpenid,
    status: table.status,
    groupId: table.groupId || table._id || table.id || '',
    roundNo: Number(table.roundNo) || 1,
    previousTableId: table.previousTableId || '',
    nextTableId: table.nextTableId || '',
    groupStatus: table.groupStatus || (table.groupSettlement ? 'settled' : 'active'),
    groupSettlement: normalizeGroupSettlement(table.groupSettlement),
    settlementStatus: getSettlementStatus(table),
    createdAt: table.createdAt,
    updatedAt: table.updatedAt || table.createdAt || Date.now(),
    endedAt: table.endedAt || null,
    muted: !!table.muted,
    settlement: normalizeSettlement(table.settlement),
    players: (table.players || []).map((player) => ({
      id: player.id,
      groupPlayerId: player.groupPlayerId || player.id,
      openid: player.openid || '',
      name: player.name || '',
      avatarUrl: player.avatarUrl || '',
      avatarFileId: player.avatarFileId || '',
      score: normalizeScore(player.score),
      isOwner: !!player.isOwner,
      avatarColor: player.avatarColor || '',
      joinedAt: player.joinedAt || null
    }))
  };
}

function logError(label, error, context) {
  console.error(label, {
    context,
    error,
    message: error && error.message,
    errCode: error && error.errCode,
    errMsg: error && error.errMsg,
    code: error && error.code,
    stack: error && error.stack
  });
}

function getErrorMessage(error) {
  const message = (error && error.message) || String(error || '');
  if (
    message.includes('collection') ||
    message.includes('DATABASE_COLLECTION_NOT_EXIST') ||
    message.includes('collection not exists') ||
    message.includes('Db or Table not exist')
  ) {
    return '云数据库缺少 tables 集合，请先在云开发控制台创建';
  }
  if (message.includes('permission') || message.includes('PERMISSION_DENIED')) {
    return '云数据库权限不足，请检查 tables 集合权限';
  }
  if (message.includes('response size exceeded') || message.includes('EXCEED_MAX_RESPONSE_SIZE')) {
    return '云端返回数据过大，请重新部署最新云函数后重试';
  }
  return message || '云函数执行失败';
}

function normalizePlayer(name, index, openid, isOwner) {
  const trimmed = String(name || '').trim() || `玩家${index + 1}`;
  return {
    id: makeId('player'),
    openid: isOwner ? openid : '',
    name: trimmed,
    avatarUrl: '',
    avatarFileId: '',
    score: 0,
    isOwner: !!isOwner,
    avatarColor: avatarColors[index % avatarColors.length],
    joinedAt: Date.now()
  };
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

async function getTableById(tableId) {
  try {
    const { data } = await db.collection('tables').doc(tableId).get();
    return data || null;
  } catch (error) {
    const message = (error && error.message) || String(error || '');
    if (
      message.includes('document') ||
      message.includes('does not exist') ||
      message.includes('not exist') ||
      message.includes('DOCUMENT_NOT_EXIST')
    ) {
      return null;
    }
    throw error;
  }
}

function canReadTable(table, openid) {
  if (!table || !openid) return false;
  return table.ownerOpenid === openid || (table.participantOpenids || []).includes(openid);
}

async function attachAvatarUrls(table, openid, options = {}) {
  if (!table) return table;
  if (!options.force && !canReadTable(table, openid)) return table;
  const players = table.players || [];
  const avatarFileIds = Array.from(new Set(players
    .map((player) => player.avatarFileId || (/^cloud:\/\//.test(String(player.avatarUrl || '')) ? player.avatarUrl : ''))
    .filter(Boolean)));
  if (!avatarFileIds.length) return table;
  try {
    const result = await cloud.getTempFileURL({
      fileList: avatarFileIds
    });
    const urlMap = (result.fileList || []).reduce((map, item) => {
      if (item.fileID && item.tempFileURL) {
        map[item.fileID] = item.tempFileURL;
      }
      return map;
    }, {});
    return {
      ...table,
      players: players.map((player) => {
        const avatarFileId = player.avatarFileId || (/^cloud:\/\//.test(String(player.avatarUrl || '')) ? player.avatarUrl : '');
        return {
          ...player,
          avatarFileId,
          avatarUrl: urlMap[avatarFileId] || ''
        };
      })
    };
  } catch (error) {
    logError('[tableOps attachAvatarUrls failed]', error, {
      tableId: table._id || table.id || '',
      openid: maskOpenid(openid),
      avatarCount: avatarFileIds.length
    });
    return table;
  }
}

async function updateTable(tableId, table, options = {}) {
  const players = (table.players || []).map((player, index) => ({
    id: player.id,
    groupPlayerId: player.groupPlayerId || player.id,
    openid: player.openid || '',
    name: String(player.name || '').trim() || `玩家${index + 1}`,
    avatarUrl: '',
    avatarFileId: player.avatarFileId || (/^cloud:\/\//.test(String(player.avatarUrl || '')) ? player.avatarUrl : ''),
    score: normalizeScore(player.score),
    isOwner: !!player.isOwner,
    avatarColor: player.avatarColor || avatarColors[index % avatarColors.length],
    joinedAt: player.joinedAt || Date.now()
  }));
  const records = (table.records || []).map((record) => ({
    id: record.id || makeId('record'),
    type: record.type || 'score',
    multiplier: normalizeScore(record.multiplier),
    finalScores: normalizeFinalScores(record.finalScores),
    fromPlayerId: record.fromPlayerId || '',
    fromPlayerName: record.fromPlayerName || '',
    toPlayerId: record.toPlayerId || '',
    toPlayerName: record.toPlayerName || '',
    amount: Number(record.amount) || 0,
    operatorOpenid: record.operatorOpenid || '',
    createdAt: record.createdAt || Date.now(),
    revoked: !!record.revoked,
    revokedAt: record.revokedAt || null
  }));
  const data = {
    name: table.name,
    shareCode: table.shareCode,
    ownerOpenid: table.ownerOpenid,
    status: table.status,
    groupId: table.groupId || table._id || table.id || '',
    roundNo: Number(table.roundNo) || 1,
    previousTableId: table.previousTableId || '',
    nextTableId: table.nextTableId || '',
    groupStatus: table.groupStatus || (table.groupSettlement ? 'settled' : 'active'),
    groupSettlement: normalizeGroupSettlement(table.groupSettlement),
    settlementStatus: getSettlementStatus(table),
    createdAt: table.createdAt,
    updatedAt: table.updatedAt || table.createdAt || Date.now(),
    endedAt: table.endedAt || null,
    muted: !!table.muted,
    participantOpenids: table.participantOpenids || [],
    players,
    settlement: normalizeSettlement(table.settlement),
    records,
    notifications: (table.notifications || []).map((item) => ({
      id: item.id || makeId('notice'),
      type: item.type || 'system',
      targetOpenid: item.targetOpenid || '',
      title: String(item.title || '').trim(),
      content: String(item.content || '').trim(),
      createdAt: item.createdAt || Date.now(),
      tableId: item.tableId || table._id || table.id || '',
      fromPlayerId: item.fromPlayerId || '',
      toPlayerId: item.toPlayerId || '',
      fromPlayerName: item.fromPlayerName || '',
      toPlayerName: item.toPlayerName || '',
      amount: Number(item.amount) || 0,
      recordId: item.recordId || '',
      readBy: item.readBy || [],
      readAt: item.readAt || null
    }))
  };
  const undefinedPaths = findUndefinedPaths(data);
  const cleanData = cleanForDb(data);
  console.log('[tableOps updateTable before set]', {
    tableId,
    source: getTableSummary(table),
    undefinedPaths,
    write: getWriteSummary(cleanData)
  });
  try {
    const collection = (options.transaction || db).collection('tables');
    if (options.transaction) {
      await collection.doc(tableId).update({ data: cleanData });
    } else {
      await collection.doc(tableId).set({ data: cleanData });
    }
  } catch (error) {
    logError('[tableOps updateTable set failed]', error, {
      tableId,
      source: getTableSummary(table),
      undefinedPaths,
      rawWrite: getWriteSummary(data),
      cleanWrite: getWriteSummary(cleanData)
    });
    throw error;
  }
  return options.transaction ? table : getTableById(tableId);
}

async function listTables(openid) {
  const { data } = await db.collection('tables')
    .where({
      participantOpenids: _.in([openid])
    })
    .field({
      name: true,
      shareCode: true,
      ownerOpenid: true,
      status: true,
      groupId: true,
      roundNo: true,
      previousTableId: true,
      nextTableId: true,
      groupStatus: true,
      groupSettlement: true,
      settlementStatus: true,
      createdAt: true,
      updatedAt: true,
      endedAt: true,
      muted: true,
      settlement: true,
      players: true
    })
    .orderBy('createdAt', 'desc')
    .get();
  return data.map(buildTableListItem);
}

async function createTable(event, openid) {
  const names = (event.playerNames || []).filter((item) => String(item || '').trim());
  const playerNames = names.length ? names : ['我', '玩家2', '玩家3', '玩家4'];
  const players = playerNames.map((name, index) => normalizePlayer(name, index, openid, index === 0));
  players.forEach((player) => {
    player.groupPlayerId = player.groupPlayerId || player.id;
  });
  if (players[0] && event.ownerAvatarUrl) {
    players[0].avatarFileId = event.ownerAvatarUrl;
    players[0].avatarUrl = '';
  }
  const table = {
    name: event.name || '麻将计分桌',
    shareCode: makeShareCode(),
    ownerOpenid: openid,
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
    participantOpenids: [openid],
    players,
    records: [],
    notifications: [],
    settlement: null
  };
  const result = await db.collection('tables').add({ data: table });
  return attachAvatarUrls(await getTableById(result._id), openid);
}

async function getTable(tableId, openid) {
  return attachAvatarUrls(await getTableById(tableId), openid, { force: true });
}

async function getTableByShareCode(shareCode, openid) {
  const { data } = await db.collection('tables')
    .where({ shareCode })
    .limit(1)
    .get();
  return attachAvatarUrls(data[0] || null, openid, { force: true });
}

async function joinTable(event, openid) {
  const table = await getTableById(event.tableId);
  if (!table) throw new Error('牌局不存在');
  console.log('[tableOps joinTable loaded]', {
    event: {
      tableId: event.tableId,
      playerId: event.playerId,
      name: event.name,
      hasAvatarUrl: !!event.avatarUrl,
      hasAvatarFileId: !!event.avatarFileId
    },
    openid: maskOpenid(openid),
    table: getTableSummary(table)
  });

  const existing = table.players.find((player) => player.openid === openid);
  if (existing) return existing;

  let player = table.players.find((item) => item.id === event.playerId);
  if (!player && event.playerId) throw new Error('玩家不存在');
  if (player && player.openid) throw new Error('该玩家已被绑定');
  if (!player) {
    player = normalizePlayer(event.name, table.players.length, openid, false);
    table.players.push(player);
  }

  player.groupPlayerId = player.groupPlayerId || player.id;
  player.openid = openid;
  player.name = String(event.name || player.name).trim() || player.name;
  player.avatarFileId = event.avatarFileId || event.avatarUrl || player.avatarFileId || '';
  player.avatarUrl = '';
  player.joinedAt = Date.now();
  table.participantOpenids = Array.from(new Set([...(table.participantOpenids || []), openid]));
  table.updatedAt = Date.now();
  const updatedTable = await updateTable(event.tableId, table);
  const updatedPlayer = (updatedTable.players || []).find((item) => item.id === player.id) || player;
  return (await attachAvatarUrls({ ...updatedTable, players: [updatedPlayer] }, openid)).players[0];
}

async function updateMyProfile(event, openid) {
  const table = await getTableById(event.tableId);
  if (!table) throw new Error('牌局不存在');
  const player = table.players.find((item) => item.openid === openid);
  if (!player) throw new Error('请先加入牌局');

  const name = String(event.name || '').trim();
  if (!name) throw new Error('请输入昵称');
  player.name = name;
  if (event.avatarFileId !== undefined || event.avatarUrl !== undefined) {
    player.avatarFileId = event.avatarFileId || event.avatarUrl || '';
    player.avatarUrl = '';
  }
  const updatedTable = await updateTable(event.tableId, table);
  const updatedPlayer = (updatedTable.players || []).find((item) => item.id === player.id) || player;
  return (await attachAvatarUrls({ ...updatedTable, players: [updatedPlayer] }, openid)).players[0];
}

async function giveScore(event, openid) {
  if (!db.runTransaction) throw new Error('当前云开发环境不支持事务，请升级 wx-server-sdk');
  return db.runTransaction(async (transaction) => {
    const { data: table } = await transaction.collection('tables').doc(event.tableId).get();
    if (!table) throw new Error('牌局不存在');
    if (table.status !== 'active') throw new Error('牌局已结束');

    const amount = Number(event.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('请输入有效分数');
    if (event.fromPlayerId === event.toPlayerId) throw new Error('不能给自己计分');

    const fromPlayer = table.players.find((player) => player.id === event.fromPlayerId);
    const toPlayer = table.players.find((player) => player.id === event.toPlayerId);
    if (!fromPlayer || !toPlayer) throw new Error('玩家不存在');
    if (fromPlayer.openid !== openid) throw new Error('只能操作你自己的身份');

    fromPlayer.score -= amount;
    toPlayer.score += amount;
    table.updatedAt = Date.now();
    table.records = table.records || [];
    table.records.unshift({
      id: makeId('record'),
      fromPlayerId: fromPlayer.id,
      fromPlayerName: fromPlayer.name,
      toPlayerId: toPlayer.id,
      toPlayerName: toPlayer.name,
      amount,
      operatorOpenid: openid,
      createdAt: Date.now(),
      revoked: false
    });
    if (toPlayer.openid) {
      table.notifications = table.notifications || [];
      table.notifications.unshift(makeNotification(
        'score',
        toPlayer.openid,
        '收到给分',
        `收到 ${fromPlayer.name} 的 ${amount} 分`,
        {
          tableId: event.tableId,
          fromPlayerId: fromPlayer.id,
          toPlayerId: toPlayer.id,
          amount,
          fromPlayerName: fromPlayer.name,
          toPlayerName: toPlayer.name
        }
      ));
    }
    return updateTable(event.tableId, table, { transaction });
  });
}

async function undoLastGive(event, openid) {
  if (!db.runTransaction) throw new Error('当前云开发环境不支持事务，请升级 wx-server-sdk');
  return db.runTransaction(async (transaction) => {
    const { data: table } = await transaction.collection('tables').doc(event.tableId).get();
    if (!table) throw new Error('牌局不存在');
    if (table.status !== 'active') throw new Error('牌局已结束');

    const fromPlayer = table.players.find((player) => player.id === event.fromPlayerId);
    const toPlayer = table.players.find((player) => player.id === event.toPlayerId);
    if (!fromPlayer || !toPlayer) throw new Error('玩家不存在');
    if (fromPlayer.openid !== openid) throw new Error('只能操作你自己的身份');

    const record = (table.records || []).find((item) => (
      !item.revoked &&
      item.operatorOpenid === openid &&
      item.fromPlayerId === event.fromPlayerId &&
      item.toPlayerId === event.toPlayerId
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
          tableId: event.tableId,
          fromPlayerId: fromPlayer.id,
          toPlayerId: toPlayer.id,
          amount: record.amount,
          recordId: record.id
        }
      ));
    }
    return updateTable(event.tableId, table, { transaction });
  });
}

async function toggleMuted(event) {
  const table = await getTableById(event.tableId);
  if (!table) throw new Error('牌局不存在');
  table.muted = !table.muted;
  return updateTable(event.tableId, table);
}

function getGroupId(table) {
  return table.groupId || table._id || table.id;
}

function normalizeGroupPlayers(table) {
  table.players = (table.players || []).map((player) => ({
    ...player,
    groupPlayerId: player.groupPlayerId || player.id
  }));
}

function buildSettlement(table, multiplier) {
  const settledMultiplier = normalizeScore(multiplier);
  const settledAt = Date.now();
  return {
    multiplier: settledMultiplier,
    settledAt,
    finalScores: (table.players || []).map((player) => {
      const rawScore = normalizeScore(player.score);
      return {
        playerId: player.id,
        groupPlayerId: player.groupPlayerId || player.id,
        name: player.name,
        rawScore,
        finalScore: normalizeScore(rawScore * settledMultiplier)
      };
    })
  };
}

function applySettlement(table, multiplier) {
  const settlement = buildSettlement(table, multiplier);
  table.status = 'ended';
  table.settlementStatus = 'settled';
  table.endedAt = table.endedAt || settlement.settledAt;
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

async function getGroupTables(table) {
  const groupId = getGroupId(table);
  const { data } = await db.collection('tables')
    .where({ groupId })
    .limit(100)
    .get();
  const tables = data.length ? data : [table];
  return tables.sort((left, right) => (
    (Number(left.roundNo) || 1) - (Number(right.roundNo) || 1) ||
    (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0)
  ));
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
    name: table.name,
    shareCode: makeShareCode(),
    ownerOpenid: table.ownerOpenid,
    status: 'active',
    groupId: getGroupId(table),
    roundNo: (Number(table.roundNo) || 1) + 1,
    previousTableId: table._id || table.id,
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
        tableId: table._id || table.id,
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

async function endTable(event, openid) {
  const table = await getTableById(event.tableId);
  if (!table) throw new Error('牌局不存在');
  if (table.ownerOpenid !== openid) throw new Error('只有桌主可以结束牌局');
  if (table.status !== 'active') throw new Error('牌局已结束');
  markTableEnded(table);
  return updateTable(event.tableId, table);
}

async function settleTable(event, openid) {
  const table = await getTableById(event.tableId);
  if (!table) throw new Error('牌局不存在');
  if (table.ownerOpenid !== openid) throw new Error('只有桌主可以结算牌局');
  settleTableWithMultiplier(table, event.multiplier);
  return updateTable(event.tableId, table);
}

async function startNextTable(event, openid) {
  const table = await getTableById(event.tableId);
  if (!table) throw new Error('牌局不存在');
  if (table.ownerOpenid !== openid) throw new Error('只有桌主可以开启下一局');
  if (table.status !== 'ended') throw new Error('请先结束本次对局');
  if (table.groupStatus === 'settled' || table.groupSettlement) throw new Error('所有对局已结算，不能开启下一局');
  if (table.nextTableId) {
    const existingNext = await getTableById(table.nextTableId);
    if (existingNext) return attachAvatarUrls(existingNext, openid, { force: true });
  }
  normalizeGroupPlayers(table);
  const nextTable = buildNextTable(table);
  const result = await db.collection('tables').add({ data: cleanForDb(nextTable) });
  table.groupId = getGroupId(table);
  table.nextTableId = result._id;
  table.updatedAt = Date.now();
  await updateTable(event.tableId, table);
  return attachAvatarUrls(await getTableById(result._id), openid, { force: true });
}

async function settleGroup(event, openid) {
  const table = await getTableById(event.tableId);
  if (!table) throw new Error('牌局不存在');
  if (table.ownerOpenid !== openid) throw new Error('只有桌主可以结算所有对局');
  if (table.groupStatus === 'settled' && table.groupSettlement) {
    return attachAvatarUrls(table, openid, { force: true });
  }
  const groupTables = await getGroupTables({ ...table, groupId: getGroupId(table) });
  const hasPendingSettlement = groupTables.some((item) => (
    (item.status === 'active' || item.status === 'ended') && !item.settlement
  ));
  if (hasPendingSettlement) {
    await Promise.all(groupTables.map(async (item) => {
      if (item.settlement) return;
      settleTableWithMultiplier(item, event.multiplier);
      await updateTable(item._id, item);
    }));
  }
  if (groupTables.some((item) => item.status !== 'ended')) throw new Error('还有未结束的对局');
  const groupSettlement = buildGroupSettlement(groupTables);
  await Promise.all(groupTables.map((item) => updateTable(item._id, {
    ...item,
    groupId: getGroupId(table),
    groupStatus: 'settled',
    groupSettlement,
    updatedAt: Date.now()
  })));
  return attachAvatarUrls(await getTableById(event.tableId), openid, { force: true });
}

async function deleteTable(event, openid) {
  const table = await getTableById(event.tableId);
  if (!table) return true;
  if (table.ownerOpenid !== openid) throw new Error('只有桌主可以删除牌局');
  await db.collection('tables').doc(event.tableId).remove();
  return true;
}

async function deleteGroup(event, openid) {
  const table = await getTableById(event.tableId);
  if (!table) return { deletedCount: 0 };
  if (table.ownerOpenid !== openid) throw new Error('只有桌主可以删除牌局');

  const groupTables = await getGroupTables(table);
  await Promise.all(groupTables.map((item) => (
    db.collection('tables').doc(item._id || item.id).remove()
  )));
  return { deletedCount: groupTables.length };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  console.log('[tableOps main start]', {
    action: event && event.action,
    event: {
      ...event,
      avatarUrl: event && event.avatarUrl ? `[avatarUrl length ${String(event.avatarUrl).length}]` : event && event.avatarUrl,
      avatarFileId: event && event.avatarFileId ? `[avatarFileId length ${String(event.avatarFileId).length}]` : event && event.avatarFileId
    },
    openid: maskOpenid(OPENID)
  });
  try {
    switch (event.action) {
      case 'listTables':
        return ok(await listTables(OPENID));
      case 'createTable':
        return ok(await createTable(event, OPENID));
      case 'getTable':
        return ok(await getTable(event.tableId, OPENID));
      case 'getTableByShareCode':
        return ok(await getTableByShareCode(event.shareCode, OPENID));
      case 'joinTable':
        return ok(await joinTable(event, OPENID));
      case 'updateMyProfile':
        return ok(await updateMyProfile(event, OPENID));
      case 'giveScore':
        return ok(await giveScore(event, OPENID));
      case 'undoLastGive':
        return ok(await undoLastGive(event, OPENID));
      case 'toggleMuted':
        return ok(await toggleMuted(event));
      case 'endTable':
        return ok(await endTable(event, OPENID));
      case 'settleTable':
        return ok(await settleTable(event, OPENID));
      case 'startNextTable':
        return ok(await startNextTable(event, OPENID));
      case 'settleGroup':
        return ok(await settleGroup(event, OPENID));
      case 'deleteTable':
        return ok(await deleteTable(event, OPENID));
      case 'deleteGroup':
        return ok(await deleteGroup(event, OPENID));
      default:
        return fail('未知操作');
    }
  } catch (error) {
    logError('[tableOps main failed]', error, {
      action: event && event.action,
      event: {
        ...event,
        avatarUrl: event && event.avatarUrl ? `[avatarUrl length ${String(event.avatarUrl).length}]` : event && event.avatarUrl,
        avatarFileId: event && event.avatarFileId ? `[avatarFileId length ${String(event.avatarFileId).length}]` : event && event.avatarFileId
      },
      openid: maskOpenid(OPENID)
    });
    return fail(getErrorMessage(error));
  }
};
