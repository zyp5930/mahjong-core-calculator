const store = require('../../services/store');
const { formatDuration, formatTime, normalizeScore } = require('../../utils/format');

Page({
  data: {
    groupId: '',
    group: null,
    loading: true,
    showScoreTrends: false,
    showMyScoreTrend: false,
    myTrendName: '',
    allTrendPlayers: [],
    trendLabels: [],
    trendRecordCounts: [],
    myTrendSeries: [],
    allTrendSeries: [],
    roundTrendTables: [],
    selectedRoundTrendTableId: '',
    showRoundTrend: false,
    roundTrendPlayers: [],
    roundTrendLoading: false,
    showRoundWinTrend: false,
    roundWinPlayers: [],
    showGroupWinTrend: false,
    groupWinPlayers: []
  },

  onLoad(options) {
    this.setData({ groupId: options.groupId || '' });
    this.hasOpenerData = false;
    const eventChannel = this.getOpenerEventChannel();
    eventChannel.on('groupTables', (payload) => {
      const tables = (payload && payload.tables) || [];
      if (!tables.length) return;
      this.hasOpenerData = true;
      if (this.initialLoadTimer) clearTimeout(this.initialLoadTimer);
      this.applyGroupTables(tables);
      this.loadGroup();
    });
  },

  onShow() {
    if (this.hasShown) {
      this.loadGroup();
      return;
    }
    this.hasShown = true;
    this.initialLoadTimer = setTimeout(() => {
      if (!this.hasOpenerData) this.loadGroup();
    }, 80);
  },

  onUnload() {
    if (this.initialLoadTimer) clearTimeout(this.initialLoadTimer);
    this.clearTrendTouchTimers();
    this.clearTrendRenderTimer();
  },

  onPullDownRefresh() {
    this.loadGroup().finally(() => wx.stopPullDownRefresh());
  },

  formatScore(score) {
    const value = normalizeScore(Number(score) || 0);
    return value > 0 ? `+${value}` : `${value}`;
  },

  formatTable(table) {
    const settlementScores = ((table.settlement && table.settlement.finalScores) || []).reduce((map, item) => {
      map[item.playerId] = item;
      return map;
    }, {});
    return {
      ...table,
      roundText: `第${Number(table.roundNo) || 1}局`,
      createdText: formatTime(table.createdAt),
      statusText: table.status === 'active' ? '进行中' : (table.settlementStatus === 'pending' ? '待结算' : '已结算'),
      players: (table.players || []).map((player) => {
        const settlement = settlementScores[player.id];
        return {
          ...player,
          rawScore: normalizeScore(settlement ? settlement.rawScore : player.score),
          settledScore: normalizeScore(settlement ? settlement.finalScore : player.score),
          initial: String(player.name || '').slice(0, 1)
        };
      })
    };
  },

  buildRounds(tables) {
    return tables.map((table, index) => {
      const nextTable = tables[index + 1];
      const endedAt = nextTable && nextTable.createdAt > table.createdAt ? nextTable.createdAt : table.endedAt;
      const players = table.players.map((player) => {
        const score = player.rawScore;
        return {
          ...player,
          score,
          scoreText: this.formatScore(score)
        };
      });
      return {
        ...table,
        durationText: table.status === 'active'
          ? `已进行${formatDuration(table.createdAt)}`
          : `持续${formatDuration(table.createdAt, endedAt)}`,
        players,
        playerColumnCount: Math.min(4, Math.max(1, players.length)),
        canScrollPlayers: players.length > 4
      };
    });
  },

  applyGroupTables(rawTables) {
    const tables = (rawTables || [])
      .filter((table) => (table.groupId || table.id) === this.data.groupId)
      .map((table) => this.formatTable(table))
      .sort((left, right) => (Number(left.roundNo) || 1) - (Number(right.roundNo) || 1));
    if (!tables.length) {
      this.setData({ group: null, loading: false });
      return;
    }
    const latest = tables[tables.length - 1];
    const currentTable = latest;
    const myPlayer = store.findMyPlayer(currentTable);
    this.roundTrendTableCache = this.roundTrendTableCache || {};
    this.roundTrendLoadedTableIds = this.roundTrendLoadedTableIds || {};
    tables.forEach((table) => {
      const cached = this.roundTrendTableCache[table.id];
      if (cached && Number(cached.updatedAt) !== Number(table.updatedAt)) {
        delete this.roundTrendTableCache[table.id];
        delete this.roundTrendLoadedTableIds[table.id];
      }
    });
    this.groupTrendTables = tables;
    this.setData({
      group: {
        name: latest.name || '麻将计分桌',
        tableCount: tables.length,
        status: latest.status === 'active' ? 'active' : 'ended',
        statusText: latest.status === 'active' ? '进行中' : '已结束',
        rounds: this.buildRounds(tables)
      },
      loading: false
    }, () => {
      this.updateScoreTrends(tables, currentTable, myPlayer);
      this.loadRoundTrend(this.selectedRoundTrendTableId);
      this.loadAllRounds();
    });
  },

  loadAllRounds() {
    const tables = this.groupTrendTables || [];
    const pending = tables.filter((table) => (
      table && table.id &&
      !(this.roundTrendLoadedTableIds && this.roundTrendLoadedTableIds[table.id]) &&
      this.roundTrendLoadingId !== table.id
    ));
    if (!pending.length) return;
    const chunkSize = 5;
    const loadChunk = (start) => {
      if (start >= pending.length) return Promise.resolve();
      const chunk = pending.slice(start, start + chunkSize);
      return Promise.all(chunk.map((table) => store.getTable(table.id).then((full) => {
        if (!full) return;
        this.roundTrendTableCache = this.roundTrendTableCache || {};
        this.roundTrendLoadedTableIds = this.roundTrendLoadedTableIds || {};
        this.roundTrendTableCache[table.id] = full;
        this.roundTrendLoadedTableIds[table.id] = true;
      }).catch(() => null))).then(() => {
        const latestTables = this.groupTrendTables || [];
        const latestCurrent = latestTables[latestTables.length - 1] || null;
        this.updateScoreTrends(latestTables, latestCurrent, latestCurrent && store.findMyPlayer(latestCurrent));
        return loadChunk(start + chunkSize);
      });
    };
    loadChunk(0);
  },

  async loadGroup() {
    const groupId = this.data.groupId;
    if (!groupId) return;
    this.setData({ loading: true });
    try {
      const tables = await store.listGroupTables(groupId);
      this.applyGroupTables(tables);
    } catch (error) {
      this.setData({ group: null, loading: false });
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    }
  },

  updateScoreTrends(tables, currentTable, myPlayer) {
    const sortedTables = (tables || [])
      .filter((table) => table && table.id)
      .map((table) => (
        this.roundTrendLoadedTableIds && this.roundTrendLoadedTableIds[table.id]
          ? this.roundTrendTableCache[table.id] || table
          : table
      ))
      .sort((left, right) => (
        (Number(left.roundNo) || 1) - (Number(right.roundNo) || 1) ||
        (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0)
      ));
    this.groupTrendTables = sortedTables;
    if (!currentTable && sortedTables.length) currentTable = sortedTables[sortedTables.length - 1];
    if (!currentTable) return;
    let selectedTableId = this.selectedRoundTrendTableId;
    if (!sortedTables.some((table) => table.id === selectedTableId)) selectedTableId = currentTable.id;
    this.selectedRoundTrendTableId = selectedTableId;
    const selectedTable = sortedTables.find((table) => table.id === selectedTableId) || currentTable;
    const roundTrend = this.buildRoundScoreTrend(selectedTable);
    const groupTrends = this.buildScoreTrends(sortedTables, myPlayer);
    const roundWinTrend = this.buildRoundWinTrend(selectedTable);
    const groupWinTrend = this.buildGroupWinTrend(sortedTables);
    const trends = { ...groupTrends, ...roundTrend, ...roundWinTrend, ...groupWinTrend };
    this.setData({
      ...groupTrends,
      roundTrendTables: sortedTables.map((table) => ({
        id: table.id,
        label: `第${Number(table.roundNo) || 1}局`,
        selected: table.id === selectedTableId
      })),
      selectedRoundTrendTableId: selectedTableId,
      showRoundTrend: roundTrend.showRoundTrend,
      roundTrendPlayers: roundTrend.roundTrendPlayers,
      roundTrendLoading: this.roundTrendLoadingId === selectedTableId,
      showRoundWinTrend: roundWinTrend.showRoundWinTrend,
      roundWinPlayers: roundWinTrend.roundWinPlayers,
      showGroupWinTrend: groupWinTrend.showGroupWinTrend,
      groupWinPlayers: groupWinTrend.groupWinPlayers
    }, () => this.drawScoreTrends(trends));
  },

  selectRoundTrend(event) {
    const tableId = event.currentTarget.dataset.id;
    if (!tableId || tableId === this.selectedRoundTrendTableId) return;
    this.selectedRoundTrendTableId = tableId;
    const tables = this.groupTrendTables || [];
    const currentTable = tables[tables.length - 1] || null;
    this.updateScoreTrends(tables, currentTable, currentTable && store.findMyPlayer(currentTable));
    this.loadRoundTrend(tableId);
  },

  loadRoundTrend(tableId) {
    if (!tableId) return;
    this.roundTrendTableCache = this.roundTrendTableCache || {};
    this.roundTrendLoadedTableIds = this.roundTrendLoadedTableIds || {};
    if (this.roundTrendLoadedTableIds[tableId]) return;
    if (this.roundTrendLoadingId === tableId) return;
    this.roundTrendLoadingId = tableId;
    const tables = this.groupTrendTables || [];
    const currentTable = tables[tables.length - 1] || null;
    this.updateScoreTrends(tables, currentTable, currentTable && store.findMyPlayer(currentTable));
    store.getTable(tableId).then((table) => {
      if (!table) throw new Error('牌局不存在');
      this.roundTrendTableCache[tableId] = table;
      this.roundTrendLoadedTableIds[tableId] = true;
      if (this.roundTrendLoadingId === tableId) this.roundTrendLoadingId = null;
      if (this.selectedRoundTrendTableId !== tableId) return;
      const latestTables = this.groupTrendTables || [];
      const latestCurrent = latestTables[latestTables.length - 1] || table;
      this.updateScoreTrends(latestTables, latestCurrent, store.findMyPlayer(latestCurrent));
    }).catch((error) => {
      if (this.roundTrendLoadingId === tableId) this.roundTrendLoadingId = null;
      if (this.selectedRoundTrendTableId !== tableId) return;
      const latestTables = this.groupTrendTables || [];
      const latestCurrent = latestTables[latestTables.length - 1] || null;
      this.updateScoreTrends(latestTables, latestCurrent, latestCurrent && store.findMyPlayer(latestCurrent));
      wx.showToast({ title: error.message || '加载对局记录失败', icon: 'none' });
    });
  },

  buildRoundScoreTrend(table) {
    const colors = ['#12855a', '#d85645', '#4e82c8', '#8b6fd9', '#bf7c35', '#4b9f9b'];
    const players = (table.players || []).map((player, index) => ({
      id: player.id,
      name: player.name || `玩家${index + 1}`,
      color: player.avatarColor || colors[index % colors.length]
    }));
    const scores = {};
    players.forEach((player) => {
      scores[player.id] = 0;
    });
    const records = (table.records || [])
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => (
        record.type !== 'settlement' &&
        !record.revoked &&
        Number(record.amount) > 0 &&
        Object.prototype.hasOwnProperty.call(scores, record.fromPlayerId) &&
        Object.prototype.hasOwnProperty.call(scores, record.toPlayerId)
      ))
      .sort((left, right) => (
        (Number(left.record.createdAt) || 0) - (Number(right.record.createdAt) || 0) ||
        right.index - left.index
      ));
    const batches = [];
    records.forEach(({ record }) => {
      const createdAt = Number(record.createdAt) || 0;
      const previous = batches[batches.length - 1];
      if (!previous || createdAt - previous.createdAt > 30 * 1000) {
        batches.push({ records: [record], createdAt });
      } else {
        previous.records.push(record);
        previous.createdAt = createdAt;
      }
    });

    const points = [{ label: '开始', scores: { ...scores }, recordCount: 0 }];
    batches.forEach((batch, index) => {
      batch.records.forEach((record) => {
        const amount = Number(record.amount);
        scores[record.fromPlayerId] -= amount;
        scores[record.toPlayerId] += amount;
      });
      points.push({
        label: `第${index + 1}笔`,
        scores: { ...scores },
        recordCount: batch.records.length
      });
    });

    return {
      showRoundTrend: points.length > 1,
      roundTrendPlayers: players,
      roundTrendLabels: points.map((point) => point.label),
      roundTrendRecordCounts: points.map((point) => point.recordCount),
      roundTrendSeries: players.map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        values: points.map((point) => Number(point.scores[player.id]) || 0)
      }))
    };
  },

  buildScoreTrends(tables, myPlayer) {
    const settledTables = (tables || [])
      .filter((table) => table.settlement && (table.settlement.finalScores || []).length)
      .sort((left, right) => (
        (Number(left.roundNo) || 1) - (Number(right.roundNo) || 1) ||
        (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0)
      ));
    if (!settledTables.length) {
      return {
        showScoreTrends: false,
        showMyScoreTrend: false,
        myTrendName: '',
        allTrendPlayers: [],
        trendLabels: [],
        trendRecordCounts: [],
        myTrendSeries: [],
        allTrendSeries: []
      };
    }

    const colors = ['#12855a', '#d85645', '#4e82c8', '#8b6fd9', '#bf7c35', '#4b9f9b'];
    const playerMap = {};
    const tableScores = {};
    const trendRecordCounts = {};
    settledTables.forEach((table) => {
      const playersById = (table.players || []).reduce((map, player) => {
        map[player.id] = player;
        return map;
      }, {});
      const scores = {};
      (table.settlement.finalScores || []).forEach((score) => {
        const player = playersById[score.playerId] || {};
        const id = score.groupPlayerId || player.groupPlayerId || player.openid || score.playerId;
        if (!id) return;
        if (!playerMap[id]) {
          playerMap[id] = {
            id,
            name: score.name || player.name || '玩家',
            color: player.avatarColor || colors[Object.keys(playerMap).length % colors.length]
          };
        }
        const finalScore = Number(score.finalScore);
        scores[id] = Number.isFinite(finalScore) ? finalScore : (Number(score.rawScore) || 0);
      });
      tableScores[table.id] = scores;
      trendRecordCounts[table.id] = (table.records || []).filter((record) => (
        record.type !== 'settlement' && !record.revoked && Number(record.amount) > 0
      )).length;
    });

    const allSeries = Object.values(playerMap).map((player) => {
      let total = 0;
      return {
        ...player,
        values: settledTables.map((table) => {
          total += Number(tableScores[table.id][player.id]) || 0;
          return total;
        })
      };
    });
    const myId = myPlayer && (myPlayer.groupPlayerId || myPlayer.openid || myPlayer.id);
    const mySeries = allSeries.find((series) => series.id === myId)
      || allSeries.find((series) => series.name === (myPlayer && myPlayer.name))
      || null;

    return {
      showScoreTrends: allSeries.length > 0,
      showMyScoreTrend: !!mySeries,
      myTrendName: mySeries ? mySeries.name : '',
      allTrendPlayers: allSeries.map((series) => ({
        id: series.id,
        name: series.name,
        color: series.color
      })),
      trendLabels: settledTables.map((table) => `第${Number(table.roundNo) || 1}局`),
      trendRecordCounts: settledTables.map((table) => trendRecordCounts[table.id] || 0),
      myTrendSeries: mySeries ? [mySeries] : [],
      allTrendSeries: allSeries
    };
  },

  roundBatchWinners(table) {
    const playerIds = {};
    (table.players || []).forEach((player) => {
      playerIds[player.id] = true;
    });
    const records = (table.records || [])
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => (
        record.type !== 'settlement' &&
        !record.revoked &&
        Number(record.amount) > 0 &&
        playerIds[record.fromPlayerId] &&
        playerIds[record.toPlayerId]
      ))
      .sort((left, right) => (
        (Number(left.record.createdAt) || 0) - (Number(right.record.createdAt) || 0) ||
        right.index - left.index
      ));
    const batches = [];
    records.forEach(({ record }) => {
      const createdAt = Number(record.createdAt) || 0;
      const previous = batches[batches.length - 1];
      if (!previous || createdAt - previous.createdAt > 30 * 1000) {
        batches.push({ records: [record], createdAt });
      } else {
        previous.records.push(record);
        previous.createdAt = createdAt;
      }
    });
    return batches.map((batch) => {
      const net = {};
      batch.records.forEach((record) => {
        const amount = Number(record.amount);
        net[record.fromPlayerId] = (net[record.fromPlayerId] || 0) - amount;
        net[record.toPlayerId] = (net[record.toPlayerId] || 0) + amount;
      });
      let winnerId = '';
      let bestNet = 0;
      Object.keys(net).forEach((playerId) => {
        if (net[playerId] > bestNet) {
          bestNet = net[playerId];
          winnerId = playerId;
        }
      });
      return winnerId;
    });
  },

  buildRoundWinTrend(table) {
    const colors = ['#12855a', '#d85645', '#4e82c8', '#8b6fd9', '#bf7c35', '#4b9f9b'];
    const players = (table.players || []).map((player, index) => ({
      id: player.id,
      name: player.name || `玩家${index + 1}`,
      color: player.avatarColor || colors[index % colors.length]
    }));
    const wins = {};
    players.forEach((player) => {
      wins[player.id] = 0;
    });
    const points = [{ label: '开始', wins: { ...wins } }];
    this.roundBatchWinners(table).forEach((winnerId, index) => {
      if (winnerId) wins[winnerId] += 1;
      points.push({ label: `第${index + 1}轮`, wins: { ...wins } });
    });

    return {
      showRoundWinTrend: points.length > 1,
      roundWinPlayers: players,
      roundWinLabels: points.map((point) => point.label),
      roundWinSeries: players.map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        values: points.map((point) => Number(point.wins[player.id]) || 0)
      }))
    };
  },

  buildGroupWinTrend(tables) {
    const colors = ['#12855a', '#d85645', '#4e82c8', '#8b6fd9', '#bf7c35', '#4b9f9b'];
    const playerMap = {};
    const wins = {};
    (tables || []).forEach((table) => {
      (table.players || []).forEach((player) => {
        const id = player.groupPlayerId || player.openid || player.id;
        if (!id) return;
        if (!playerMap[id]) {
          playerMap[id] = {
            id,
            name: player.name || '玩家',
            color: player.avatarColor || colors[Object.keys(playerMap).length % colors.length]
          };
          wins[id] = 0;
        }
      });
    });
    const points = [];
    (tables || []).forEach((table) => {
      const idByTablePlayer = {};
      (table.players || []).forEach((player) => {
        idByTablePlayer[player.id] = player.groupPlayerId || player.openid || player.id;
      });
      this.roundBatchWinners(table).forEach((winnerId) => {
        const id = idByTablePlayer[winnerId];
        if (id && Object.prototype.hasOwnProperty.call(wins, id)) wins[id] += 1;
      });
      points.push({
        label: `第${Number(table.roundNo) || 1}局`,
        wins: { ...wins }
      });
    });
    const players = Object.values(playerMap);
    return {
      showGroupWinTrend: points.length > 0 && players.length > 0,
      groupWinPlayers: players,
      groupWinLabels: points.map((point) => point.label),
      groupWinSeries: players.map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        values: points.map((point) => Number(point.wins[player.id]) || 0)
      }))
    };
  },

  drawScoreTrends(trends) {
    if (trends.showScoreTrends) {
      this.drawTrendChart('my-score-chart', trends.trendLabels, trends.myTrendSeries, trends.trendRecordCounts);
      this.drawTrendChart('all-score-chart', trends.trendLabels, trends.allTrendSeries, trends.trendRecordCounts);
    }
    if (trends.showRoundTrend) {
      this.drawTrendChart('round-score-chart', trends.roundTrendLabels, trends.roundTrendSeries, trends.roundTrendRecordCounts);
    }
    if (trends.showRoundWinTrend) {
      this.drawTrendChart('round-win-chart', trends.roundWinLabels, trends.roundWinSeries, [], { integerAxis: true });
    }
    if (trends.showGroupWinTrend) {
      this.drawTrendChart('group-win-chart', trends.groupWinLabels, trends.groupWinSeries, [], { integerAxis: true });
    }
  },

  drawTrendChart(canvasId, labels, series, recordCounts = [], options = {}) {
    if (!labels.length || !series.length) return;
    const query = wx.createSelectorQuery();
    query.select(`#${canvasId}`).fields({ node: true, size: true }).exec((result) => {
      const canvasInfo = result && result[0];
      if (!canvasInfo || !canvasInfo.node || !canvasInfo.width || !canvasInfo.height) return;
      const canvas = canvasInfo.node;
      const context = canvas.getContext('2d');
      const width = canvasInfo.width;
      const height = canvasInfo.height;
      const pixelRatio = wx.getSystemInfoSync().pixelRatio || 1;
      canvas.width = width * pixelRatio;
      canvas.height = height * pixelRatio;
      context.scale(pixelRatio, pixelRatio);
      context.clearRect(0, 0, width, height);

      const margin = { top: 18, right: 16, bottom: 38, left: 62 };
      const chartWidth = Math.max(1, width - margin.left - margin.right);
      const chartHeight = Math.max(1, height - margin.top - margin.bottom);
      const values = series.reduce((items, item) => items.concat(item.values), [0]);
      let domainMin;
      let domainMax;
      let tickValues;
      if (options.integerAxis) {
        const maxValue = Math.max(0, ...values);
        const step = maxValue <= 9 ? 1 : Math.ceil(maxValue / 8);
        domainMin = 0;
        domainMax = Math.max(step, Math.ceil((maxValue + 1) / step) * step);
        tickValues = [];
        for (let value = 0; value <= domainMax; value += step) tickValues.push(value);
      } else {
        const minValue = Math.min(...values);
        const maxValue = Math.max(...values);
        const valueRange = Math.max(1, maxValue - minValue);
        const padding = Math.max(1, valueRange * 0.16);
        domainMin = minValue - padding;
        domainMax = maxValue + padding;
        tickValues = [];
        for (let tick = 0; tick <= 4; tick += 1) {
          tickValues.push(domainMax - (domainMax - domainMin) * (tick / 4));
        }
      }
      const domainRange = domainMax - domainMin;
      const xAt = (index) => labels.length <= 1
        ? margin.left + chartWidth / 2
        : margin.left + (chartWidth * index) / (labels.length - 1);
      const yAt = (value) => margin.top + ((domainMax - value) / domainRange) * chartHeight;
      const formatScore = (value) => {
        const rounded = Math.round(value * 10) / 10;
        return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
      };

      context.font = '11px sans-serif';
      context.lineWidth = 1;
      tickValues.forEach((value) => {
        const y = yAt(value);
        context.strokeStyle = '#e7ece8';
        context.beginPath();
        context.moveTo(margin.left, y);
        context.lineTo(width - margin.right, y);
        context.stroke();
        context.fillStyle = '#829087';
        context.textAlign = 'right';
        context.textBaseline = 'middle';
        context.fillText(formatScore(value), margin.left - 8, y);
      });

      const zeroY = yAt(0);
      if (zeroY >= margin.top && zeroY <= margin.top + chartHeight) {
        context.strokeStyle = '#b9c4be';
        context.setLineDash([4, 4]);
        context.beginPath();
        context.moveTo(margin.left, zeroY);
        context.lineTo(width - margin.right, zeroY);
        context.stroke();
        context.setLineDash([]);
      }

      series.forEach((item) => {
        context.strokeStyle = item.color;
        context.lineWidth = 2.5;
        context.lineJoin = 'round';
        context.lineCap = 'round';
        context.beginPath();
        item.values.forEach((value, index) => {
          const x = xAt(index);
          const y = yAt(value);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.stroke();
      });

      context.fillStyle = '#829087';
      context.textAlign = 'center';
      context.textBaseline = 'top';
      const labelCount = Math.min(5, labels.length);
      for (let labelIndex = 0; labelIndex < labelCount; labelIndex += 1) {
        const index = labelCount <= 1
          ? 0
          : Math.round(labelIndex * (labels.length - 1) / (labelCount - 1));
        context.fillText(labels[index], xAt(index), height - margin.bottom + 14);
      }

      this.trendChartMeta = this.trendChartMeta || {};
      this.trendChartMeta[canvasId] = { labels, series, recordCounts, options, margin, chartWidth, xAt };
      const selectedIndex = this.trendSelectedIndexes && this.trendSelectedIndexes[canvasId];
      if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < labels.length) {
        this.drawTrendTooltip(
          context,
          width,
          margin,
          xAt(selectedIndex),
          labels[selectedIndex],
          series,
          selectedIndex,
          recordCounts[selectedIndex]
        );
      }
    });
  },

  drawTrendTooltip(context, width, margin, selectedX, label, series, selectedIndex, recordCount) {
    const boxWidth = Math.min(188, width - 20);
    const hasRecordCount = Number(recordCount) > 0;
    const detailOffset = hasRecordCount ? 18 : 0;
    const boxHeight = 28 + detailOffset + series.length * 18;
    const boxX = selectedX + boxWidth + 8 > width ? width - boxWidth - 10 : selectedX + 8;
    const boxY = margin.top + 4;
    context.strokeStyle = '#aab7af';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(selectedX, margin.top);
    context.lineTo(selectedX, boxY + boxHeight + 8);
    context.stroke();
    context.fillStyle = 'rgba(31, 42, 36, 0.94)';
    context.fillRect(boxX, boxY, boxWidth, boxHeight);
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.font = '12px sans-serif';
    context.fillStyle = '#ffffff';
    context.fillText(label, boxX + 10, boxY + 18);
    if (hasRecordCount) {
      context.fillStyle = '#b9c8bf';
      context.font = '10px sans-serif';
      context.fillText(`${recordCount}次给分`, boxX + 10, boxY + 36);
    }
    context.font = '12px sans-serif';
    series.forEach((item, index) => {
      const value = item.values[selectedIndex];
      context.fillStyle = item.color;
      context.fillText(`${item.name}: ${this.formatTrendScore(value)}`, boxX + 10, boxY + 36 + detailOffset + index * 18);
    });
  },

  formatTrendScore(value) {
    const rounded = Math.round((Number(value) || 0) * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  },

  onTrendTouchStart(event) {
    const chartId = event.currentTarget.dataset.chartId;
    const touch = this.getTrendTouch(event);
    if (!chartId || !touch) return;
    this.clearTrendTouchTimers();
    this.trendTouchState = { chartId, startX: touch.x, dragging: false };
    this.trendLongPressTimer = setTimeout(() => {
      if (!this.trendTouchState || this.trendTouchState.chartId !== chartId) return;
      this.trendTouchState.dragging = true;
      this.selectTrendPoint(chartId, this.trendTouchState.startX);
    }, 350);
  },

  onTrendLongPress(event) {
    const chartId = event.currentTarget.dataset.chartId;
    const touch = this.getTrendTouch(event);
    if (!chartId || !touch) return;
    if (this.trendLongPressTimer) clearTimeout(this.trendLongPressTimer);
    this.trendLongPressTimer = null;
    this.trendTouchState = { chartId, startX: touch.x, dragging: true };
    this.selectTrendPoint(chartId, touch.x);
  },

  onTrendTouchMove(event) {
    const touch = this.getTrendTouch(event);
    const state = this.trendTouchState;
    if (!touch || !state || !state.dragging) return;
    this.selectTrendPoint(state.chartId, touch.x);
  },

  onTrendTouchEnd() {
    const wasSelecting = !!(this.trendTouchState && this.trendTouchState.dragging);
    this.clearTrendTouchTimers();
    // Prevent the synthetic tap emitted when a long press is released from clearing its tooltip.
    if (wasSelecting) this.trendTapSuppressedUntil = Date.now() + 250;
  },

  keepTrendSelection() {},

  getTrendTouch(event) {
    const touch = (event.touches || event.changedTouches || [])[0];
    if (!touch) return null;
    return { x: Number(touch.x) || 0 };
  },

  selectTrendPoint(chartId, x) {
    const meta = this.trendChartMeta && this.trendChartMeta[chartId];
    if (!meta || !meta.labels.length) return;
    const ratio = meta.labels.length <= 1 ? 0 : (x - meta.margin.left) / meta.chartWidth;
    const index = Math.max(0, Math.min(meta.labels.length - 1, Math.round(ratio * (meta.labels.length - 1))));
    this.trendSelectedIndexes = this.trendSelectedIndexes || {};
    if (this.trendSelectedIndexes[chartId] === index) return;
    this.trendSelectedIndexes[chartId] = index;
    this.queueTrendRender(chartId);
  },

  queueTrendRender(chartId) {
    this.trendPendingChartIds = this.trendPendingChartIds || {};
    this.trendPendingChartIds[chartId] = true;
    if (this.trendRenderTimer) return;
    this.trendRenderTimer = setTimeout(() => {
      this.trendRenderTimer = null;
      const pendingChartIds = Object.keys(this.trendPendingChartIds || {});
      this.trendPendingChartIds = {};
      pendingChartIds.forEach((id) => {
        const meta = this.trendChartMeta && this.trendChartMeta[id];
        if (meta) this.drawTrendChart(id, meta.labels, meta.series, meta.recordCounts, meta.options);
      });
    }, 16);
  },

  clearTrendSelection() {
    if (Date.now() < (this.trendTapSuppressedUntil || 0)) return;
    this.clearTrendTouchTimers();
    if (!this.trendSelectedIndexes || !Object.keys(this.trendSelectedIndexes).length) return;
    this.clearTrendRenderTimer();
    const selectedChartIds = Object.keys(this.trendSelectedIndexes);
    this.trendSelectedIndexes = {};
    selectedChartIds.forEach((chartId) => {
      const meta = this.trendChartMeta && this.trendChartMeta[chartId];
      if (meta) this.drawTrendChart(chartId, meta.labels, meta.series, meta.recordCounts, meta.options);
    });
  },

  clearTrendTouchTimers() {
    if (this.trendLongPressTimer) clearTimeout(this.trendLongPressTimer);
    this.trendLongPressTimer = null;
    this.trendTouchState = null;
  },

  clearTrendRenderTimer() {
    if (this.trendRenderTimer) clearTimeout(this.trendRenderTimer);
    this.trendRenderTimer = null;
    this.trendPendingChartIds = {};
  },

  openRound(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/room/room?id=${id}`,
      fail: (error) => {
        console.error('[group-detail openRound error]', error);
        wx.showToast({ title: '暂时无法进入该对局', icon: 'none' });
      }
    });
  }
});
