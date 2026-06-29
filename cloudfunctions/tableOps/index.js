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

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
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
  return message || '云函数执行失败';
}

function normalizePlayer(name, index, openid, isOwner) {
  const trimmed = String(name || '').trim() || `玩家${index + 1}`;
  return {
    id: makeId('player'),
    openid: isOwner ? openid : '',
    name: trimmed,
    avatarUrl: '',
    score: 0,
    isOwner: !!isOwner,
    avatarColor: avatarColors[index % avatarColors.length],
    joinedAt: Date.now()
  };
}

async function getTableById(tableId) {
  const { data } = await db.collection('tables').doc(tableId).get();
  return data || null;
}

async function updateTable(tableId, table) {
  await db.collection('tables').doc(tableId).set({
    data: table
  });
  return getTableById(tableId);
}

async function listTables(openid) {
  const { data } = await db.collection('tables')
    .where({
      participantOpenids: _.in([openid])
    })
    .orderBy('createdAt', 'desc')
    .get();
  return data;
}

async function createTable(event, openid) {
  const names = (event.playerNames || []).filter((item) => String(item || '').trim());
  const playerNames = names.length ? names : ['我', '玩家2', '玩家3', '玩家4'];
  const table = {
    name: event.name || '麻将计分桌',
    shareCode: makeShareCode(),
    ownerOpenid: openid,
    status: 'active',
    createdAt: Date.now(),
    endedAt: null,
    muted: false,
    participantOpenids: [openid],
    players: playerNames.map((name, index) => normalizePlayer(name, index, openid, index === 0)),
    records: []
  };
  const result = await db.collection('tables').add({ data: table });
  return getTableById(result._id);
}

async function getTable(tableId) {
  return getTableById(tableId);
}

async function getTableByShareCode(shareCode) {
  const { data } = await db.collection('tables')
    .where({ shareCode })
    .limit(1)
    .get();
  return data[0] || null;
}

async function joinTable(event, openid) {
  const table = await getTableById(event.tableId);
  if (!table) throw new Error('牌局不存在');

  const existing = table.players.find((player) => player.openid === openid);
  if (existing) return existing;

  let player = table.players.find((item) => item.id === event.playerId);
  if (!player && event.playerId) throw new Error('玩家不存在');
  if (player && player.openid) throw new Error('该玩家已被绑定');
  if (!player) {
    player = normalizePlayer(event.name, table.players.length, openid, false);
    table.players.push(player);
  }

  player.openid = openid;
  player.name = String(event.name || player.name).trim() || player.name;
  player.avatarUrl = event.avatarUrl || player.avatarUrl || '';
  player.joinedAt = Date.now();
  table.participantOpenids = Array.from(new Set([...(table.participantOpenids || []), openid]));
  await updateTable(event.tableId, table);
  return player;
}

async function updateMyProfile(event, openid) {
  const table = await getTableById(event.tableId);
  if (!table) throw new Error('牌局不存在');
  const player = table.players.find((item) => item.openid === openid);
  if (!player) throw new Error('请先加入牌局');

  const name = String(event.name || '').trim();
  if (!name) throw new Error('请输入昵称');
  player.name = name;
  if (event.avatarUrl !== undefined) {
    player.avatarUrl = event.avatarUrl || '';
  }
  await updateTable(event.tableId, table);
  return player;
}

async function giveScore(event, openid) {
  const table = await getTableById(event.tableId);
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
  return updateTable(event.tableId, table);
}

async function undoLastGive(event, openid) {
  const table = await getTableById(event.tableId);
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
  return updateTable(event.tableId, table);
}

async function toggleMuted(event) {
  const table = await getTableById(event.tableId);
  if (!table) throw new Error('牌局不存在');
  table.muted = !table.muted;
  return updateTable(event.tableId, table);
}

async function endTable(event, openid) {
  const table = await getTableById(event.tableId);
  if (!table) throw new Error('牌局不存在');
  if (table.ownerOpenid !== openid) throw new Error('只有桌主可以结束牌局');
  table.status = 'ended';
  table.endedAt = Date.now();
  return updateTable(event.tableId, table);
}

async function deleteTable(event, openid) {
  const table = await getTableById(event.tableId);
  if (!table) return true;
  if (table.ownerOpenid !== openid) throw new Error('只有桌主可以删除牌局');
  await db.collection('tables').doc(event.tableId).remove();
  return true;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    switch (event.action) {
      case 'listTables':
        return ok(await listTables(OPENID));
      case 'createTable':
        return ok(await createTable(event, OPENID));
      case 'getTable':
        return ok(await getTable(event.tableId));
      case 'getTableByShareCode':
        return ok(await getTableByShareCode(event.shareCode));
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
      case 'deleteTable':
        return ok(await deleteTable(event, OPENID));
      default:
        return fail('未知操作');
    }
  } catch (error) {
    return fail(getErrorMessage(error));
  }
};
