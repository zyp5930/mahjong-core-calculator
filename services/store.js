const { makeId, makeShareCode } = require('../utils/format');

const STORAGE_KEY = 'mahjong_tables_v1';
const OPENID_KEY = 'mahjong_local_openid_v1';

const avatarColors = ['#6b9fe8', '#45b7a8', '#f16f5d', '#8a7ee8', '#d69a25', '#5f7285'];

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
  const openid = getLocalOpenid();
  return table.players.find((player) => player.openid === openid) || null;
}

async function listTables() {
  return clone(readTables()).sort((left, right) => right.createdAt - left.createdAt);
}

async function getTable(tableId) {
  const table = readTables().find((item) => item.id === tableId);
  return table ? clone(table) : null;
}

async function getTableByShareCode(shareCode) {
  const table = readTables().find((item) => item.shareCode === shareCode);
  return table ? clone(table) : null;
}

async function createTable(payload) {
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

async function joinTable(tableId, playerId, name) {
  const tables = readTables();
  const index = getTableIndex(tables, tableId);
  if (index < 0) throw new Error('牌局不存在');
  const table = tables[index];
  const openid = getLocalOpenid();
  const existing = table.players.find((player) => player.openid === openid);
  if (existing) return clone(existing);

  const player = table.players.find((item) => item.id === playerId);
  if (!player) throw new Error('玩家不存在');
  if (player.openid) throw new Error('该玩家已被绑定');
  player.openid = openid;
  player.name = String(name || player.name).trim() || player.name;
  player.joinedAt = Date.now();
  writeTables(tables);
  return clone(player);
}

async function giveScore(tableId, fromPlayerId, toPlayerId, amount) {
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

async function undoLastGive(tableId, fromPlayerId, toPlayerId) {
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

async function toggleMuted(tableId) {
  const tables = readTables();
  const index = getTableIndex(tables, tableId);
  if (index < 0) throw new Error('牌局不存在');
  tables[index].muted = !tables[index].muted;
  writeTables(tables);
  return clone(tables[index]);
}

async function endTable(tableId) {
  const tables = readTables();
  const index = getTableIndex(tables, tableId);
  if (index < 0) throw new Error('牌局不存在');
  tables[index].status = 'ended';
  tables[index].endedAt = Date.now();
  writeTables(tables);
  return clone(tables[index]);
}

async function deleteTable(tableId) {
  writeTables(readTables().filter((table) => table.id !== tableId));
}

module.exports = {
  listTables,
  getTable,
  getTableByShareCode,
  createTable,
  joinTable,
  giveScore,
  undoLastGive,
  toggleMuted,
  endTable,
  deleteTable,
  findMyPlayer,
  sortPlayers,
  getLocalOpenid
};
