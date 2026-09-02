const store = require('../../services/store');
const { formatTime } = require('../../utils/format');

// 同一波结束结算通常会连续产生多条给分记录，按时间窗口合并为一个走势节点。
const TREND_BATCH_WINDOW_MS = 30 * 1000;

Page({
  data: {
    tableId: '',
    table: {},
    players: [],
    records: [],
    settlement: null,
    trendPlayers: [],
    trendPoints: [],
    trendHasRecords: false,
    trendSelectedIndex: -1
  },

  onLoad(options) {
    this.setData({ tableId: options.id || '' });
  },

  onShow() {
    this.loadDetail();
  },

  onHide() {
    this.clearTrendLongPressTimer();
    this.clearTrendRenderTimer();
    this.trendTouchState = null;
  },

  onUnload() {
    this.clearTrendLongPressTimer();
    this.clearTrendRenderTimer();
    this.trendTouchState = null;
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
      this.trendSelectedIndex = -1;
      this.setData({
        table: {},
        players: [],
        records: [],
        trendPlayers: [],
        trendPoints: [],
        trendHasRecords: false,
        trendSelectedIndex: -1
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
      players: store.sortPlayers(table.players),
      settlement: table.settlement || null,
      records: table.records.map((record) => ({
        ...record,
        isSettlement: record.type === 'settlement',
        timeText: formatTime(record.createdAt),
        statusText: record.revoked ? '已撤销' : ''
      })),
      trendPlayers: trend.players,
      trendPoints: trend.points,
      trendHasRecords: trend.hasRecords,
      trendSelectedIndex: -1
    }, () => this.drawScoreTrend());
  },

  buildTrendData(table) {
    const players = (table.players || []).map((player, index) => ({
      id: player.id,
      name: player.name || `玩家${index + 1}`,
      color: player.avatarColor || ['#12855a', '#c84636', '#6b9fe8', '#d69a25', '#8a7ee8', '#45b7a8'][index % 6]
    }));
    const scoreMap = {};
    players.forEach((player) => {
      scoreMap[player.id] = 0;
    });

    const points = [{ label: '开始', scores: { ...scoreMap } }];
    const validRecords = (table.records || [])
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => (
        record.type !== 'settlement' &&
        !record.revoked &&
        Number(record.amount) > 0 &&
        scoreMap[record.fromPlayerId] !== undefined &&
        scoreMap[record.toPlayerId] !== undefined
      ))
      .sort((left, right) => (
        (Number(left.record.createdAt) || 0) - (Number(right.record.createdAt) || 0) ||
        right.index - left.index
      ));

    const batches = [];
    validRecords.forEach((item) => {
      const createdAt = Number(item.record.createdAt) || 0;
      const previousBatch = batches[batches.length - 1];
      if (!previousBatch || createdAt - previousBatch.lastCreatedAt > TREND_BATCH_WINDOW_MS) {
        batches.push({ records: [item.record], lastCreatedAt: createdAt });
      } else {
        previousBatch.records.push(item.record);
        previousBatch.lastCreatedAt = createdAt;
      }
    });

    batches.forEach((batch, index) => {
      batch.records.forEach((record) => {
        const amount = Number(record.amount);
        scoreMap[record.fromPlayerId] -= amount;
        scoreMap[record.toPlayerId] += amount;
      });
      points.push({
        label: `第${index + 1}笔`,
        scores: { ...scoreMap },
        recordCount: batch.records.length
      });
    });

    if (!validRecords.length && table.settlement && table.settlement.finalScores) {
      table.settlement.finalScores.forEach((item) => {
        if (scoreMap[item.playerId] !== undefined) scoreMap[item.playerId] = Number(item.rawScore) || 0;
      });
      if (table.settlement.finalScores.length) {
        points.push({ label: '结束', scores: { ...scoreMap } });
      }
    }

    return {
      players,
      points,
      hasRecords: validRecords.length > 0 || points.length > 1
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
        const values = [];
        points.forEach((point) => {
          this.data.trendPlayers.forEach((player) => values.push(Number(point.scores[player.id]) || 0));
        });
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
        const yFor = (value) => Math.max(
          margin.top,
          Math.min(height - margin.bottom, margin.top + (max - value) * plotHeight / (max - min))
        );
        this.trendChartMeta = { width, height, margin, plotWidth, plotHeight, xFor, points };

        ctx.font = '12px sans-serif';
        ctx.lineWidth = 1;
        ctx.textAlign = 'right';
        for (let index = 0; index <= tickCount; index += 1) {
          const value = min + axisStep * index;
          const y = yFor(value);
          ctx.strokeStyle = '#e8eee9';
          ctx.beginPath();
          ctx.moveTo(margin.left, y);
          ctx.lineTo(width - margin.right, y);
          ctx.stroke();
          ctx.fillStyle = '#8a9690';
          ctx.fillText(this.formatTrendNumber(value), margin.left - 8, y + 4);
        }
        if (min <= 0 && max >= 0) {
          const zeroY = yFor(0);
          ctx.strokeStyle = '#b9c8bf';
          ctx.beginPath();
          ctx.moveTo(margin.left, zeroY);
          ctx.lineTo(width - margin.right, zeroY);
          ctx.stroke();
        }

        ctx.textAlign = 'center';
        const labelCount = Math.min(5, points.length);
        for (let labelIndex = 0; labelIndex < labelCount; labelIndex += 1) {
          const index = labelCount <= 1
            ? 0
            : Math.round(labelIndex * (points.length - 1) / (labelCount - 1));
          const point = points[index];
          ctx.fillStyle = '#8a9690';
          ctx.textAlign = labelIndex === 0
            ? 'left'
            : (labelIndex === labelCount - 1 ? 'right' : 'center');
          ctx.fillText(point.label, xFor(index), height - 10);
        }
        points.forEach((point, index) => {
          if (index === 0 || point.roundNo === points[index - 1].roundNo) return;
          ctx.strokeStyle = '#d6e0d9';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(xFor(index), margin.top);
          ctx.lineTo(xFor(index), height - margin.bottom);
          ctx.stroke();
        });

        ctx.save();
        ctx.beginPath();
        ctx.rect(margin.left, margin.top, plotWidth, plotHeight);
        ctx.clip();
        this.data.trendPlayers.forEach((player) => {
          ctx.strokeStyle = player.color;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          let previousRoundNo = null;
          points.forEach((point, index) => {
            const x = xFor(index);
            const y = yFor(point.scores[player.id]);
            if (index === 0 || point.roundNo !== previousRoundNo) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            previousRoundNo = point.roundNo;
          });
          ctx.stroke();
        });
        ctx.restore();

        const selectedIndex = this.trendSelectedIndex === undefined
          ? this.data.trendSelectedIndex
          : this.trendSelectedIndex;
        if (selectedIndex >= 0 && selectedIndex < points.length) {
          const selectedX = xFor(selectedIndex);
          ctx.strokeStyle = '#aab7af';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(selectedX, margin.top);
          ctx.lineTo(selectedX, height - margin.bottom);
          ctx.stroke();
          const boxWidth = Math.min(170, width - 20);
          const recordCount = points[selectedIndex].recordCount || 0;
          const detailOffset = recordCount > 1 ? 18 : 0;
          const boxHeight = 26 + detailOffset + this.data.trendPlayers.length * 18;
          const boxX = selectedX + boxWidth + 8 > width ? width - boxWidth - 10 : selectedX + 8;
          const boxY = margin.top + 4;
          ctx.fillStyle = 'rgba(31, 42, 36, 0.94)';
          ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
          ctx.textAlign = 'left';
          ctx.font = '12px sans-serif';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(points[selectedIndex].label, boxX + 10, boxY + 17);
          if (recordCount > 1) {
            ctx.fillStyle = '#b9c8bf';
            ctx.fillText(`合并 ${recordCount} 次给分`, boxX + 10, boxY + 35);
          }
          this.data.trendPlayers.forEach((player, index) => {
            ctx.fillStyle = player.color;
            ctx.fillText(`${player.name}: ${points[selectedIndex].scores[player.id]}`, boxX + 10, boxY + 35 + detailOffset + index * 18);
          });
        }
        this.trendDrawPending = false;
        if (this.trendDrawAgain) {
          this.trendDrawAgain = false;
          this.drawScoreTrend();
        }
      });
  },

  formatTrendNumber(value) {
    const number = Number(value) || 0;
    return Number.isInteger(number) ? String(number) : number.toFixed(1);
  },

  onTrendTap(event) {
    const meta = this.trendChartMeta;
    if (!meta || !meta.points.length) return;
    const touch = event && event.touches && event.touches[0];
    if (!touch) return;
    this.selectTrendAtX(Number(touch.x) || 0);
  },

  selectTrendAtX(x) {
    const meta = this.trendChartMeta;
    if (!meta || !meta.points.length) return;
    const ratio = meta.points.length <= 1
      ? 0
      : (x - meta.margin.left) / meta.plotWidth;
    const index = Math.max(0, Math.min(meta.points.length - 1, Math.round(ratio * (meta.points.length - 1))));
    const currentIndex = this.trendSelectedIndex === undefined
      ? this.data.trendSelectedIndex
      : this.trendSelectedIndex;
    if (index === currentIndex || index === this.trendPendingIndex) return;
    this.trendPendingIndex = index;
    if (this.trendRenderTimer) return;
    this.trendRenderTimer = setTimeout(() => {
      this.trendRenderTimer = null;
      const nextIndex = this.trendPendingIndex;
      this.trendPendingIndex = null;
      const currentIndex = this.trendSelectedIndex === undefined
        ? this.data.trendSelectedIndex
        : this.trendSelectedIndex;
      if (nextIndex === null || nextIndex === undefined || nextIndex === currentIndex) return;
      this.trendSelectedIndex = nextIndex;
      this.drawScoreTrend();
    }, 16);
  },

  onTrendTouchStart(event) {
    const touch = event && event.touches && event.touches[0];
    if (!touch || !this.trendChartMeta) return;
    this.clearTrendLongPressTimer();
    this.trendTouchState = {
      startX: Number(touch.x) || 0,
      dragging: false
    };
    this.trendLongPressTimer = setTimeout(() => {
      if (!this.trendTouchState) return;
      this.trendTouchState.dragging = true;
      this.selectTrendAtX(this.trendTouchState.startX);
    }, 350);
  },

  onTrendTouchMove(event) {
    const touch = event && event.touches && event.touches[0];
    if (!touch || !this.trendTouchState) return;
    if (!this.trendTouchState.dragging) return;
    this.selectTrendAtX(Number(touch.x) || 0);
  },

  onTrendTouchEnd() {
    this.clearTrendLongPressTimer();
    this.trendTouchState = null;
  },

  clearTrendLongPressTimer() {
    if (this.trendLongPressTimer) {
      clearTimeout(this.trendLongPressTimer);
      this.trendLongPressTimer = null;
    }
  },

  clearTrendRenderTimer() {
    if (this.trendRenderTimer) {
      clearTimeout(this.trendRenderTimer);
      this.trendRenderTimer = null;
    }
    this.trendPendingIndex = null;
  },

  clearTrendSelection() {
    this.clearTrendLongPressTimer();
    this.clearTrendRenderTimer();
    this.trendTouchState = null;
    const currentIndex = this.trendSelectedIndex === undefined
      ? this.data.trendSelectedIndex
      : this.trendSelectedIndex;
    if (currentIndex < 0) return;
    this.trendSelectedIndex = -1;
    this.drawScoreTrend();
  }
});
