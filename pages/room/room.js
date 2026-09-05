const store = require('../../services/store');

const NOTICE_RECENT_WINDOW = 2 * 60 * 1000;
const NOTICE_TOAST_DURATION = 3000;
const TABLE_POLL_INTERVAL = 3000;

Page({
  data: {
    tableId: '',
    table: null,
    players: [],
    myPlayer: null,
    canGive: false,
    keypadVisible: false,
    settlementVisible: false,
    settlementMode: 'table',
    settlementTitle: '结算本局',
    settlementSubtitle: '请输入倍率后结算本局积分',
    settlementConfirmText: '结算',
    targetPlayer: null,
    inputValue: '',
    keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '取消', '0', '确认'],
    endInputValue: '',
    mode: 'unknown',
    inviteVisible: false,
    inviteCodeImage: '',
    inviteLoading: false,
    pendingAutoInvite: false,
    pendingAutoJoin: false,
    tableWatcher: null,
    notices: [],
    noticeToasts: [],
    settlementPlayers: [],
    settlementMultiplier: '',
    finalScores: [],
    groupSettlement: null,
    showScoreTrends: false,
    myTrendName: '',
    allTrendPlayers: [],
    roundTrendTables: [],
    selectedRoundTrendTableId: '',
    showRoundTrend: false,
    roundTrendPlayers: [],
    roundTrendLoading: false,
    canStartNextRound: false,
    canSettleGroup: false,
    canSettleTable: false,
    tablePendingSettlement: false,
    scoreSaving: false,
    undoSaving: false
  },

  async onLoad(options) {
    this.noticeToastTimers = {};
    this.avatarDisplayCache = {};
    this.failedAvatarKeys = {};
    this.avatarRetryCounts = {};
    await store.ensureMe();
    this.setData({
      mode: store.getStoredMode(),
      pendingAutoInvite: options.autoInvite === '1',
      pendingAutoJoin: options.autoJoin === '1'
    });
    const tableId = options.id || '';
    const shareCode = options.shareCode || options.scene || '';
    if (shareCode) {
      this.setData({ pendingAutoJoin: true });
    }
    if (tableId) {
      this.setData({ tableId });
      this.loadTable();
      this.startWatching();
      this.startPolling();
      return;
    }
    if (shareCode) {
      const parsedShareCode = decodeURIComponent(shareCode).replace(/^shareCode=/, '');
      this.resolveShareCode(parsedShareCode);
    }
  },

  async onShow() {
    await store.ensureMe();
    this.setData({ mode: store.getStoredMode() });
    if (this.data.tableId) this.loadTable();
    this.startWatching();
    this.startPolling();
  },

  onHide() {
    this.stopWatching();
    this.stopPolling();
    this.clearNoticeToastTimer();
    this.clearTrendTouchTimers();
    this.clearTrendRenderTimer();
    this.setData({ noticeToasts: [] });
  },

  onUnload() {
    this.stopWatching();
    this.stopPolling();
    this.clearNoticeToastTimer();
    this.clearTrendTouchTimers();
    this.clearTrendRenderTimer();
    this.setData({ noticeToasts: [] });
  },

  onPullDownRefresh() {
    this.loadTable().finally(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {
    const table = this.data.table || {};
    return {
      title: `加入${table.name || '麻将计分桌'}`,
      path: `/pages/join/join?shareCode=${table.shareCode}`
    };
  },

  async resolveShareCode(shareCode) {
    const table = await store.getTableByShareCode(shareCode);
    if (!table) {
      wx.showToast({ title: '分享码无效', icon: 'none' });
      return;
    }
    this.setData({ tableId: table.id });
    this.setData({
      table,
      players: this.buildPlayers(table.players, table.settlement)
    });
    this.loadTable();
    this.startWatching();
    this.startPolling();
  },

  async loadTable() {
    const loadGeneration = this.tableLoadGeneration || 0;
    try {
      // A refresh must not read the pre-write snapshot while a score request is pending.
      if (this.givingScorePromise) {
        await this.givingScorePromise.catch(() => null);
      }
      const table = await store.getTable(this.data.tableId);
      if (!table) {
        wx.showToast({ title: '牌局不存在', icon: 'none' });
        return;
      }
      if (loadGeneration !== (this.tableLoadGeneration || 0)) return;
      this.applyTable(table);
    } catch (error) {
      if (!this.tablePollTimer) {
        wx.showToast({ title: error.message || '刷新失败', icon: 'none' });
      }
    }
  },

  applyTable(table) {
    const myPlayer = store.findMyPlayer(table);
    const players = this.buildPlayers(table.players, table.settlement);
    const targetPlayer = this.data.targetPlayer
      ? players.find((player) => player.id === this.data.targetPlayer.id) || this.data.targetPlayer
      : null;
    const settlement = table.settlement || null;
    const groupSettlement = table.groupSettlement || null;
    const isOwner = !!myPlayer && table.ownerOpenid === myPlayer.openid;
    const tablePendingSettlement = table.status === 'ended' && table.settlementStatus === 'pending';
    this.setData({
      table,
      players,
      targetPlayer,
      myPlayer,
      canGive: !!myPlayer && table.status === 'active',
      mode: store.getStoredMode(),
      settlementPlayers: settlement ? this.buildSettlementPlayers(settlement, table.players) : [],
      settlementMultiplier: settlement ? settlement.multiplier : '',
      finalScores: settlement ? settlement.finalScores || [] : [],
      groupSettlement,
      tablePendingSettlement,
      canStartNextRound: !!(
        table.status === 'ended' &&
        !groupSettlement &&
        table.groupStatus !== 'settled' &&
        (table.nextTableId || isOwner)
      ),
      canSettleGroup: !!(
        table.status === 'ended' &&
        isOwner &&
        !groupSettlement &&
        table.groupStatus !== 'settled'
      ),
      canSettleTable: !!(
        tablePendingSettlement &&
        isOwner &&
        !groupSettlement &&
        table.groupStatus !== 'settled'
      ),
      notices: (table.notifications || []).filter((item) => !myPlayer || !item.targetOpenid || item.targetOpenid === myPlayer.openid)
    });
    this.refreshScoreTrends(table, myPlayer);
    if (!myPlayer && this.data.pendingAutoJoin) {
      this.setData({ pendingAutoJoin: false });
      this.redirectToJoin();
      return;
    }
    this.showPendingNotice();
    if (this.data.pendingAutoInvite) {
      this.setData({ pendingAutoInvite: false });
      this.openInvite();
    }
    this.redirectToNextTableIfNeeded(table);
  },

  redirectToNextTableIfNeeded(table) {
    if (!table || !table.nextTableId) return;
    if (this.redirectingToNextTable) return;
    if (table.nextTableId === this.data.tableId) return;
    if (table.status !== 'ended') return;
    if (table.groupStatus === 'settled' || table.groupSettlement) return;
    this.redirectingToNextTable = true;
    this.stopWatching();
    wx.redirectTo({
      url: `/pages/room/room?id=${table.nextTableId}`,
      fail: () => {
        this.redirectingToNextTable = false;
        this.startWatching();
      }
    });
  },

  refreshScoreTrends(table, myPlayer) {
    this.roundTrendTableCache = this.roundTrendTableCache || {};
    this.roundTrendTableCache[table.id] = table;
    const groupId = table.groupId || table.id;
    const knownTables = (this.groupTrendTables || [])
      .filter((item) => (item.groupId || item.id) === groupId)
      .map((item) => (item.id === table.id ? table : item));
    if (!knownTables.some((item) => item.id === table.id)) knownTables.push(table);
    this.updateScoreTrends(knownTables, table, myPlayer);

    const refreshKey = [
      table.id,
      table.updatedAt,
      (table.records || []).length,
      table.settlement && table.settlement.settledAt,
      table.groupSettlement && table.groupSettlement.settledAt
    ].join(':');
    if (refreshKey === this.scoreTrendRefreshKey) return;
    this.scoreTrendRefreshKey = refreshKey;

    store.listTables()
      .then((tables) => {
        if (!this.data.table || this.data.table.id !== table.id) return;
        const currentTable = this.data.table;
        const currentGroupId = currentTable.groupId || currentTable.id;
        const groupTables = (tables || []).filter((item) => (item.groupId || item.id) === currentGroupId);
        const currentIndex = groupTables.findIndex((item) => item.id === currentTable.id);
        if (currentIndex >= 0) groupTables[currentIndex] = currentTable;
        else groupTables.push(currentTable);
        this.updateScoreTrends(groupTables, currentTable, this.data.myPlayer || myPlayer);
      })
      .catch(() => null);
  },

  updateScoreTrends(tables, currentTable, myPlayer) {
    const sortedTables = (tables || [])
      .filter((table) => table && table.id)
      .map((table) => (this.roundTrendTableCache && this.roundTrendTableCache[table.id]) || table)
      .sort((left, right) => (
        (Number(left.roundNo) || 1) - (Number(right.roundNo) || 1) ||
        (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0)
      ));
    this.groupTrendTables = sortedTables;

    let selectedTableId = this.selectedRoundTrendTableId;
    if (!sortedTables.some((table) => table.id === selectedTableId)) {
      selectedTableId = currentTable.id;
    }
    this.selectedRoundTrendTableId = selectedTableId;
    const selectedTable = sortedTables.find((table) => table.id === selectedTableId) || currentTable;
    const roundTrend = this.buildRoundScoreTrend(selectedTable);
    const groupTrends = this.buildScoreTrends(sortedTables, myPlayer);
    const trends = { ...groupTrends, ...roundTrend };

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
      roundTrendLoading: this.roundTrendLoadingId === selectedTableId
    }, () => this.drawScoreTrends(trends));
  },

  selectRoundTrend(event) {
    const tableId = event.currentTarget.dataset.id;
    if (!tableId || tableId === this.selectedRoundTrendTableId || !this.data.table) return;
    this.selectedRoundTrendTableId = tableId;
    this.roundTrendTableCache = this.roundTrendTableCache || {};
    if (this.roundTrendTableCache[tableId]) {
      this.updateScoreTrends(this.groupTrendTables || [this.data.table], this.data.table, this.data.myPlayer);
      return;
    }

    this.roundTrendLoadingId = tableId;
    this.updateScoreTrends(this.groupTrendTables || [this.data.table], this.data.table, this.data.myPlayer);
    store.getTable(tableId)
      .then((table) => {
        if (!table) throw new Error('牌局不存在');
        this.roundTrendTableCache[tableId] = table;
        if (this.roundTrendLoadingId === tableId) this.roundTrendLoadingId = null;
        this.updateScoreTrends(this.groupTrendTables || [this.data.table], this.data.table, this.data.myPlayer);
      })
      .catch((error) => {
        if (this.roundTrendLoadingId === tableId) this.roundTrendLoadingId = null;
        this.updateScoreTrends(this.groupTrendTables || [this.data.table], this.data.table, this.data.myPlayer);
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
      || allSeries[0];

    return {
      showScoreTrends: true,
      myTrendName: myPlayer ? mySeries.name : `${mySeries.name}（当前查看）`,
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

  drawScoreTrends(trends) {
    if (trends.showScoreTrends) {
      this.drawTrendChart('my-score-chart', trends.trendLabels, trends.myTrendSeries, trends.trendRecordCounts);
      this.drawTrendChart('all-score-chart', trends.trendLabels, trends.allTrendSeries, trends.trendRecordCounts);
    }
    if (trends.showRoundTrend) {
      this.drawTrendChart('round-score-chart', trends.roundTrendLabels, trends.roundTrendSeries, trends.roundTrendRecordCounts);
    }
  },

  drawTrendChart(canvasId, labels, series, recordCounts = []) {
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
      const minValue = Math.min(...values);
      const maxValue = Math.max(...values);
      const valueRange = Math.max(1, maxValue - minValue);
      const padding = Math.max(1, valueRange * 0.16);
      const domainMin = minValue - padding;
      const domainMax = maxValue + padding;
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
      for (let tick = 0; tick <= 4; tick += 1) {
        const ratio = tick / 4;
        const y = margin.top + chartHeight * ratio;
        const value = domainMax - domainRange * ratio;
        context.strokeStyle = '#e7ece8';
        context.beginPath();
        context.moveTo(margin.left, y);
        context.lineTo(width - margin.right, y);
        context.stroke();
        context.fillStyle = '#829087';
        context.textAlign = 'right';
        context.textBaseline = 'middle';
        context.fillText(formatScore(value), margin.left - 8, y);
      }

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
      this.trendChartMeta[canvasId] = { labels, series, recordCounts, margin, chartWidth, xAt };
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
        if (meta) this.drawTrendChart(id, meta.labels, meta.series, meta.recordCounts);
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
      if (meta) this.drawTrendChart(chartId, meta.labels, meta.series, meta.recordCounts);
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

  buildPlayers(players, settlement) {
    const settlementScores = ((settlement && settlement.finalScores) || []).reduce((map, item) => {
      map[item.playerId] = item.rawScore;
      return map;
    }, {});
    const playerList = (players || []).map((player) => ({
      ...player,
      rawScore: Number(Object.prototype.hasOwnProperty.call(settlementScores, player.id)
        ? settlementScores[player.id]
        : player.score) || 0
    }));
    const scores = playerList.map((player) => player.rawScore);
    const maxScore = scores.length ? Math.max(...scores) : 0;
    const minScore = scores.length ? Math.min(...scores) : 0;
    const hasWinnerAndLoser = playerList.length > 1 && maxScore !== minScore;
    this.avatarDisplayCache = this.avatarDisplayCache || {};
    this.failedAvatarKeys = this.failedAvatarKeys || {};

    return playerList.map((player) => {
      const score = player.rawScore;
      const scoreState = score > 0 ? 'win' : (score < 0 ? 'lose' : 'even');
      const avatarIdentity = player.avatarFileId || player.avatarUrl || '';
      const avatarCacheKey = `${player.id}:${avatarIdentity}`;
      const resolvedAvatarUrl = this.buildAvatarDisplayUrl(player.avatarUrl, player.avatarFileId);
      let avatarDisplayUrl = this.avatarDisplayCache[avatarCacheKey] || resolvedAvatarUrl;
      if (!this.avatarDisplayCache[avatarCacheKey] && avatarDisplayUrl) {
        this.avatarDisplayCache[avatarCacheKey] = avatarDisplayUrl;
      }
      const viewKey = `${player.id}_${avatarIdentity || 'avatar-empty'}`;
      return {
        ...player,
        initial: String(player.name || '').slice(0, 1),
        scoreState,
        scoreText: score > 0 ? `+${score}` : `${score}`,
        rankEmoji: hasWinnerAndLoser && score === maxScore ? '👑' : (hasWinnerAndLoser && score === minScore ? '🐶' : ''),
        avatarDisplayUrl,
        viewKey,
        avatarLoadFailed: !!this.failedAvatarKeys[viewKey]
      };
    });
  },

  buildAvatarDisplayUrl(avatarUrl, avatarFileId) {
    const value = String(avatarUrl || '');
    if (!value || /^cloud:\/\//.test(value)) return '';
    if (/^wxfile:\/\//.test(value) || /^https?:\/\/tmp\//.test(value)) return value;
    const version = avatarFileId || value;
    if (!version) return value;
    const separator = value.includes('?') ? '&' : '?';
    return `${value}${separator}v=${encodeURIComponent(version)}`;
  },

  onAvatarLoad(event) {
    const dataset = event.currentTarget.dataset || {};
    const viewKey = dataset.viewKey;
    if (viewKey && this.failedAvatarKeys && this.failedAvatarKeys[viewKey]) {
      delete this.failedAvatarKeys[viewKey];
    }
    const retryKey = dataset.avatarFileId || dataset.avatarUrl || viewKey;
    if (retryKey && this.avatarRetryCounts) {
      delete this.avatarRetryCounts[retryKey];
    }
  },

  onAvatarError(event) {
    const dataset = event.currentTarget.dataset || {};
    const viewKey = dataset.viewKey;
    const avatarFileId = dataset.avatarFileId;
    const avatarUrl = dataset.avatarUrl;
    if (viewKey) this.markAvatarLoadFailed(viewKey);
    this.retryAvatarLoad(avatarFileId || avatarUrl || viewKey, avatarFileId, viewKey, dataset.id);
  },

  markAvatarLoadFailed(viewKey) {
    this.failedAvatarKeys = this.failedAvatarKeys || {};
    this.failedAvatarKeys[viewKey] = true;
    const players = (this.data.players || []).map((player) => (
      player.viewKey === viewKey ? { ...player, avatarLoadFailed: true } : player
    ));
    const targetPlayer = this.data.targetPlayer && this.data.targetPlayer.viewKey === viewKey
      ? { ...this.data.targetPlayer, avatarLoadFailed: true }
      : this.data.targetPlayer;
    this.setData({ players, targetPlayer });
  },

  retryAvatarLoad(retryKey, avatarFileId, viewKey, playerId) {
    if (!retryKey) return;
    this.avatarRetryCounts = this.avatarRetryCounts || {};
    const retryCount = this.avatarRetryCounts[retryKey] || 0;
    if (retryCount >= 1) return;
    this.avatarRetryCounts[retryKey] = retryCount + 1;
    if (this.avatarDisplayCache) {
      Object.keys(this.avatarDisplayCache).forEach((key) => {
        if (playerId && key.indexOf(`${playerId}:`) === 0) delete this.avatarDisplayCache[key];
      });
    }
    if (avatarFileId && store.clearAvatarUrlCache) {
      store.clearAvatarUrlCache(avatarFileId);
    }
    setTimeout(() => {
      if (viewKey && this.failedAvatarKeys) delete this.failedAvatarKeys[viewKey];
      if (this.data.tableId) this.loadTable();
    }, 250);
  },

  startWatching() {
    this.stopWatching();
    if (!this.data.tableId || store.getStoredMode() !== 'cloud' || !wx.cloud || !wx.cloud.database) return;
    try {
      const db = wx.cloud.database();
      this.tableWatcher = db.collection('tables').doc(this.data.tableId).watch({
        onChange: async (snapshot) => {
          const rawTable = snapshot && snapshot.docs && snapshot.docs[0];
          if (!rawTable) return;
          const table = await store.normalizeTable(rawTable);
          this.applyTable(table);
        },
        onError: () => {
          this.stopWatching();
        }
      });
    } catch (error) {
      this.stopWatching();
    }
  },

  startPolling() {
    this.stopPolling();
    if (!this.data.tableId) return;
    this.tablePollTimer = setInterval(() => {
      if (!this.data.tableId || this.redirectingToNextTable) return;
      this.loadTable();
    }, TABLE_POLL_INTERVAL);
  },

  stopPolling() {
    if (this.tablePollTimer) {
      clearInterval(this.tablePollTimer);
    }
    this.tablePollTimer = null;
  },

  stopWatching() {
    if (this.tableWatcher && typeof this.tableWatcher.close === 'function') {
      this.tableWatcher.close();
    }
    this.tableWatcher = null;
  },

  showPendingNotice() {
    const notices = this.data.notices || [];
    const now = Date.now();
    const unreadList = notices.filter((item) => (
      now - (Number(item.createdAt) || 0) <= NOTICE_RECENT_WINDOW &&
      !store.isNoticeSeen(this.data.tableId, item.id)
    )).reverse();
    if (!unreadList.length) return;
    const toasts = unreadList.map((notice) => {
      store.markNoticeSeen(this.data.tableId, notice.id);
      return {
        id: notice.id,
        text: this.formatNoticeText(notice)
      };
    });
    this.appendNoticeToasts(toasts);
    this.setData({ notices });
  },

  appendNoticeToasts(toasts) {
    if (!toasts || !toasts.length) return;
    this.setData({
      noticeToasts: [...this.data.noticeToasts, ...toasts]
    });
    toasts.forEach((toast) => {
      this.clearNoticeToastTimer(toast.id);
      this.noticeToastTimers[toast.id] = setTimeout(() => {
        this.closeNotice({ currentTarget: { dataset: { id: toast.id } } });
      }, NOTICE_TOAST_DURATION);
    });
  },

  formatNoticeText(notice) {
    if (notice.type === 'score') {
      return `收到 ${notice.fromPlayerName || '玩家'} 的 ${notice.amount} 分`;
    }
    if (notice.type === 'undo') {
      return notice.content || `${notice.fromPlayerName || '玩家'} 撤销了 ${notice.amount} 分`;
    }
    return notice.content || notice.title || '有新的牌局消息';
  },

  closeNotice(event) {
    const id = event && event.currentTarget && event.currentTarget.dataset.id;
    if (id) {
      this.clearNoticeToastTimer(id);
      this.setData({
        noticeToasts: this.data.noticeToasts.filter((item) => item.id !== id)
      });
      return;
    }
    this.clearNoticeToastTimer();
    this.setData({
      noticeToasts: []
    });
  },

  clearNoticeToastTimer(id) {
    this.noticeToastTimers = this.noticeToastTimers || {};
    if (id) {
      if (this.noticeToastTimers[id]) {
        clearTimeout(this.noticeToastTimers[id]);
        delete this.noticeToastTimers[id];
      }
      return;
    }
    Object.keys(this.noticeToastTimers || {}).forEach((timerId) => {
      clearTimeout(this.noticeToastTimers[timerId]);
    });
    this.noticeToastTimers = {};
  },

  openJoin() {
    wx.navigateTo({
      url: `/pages/join/join?id=${this.data.tableId}`
    });
  },

  redirectToJoin() {
    if (!this.data.tableId || this.redirectingToJoin) return;
    this.redirectingToJoin = true;
    this.stopWatching();
    this.stopPolling();
    wx.redirectTo({
      url: `/pages/join/join?id=${this.data.tableId}`,
      fail: () => {
        this.redirectingToJoin = false;
        this.startWatching();
        this.startPolling();
      }
    });
  },

  async openInvite() {
    if (!this.data.table || !this.data.table.shareCode) return;
    await store.ensureMe();
    this.setData({ mode: store.getStoredMode() });
    if (store.getStoredMode() !== 'cloud') {
      wx.showToast({
        title: '云端不可用，请检查云开发配置',
        icon: 'none'
      });
      return;
    }
    this.setData({
      inviteVisible: true,
      inviteLoading: true
    });
    try {
      const inviteCodeImage = await store.getTableCode(this.data.table.shareCode);
      this.setData({
        inviteCodeImage,
        inviteLoading: false
      });
    } catch (error) {
      this.setData({ inviteLoading: false });
      wx.showToast({
        title: error.message || '二维码生成失败',
        icon: 'none'
      });
    }
  },

  closeInvite() {
    this.setData({
      inviteVisible: false
    });
    this.loadTable();
    wx.showToast({ title: '已刷新', icon: 'none' });
  },

  openDetail() {
    wx.navigateTo({
      url: `/pages/detail/detail?id=${this.data.tableId}`
    });
  },

  goBack() {
    wx.redirectTo({
      url: '/pages/home/home'
    });
  },

  async toggleMuted() {
    await store.toggleMuted(this.data.tableId);
    this.loadTable();
  },

  async refreshTable() {
    await this.loadTable();
    wx.showToast({ title: '已刷新', icon: 'none' });
  },

  showOperationError(error, fallbackTitle) {
    const message = (error && error.message) || fallbackTitle || '操作失败';
    if (message.includes('云函数 tableOps 未更新')) {
      wx.showModal({
        title: '云函数未更新',
        content: '请在微信开发者工具中上传并部署 cloudfunctions/tableOps 后重试。',
        showCancel: false
      });
      return;
    }
    wx.showToast({ title: message, icon: 'none' });
  },

  showMore() {
    wx.showActionSheet({
      itemList: ['复制分享码', '编辑我的资料'],
      success: async (res) => {
        if (res.tapIndex === 0) {
          wx.setClipboardData({ data: this.data.table.shareCode });
        }
        if (res.tapIndex === 1) {
          this.openJoin();
        }
      }
    });
  },

  openSettlementDialog() {
    wx.showActionSheet({
      itemList: ['结束本次对局', '结算所有对局'],
      success: (res) => {
        if (res.tapIndex === 0) this.endCurrentTable();
        if (res.tapIndex === 1) this.openSettlementInput('group');
      }
    });
  },

  openSettlementInput(modeOrEvent) {
    const mode = modeOrEvent && modeOrEvent.currentTarget
      ? modeOrEvent.currentTarget.dataset.mode
      : modeOrEvent;
    const isGroupMode = mode === 'group';
    this.setData({
      settlementVisible: true,
      settlementMode: isGroupMode ? 'group' : 'table',
      settlementTitle: isGroupMode ? '结算所有对局' : '结算本局',
      settlementSubtitle: isGroupMode
        ? '请输入倍率后汇总所有待结算对局'
        : '请输入倍率后结算本局积分',
      settlementConfirmText: isGroupMode ? '总结算' : '结算',
      endInputValue: '0.3'
    });
  },

  closeSettlement() {
    this.setData({
      settlementVisible: false,
      settlementMode: 'table',
      endInputValue: ''
    });
  },

  onEndInput(event) {
    this.setData({
      endInputValue: event.detail.value
    });
  },

  async confirmEndTable() {
    const multiplier = Number(String(this.data.endInputValue || '').trim());
    if (!multiplier || multiplier <= 0) {
      wx.showToast({ title: '请输入有效倍率', icon: 'none' });
      return;
    }
    try {
      const table = this.data.settlementMode === 'group'
        ? await store.settleGroup(this.data.tableId, multiplier)
        : await store.settleTable(this.data.tableId, multiplier);
      this.closeSettlement();
      if (table) {
        this.applyTable(table);
      } else {
        this.loadTable();
      }
    } catch (error) {
      this.showOperationError(error, '结算失败');
    }
  },

  async endCurrentTable() {
    try {
      wx.showLoading({ title: '结束中' });
      const table = await store.endTable(this.data.tableId);
      wx.hideLoading();
      if (table) {
        this.applyTable(table);
      } else {
        this.loadTable();
      }
    } catch (error) {
      wx.hideLoading();
      this.showOperationError(error, '结束失败');
    }
  },

  async startNextRound() {
    const table = this.data.table || {};
    if (table.nextTableId) {
      this.redirectingToNextTable = true;
      wx.redirectTo({
        url: `/pages/room/room?id=${table.nextTableId}`,
        fail: () => {
          this.redirectingToNextTable = false;
        }
      });
      return;
    }
    try {
      this.redirectingToNextTable = true;
      wx.showLoading({ title: '创建中' });
      const nextTable = await store.startNextTable(this.data.tableId);
      wx.hideLoading();
      wx.redirectTo({
        url: `/pages/room/room?id=${nextTable.id}`,
        fail: () => {
          this.redirectingToNextTable = false;
        }
      });
    } catch (error) {
      wx.hideLoading();
      this.redirectingToNextTable = false;
      this.showOperationError(error, '开启下一局失败');
    }
  },

  buildSettlementPlayers(settlement, players) {
    const scoreMap = (settlement.finalScores || []).reduce((map, item) => {
      map[item.playerId] = item;
      return map;
    }, {});
    return players.map((player) => {
      const found = scoreMap[player.id] || {};
      return {
        ...player,
        rawScore: found.rawScore ?? player.score,
        finalScore: found.finalScore ?? player.score
      };
    });
  },

  openKeypad(event) {
    const id = event.currentTarget.dataset.id;
    const targetPlayer = this.data.players.find((player) => player.id === id);
    this.setData({
      targetPlayer,
      keypadVisible: true,
      inputValue: ''
    });
  },

  async undoLastGive(event) {
    const toPlayerId = event.currentTarget.dataset.id;
    const targetPlayer = this.data.players.find((player) => player.id === toPlayerId) || {};
    const record = ((this.data.table && this.data.table.records) || []).find((item) => (
      !item.revoked &&
      item.operatorOpenid === this.data.myPlayer.openid &&
      item.fromPlayerId === this.data.myPlayer.id &&
      item.toPlayerId === toPlayerId
    ));
    const confirmRes = await new Promise((resolve) => {
      wx.showModal({
        title: '确认撤销',
        content: record && record.amount
          ? `确定撤销给 ${targetPlayer.name || '玩家'} 的 ${record.amount} 分吗？`
          : `确定撤销给 ${targetPlayer.name || '玩家'} 的上次计分吗？`,
        confirmText: '撤销',
        confirmColor: '#d94f45',
        cancelText: '取消',
        success: resolve,
        fail: () => resolve({ confirm: false })
      });
    });
    if (!confirmRes.confirm) return;

    this.setData({ undoSaving: true });
    try {
      const table = await store.undoLastGive(
        this.data.tableId,
        this.data.myPlayer.id,
        toPlayerId
      );
      this.applyTable(table);
      this.appendNoticeToasts([{
        id: `undo_${Date.now()}_${toPlayerId}`,
        text: record && record.amount
          ? `已撤销给 ${targetPlayer.name || '玩家'} 的 ${record.amount} 分`
          : `已撤销给 ${targetPlayer.name || '玩家'} 的计分`
      }]);
    } catch (error) {
      wx.showToast({ title: error.message || '撤销失败', icon: 'none' });
    } finally {
      this.setData({ undoSaving: false });
    }
  },

  closeKeypad() {
    this.setData({
      keypadVisible: false,
      targetPlayer: null,
      inputValue: ''
    });
  },

  clearInput() {
    this.setData({
      inputValue: this.data.inputValue.slice(0, -1)
    });
  },

  tapKey(event) {
    const key = event.currentTarget.dataset.key;
    if (key === '取消') {
      this.closeKeypad();
      return;
    }
    if (key === '确认') {
      this.confirmGive();
      return;
    }
    if (this.data.inputValue.length >= 6) return;
    if (key === '0' && !this.data.inputValue) return;
    this.setData({
      inputValue: `${this.data.inputValue}${key}`
    });
  },

  buildOptimisticGiveTable(table, fromPlayerId, toPlayerId, amount) {
    if (!table) return null;
    const value = Number(amount);
    const players = (table.players || []).map((player) => ({ ...player }));
    const fromPlayer = players.find((player) => player.id === fromPlayerId);
    const toPlayer = players.find((player) => player.id === toPlayerId);
    if (!fromPlayer || !toPlayer) return null;

    fromPlayer.score = (Number(fromPlayer.score) || 0) - value;
    toPlayer.score = (Number(toPlayer.score) || 0) + value;

    return {
      ...table,
      players,
      updatedAt: Date.now(),
      records: [{
        id: `optimistic_${Date.now()}_${toPlayerId}`,
        fromPlayerId,
        fromPlayerName: fromPlayer.name,
        toPlayerId,
        toPlayerName: toPlayer.name,
        amount: value,
        operatorOpenid: this.data.myPlayer && this.data.myPlayer.openid,
        createdAt: Date.now(),
        revoked: false
      }, ...((table.records || []).map((record) => ({ ...record })))]
    };
  },

  async confirmGive() {
    if (this.givingScore) return;
    const amount = Number(this.data.inputValue);
    if (!amount) {
      wx.showToast({ title: '请输入分数', icon: 'none' });
      return;
    }
    const previousTable = this.data.table;
    const targetPlayer = this.data.targetPlayer;
    const myPlayer = this.data.myPlayer;
    if (!targetPlayer || !myPlayer) {
      wx.showToast({ title: '请先加入牌局', icon: 'none' });
      return;
    }
    this.givingScore = true;
    this.setData({ scoreSaving: true });
    this.tableLoadGeneration = (this.tableLoadGeneration || 0) + 1;
    const optimisticTable = this.buildOptimisticGiveTable(
      previousTable,
      myPlayer.id,
      targetPlayer.id,
      amount
    );
    this.closeKeypad();
    if (optimisticTable) this.applyTable(optimisticTable);
    const toastId = `give_${Date.now()}_${targetPlayer.id}`;
    this.appendNoticeToasts([{
      id: toastId,
      text: `已给 ${targetPlayer.name || '玩家'} ${amount} 分`
    }]);
    const giveScorePromise = store.giveScore(
        this.data.tableId,
        myPlayer.id,
        targetPlayer.id,
        amount
      );
    this.givingScorePromise = giveScorePromise;
    try {
      const table = await giveScorePromise;
      this.applyTable(table);
    } catch (error) {
      if (previousTable) this.applyTable(previousTable);
      this.closeNotice({ currentTarget: { dataset: { id: toastId } } });
      wx.showToast({ title: error.message || '计分失败', icon: 'none' });
    } finally {
      if (this.givingScorePromise === giveScorePromise) {
        this.givingScorePromise = null;
      }
      this.givingScore = false;
      this.setData({ scoreSaving: false });
    }
  }
});
