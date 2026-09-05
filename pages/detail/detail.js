const store = require('../../services/store');
const { formatTime } = require('../../utils/format');

const TREND_BATCH_WINDOW_MS = 30 * 1000;

Page({
  data: {
    tableId: '',
    table: {},
    records: [],
    trendPlayers: [],
    trendPoints: [],
    trendHasRecords: false
  },

  onLoad(options) {
    this.setData({ tableId: options.id || '' });
  },

  onShow() {
    this.loadDetail();
  },

  onHide() {
    this.clearTrendTimers();
  },

  onUnload() {
    this.clearTrendTimers();
  },

  async loadDetail() {
    let table = null;
    if (this.data.tableId) {
      table = await store.getTable(this.data.tableId);
    } else {
      const tables = await store.listTables();
      table = tables[0] || null;
    }
    if (!table) {
      this.clearTrendTimers();
      this.trendSelectedIndex = -1;
      this.setData({
        table: {},
        records: [],
        trendPlayers: [],
        trendPoints: [],
        trendHasRecords: false
      });
      return;
    }
    const trend = this.buildTrendData(table);
    this.trendSelectedIndex = -1;
    this.setData({
      table: {
        ...table,
        statusText: table.status === 'active' ? '进行中' : (table.settlementStatus === 'pending' ? '待结算' : '已结束')
      },
      records: (table.records || [])
        .filter((record) => record.type !== 'settlement')
        .map((record) => ({
          ...record,
          timeText: formatTime(record.createdAt),
          statusText: record.revoked ? '已撤销' : ''
        })),
      trendPlayers: trend.players,
      trendPoints: trend.points,
      trendHasRecords: trend.hasRecords
    }, () => this.drawScoreTrend());
  },

  buildTrendData(table) {
    const colors = ['#12855a', '#c84636', '#6b9fe8', '#d69a25', '#8a7ee8', '#45b7a8'];
    const players = (table.players || []).map((player, index) => ({
      id: player.id,
      name: player.name || `玩家${index + 1}`,
      color: player.avatarColor || colors[index % colors.length]
    }));
    const scores = {};
    players.forEach((player) => {
      scores[player.id] = 0;
    });

    const validRecords = (table.records || [])
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
        left.index - right.index
      ));

    const batches = [];
    validRecords.forEach(({ record }) => {
      const createdAt = Number(record.createdAt) || 0;
      const previous = batches[batches.length - 1];
      if (!previous || createdAt - previous.lastCreatedAt > TREND_BATCH_WINDOW_MS) {
        batches.push({ records: [record], lastCreatedAt: createdAt });
        return;
      }
      previous.records.push(record);
      previous.lastCreatedAt = createdAt;
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

    if (!validRecords.length && table.settlement && table.settlement.finalScores) {
      table.settlement.finalScores.forEach((item) => {
        if (Object.prototype.hasOwnProperty.call(scores, item.playerId)) {
          scores[item.playerId] = Number(item.rawScore) || 0;
        }
      });
      if (table.settlement.finalScores.length) {
        points.push({ label: '结束', scores: { ...scores }, recordCount: 0 });
      }
    }

    return {
      players,
      points,
      hasRecords: points.length > 1
    };
  },

  drawScoreTrend() {
    if (!this.data.trendHasRecords || !this.data.trendPoints.length) return;
    if (this.trendDrawPending) {
      this.trendDrawAgain = true;
      return;
    }
    this.trendDrawPending = true;
    wx.createSelectorQuery()
      .select('#scoreTrendCanvas')
      .fields({ node: true, size: true })
      .exec((result) => {
        const info = result && result[0];
        if (!info || !info.node || !info.width || !info.height) {
          this.trendDrawPending = false;
          return;
        }

        const canvas = info.node;
        const width = info.width;
        const height = info.height;
        const dpr = (wx.getSystemInfoSync() || {}).pixelRatio || 1;
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);

        const margin = { left: 44, right: 14, top: 18, bottom: 32 };
        const plotWidth = Math.max(1, width - margin.left - margin.right);
        const plotHeight = Math.max(1, height - margin.top - margin.bottom);
        const points = this.data.trendPoints;
        const players = this.data.trendPlayers;
        const values = points.reduce((all, point) => (
          all.concat(players.map((player) => Number(point.scores[player.id]) || 0))
        ), []);
        const rawMin = Math.min(...values, 0);
        const rawMax = Math.max(...values, 0);
        const rawRange = rawMax - rawMin || Math.max(Math.abs(rawMax), 10);
        const roughStep = rawRange / 4;
        const magnitude = 10 ** Math.floor(Math.log10(roughStep));
        const normalizedStep = roughStep / magnitude;
        const niceFactor = normalizedStep <= 1 ? 1 : (normalizedStep <= 2 ? 2 : (normalizedStep <= 5 ? 5 : 10));
        const axisStep = niceFactor * magnitude;
        const min = Math.floor(rawMin / axisStep) * axisStep;
        const max = Math.ceil(rawMax / axisStep) * axisStep || axisStep;
        const tickCount = Math.max(1, Math.round((max - min) / axisStep));
        const xFor = (index) => margin.left + (points.length <= 1 ? 0 : plotWidth * index / (points.length - 1));
        const yFor = (value) => margin.top + (max - value) * plotHeight / (max - min);
        this.trendChartMeta = { margin, plotWidth, points, xFor };

        ctx.font = '12px sans-serif';
        ctx.lineWidth = 1;
        ctx.textAlign = 'right';
        for (let index = 0; index <= tickCount; index += 1) {
          const value = min + axisStep * index;
          const y = yFor(value);
          ctx.strokeStyle = value === 0 ? '#b9c8bf' : '#e8eee9';
          ctx.beginPath();
          ctx.moveTo(margin.left, y);
          ctx.lineTo(width - margin.right, y);
          ctx.stroke();
          ctx.fillStyle = '#8a9690';
          ctx.fillText(this.formatTrendNumber(value), margin.left - 8, y + 4);
        }

        ctx.save();
        ctx.beginPath();
        ctx.rect(margin.left, margin.top, plotWidth, plotHeight);
        ctx.clip();
        players.forEach((player) => {
          ctx.strokeStyle = player.color;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          points.forEach((point, index) => {
            const x = xFor(index);
            const y = yFor(Number(point.scores[player.id]) || 0);
            if (index === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.stroke();
        });
        ctx.restore();

        const selectedIndex = this.trendSelectedIndex === undefined ? -1 : this.trendSelectedIndex;
        if (selectedIndex >= 0 && selectedIndex < points.length) {
          this.drawTrendTooltip(ctx, width, margin, xFor(selectedIndex), points[selectedIndex]);
        }

        this.trendDrawPending = false;
        if (this.trendDrawAgain) {
          this.trendDrawAgain = false;
          this.drawScoreTrend();
        }
      });
  },

  drawTrendTooltip(ctx, width, margin, selectedX, point) {
    const players = this.data.trendPlayers;
    const recordCount = point.recordCount || 0;
    const detailOffset = recordCount > 1 ? 18 : 0;
    const boxWidth = Math.min(170, width - 20);
    const boxHeight = 26 + detailOffset + players.length * 18;
    const boxX = selectedX + boxWidth + 8 > width ? width - boxWidth - 10 : selectedX + 8;
    const boxY = margin.top + 4;
    ctx.strokeStyle = '#aab7af';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(selectedX, margin.top);
    ctx.lineTo(selectedX, boxY + boxHeight + 8);
    ctx.stroke();
    ctx.fillStyle = 'rgba(31, 42, 36, 0.94)';
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
    ctx.textAlign = 'left';
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(point.label, boxX + 10, boxY + 17);
    if (recordCount > 1) {
      ctx.fillStyle = '#b9c8bf';
      ctx.fillText(`合并 ${recordCount} 次给分`, boxX + 10, boxY + 35);
    }
    players.forEach((player, index) => {
      ctx.fillStyle = player.color;
      ctx.fillText(`${player.name}: ${point.scores[player.id]}`, boxX + 10, boxY + 35 + detailOffset + index * 18);
    });
  },

  formatTrendNumber(value) {
    const number = Number(value) || 0;
    return Number.isInteger(number) ? String(number) : number.toFixed(1);
  },

  onTrendTap(event) {
    const touch = this.getTrendTouch(event);
    if (!touch) return;
    this.selectTrendAtX(touch.x);
  },

  onTrendTouchStart(event) {
    const touch = this.getTrendTouch(event);
    if (!touch) return;
    this.clearTrendTimers();
    this.trendTouchState = { startX: touch.x, dragging: false };
    this.trendLongPressTimer = setTimeout(() => {
      if (!this.trendTouchState) return;
      this.trendTouchState.dragging = true;
      this.selectTrendAtX(this.trendTouchState.startX);
    }, 350);
  },

  onTrendTouchMove(event) {
    const touch = this.getTrendTouch(event);
    if (!touch || !this.trendTouchState || !this.trendTouchState.dragging) return;
    this.selectTrendAtX(touch.x);
  },

  onTrendTouchEnd() {
    if (this.trendLongPressTimer) clearTimeout(this.trendLongPressTimer);
    this.trendLongPressTimer = null;
    this.trendTouchState = null;
  },

  getTrendTouch(event) {
    const touch = (event.touches || event.changedTouches || [])[0];
    if (!touch) return null;
    return { x: Number(touch.x) || 0 };
  },

  selectTrendAtX(x) {
    const meta = this.trendChartMeta;
    if (!meta || !meta.points.length) return;
    const ratio = meta.points.length <= 1 ? 0 : (x - meta.margin.left) / meta.plotWidth;
    const index = Math.max(0, Math.min(meta.points.length - 1, Math.round(ratio * (meta.points.length - 1))));
    if (index === this.trendSelectedIndex || index === this.trendPendingIndex) return;
    this.trendPendingIndex = index;
    if (this.trendRenderTimer) return;
    this.trendRenderTimer = setTimeout(() => {
      this.trendRenderTimer = null;
      const nextIndex = this.trendPendingIndex;
      this.trendPendingIndex = null;
      if (nextIndex === null || nextIndex === undefined || nextIndex === this.trendSelectedIndex) return;
      this.trendSelectedIndex = nextIndex;
      this.drawScoreTrend();
    }, 16);
  },

  clearTrendSelection() {
    this.clearTrendTimers();
    if (this.trendSelectedIndex < 0 || this.trendSelectedIndex === undefined) return;
    this.trendSelectedIndex = -1;
    this.drawScoreTrend();
  },

  clearTrendTimers() {
    if (this.trendLongPressTimer) clearTimeout(this.trendLongPressTimer);
    if (this.trendRenderTimer) clearTimeout(this.trendRenderTimer);
    this.trendLongPressTimer = null;
    this.trendRenderTimer = null;
    this.trendPendingIndex = null;
    this.trendTouchState = null;
  }
});
