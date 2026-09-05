const store = require('../../services/store');
const { formatDuration, formatTime, normalizeScore } = require('../../utils/format');

Page({
  data: {
    groupId: '',
    group: null,
    loading: true
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
    this.setData({
      group: {
        name: latest.name || '麻将计分桌',
        tableCount: tables.length,
        status: latest.status === 'active' ? 'active' : 'ended',
        statusText: latest.status === 'active' ? '进行中' : '已结束',
        rounds: this.buildRounds(tables)
      },
      loading: false
    });
  },

  async loadGroup() {
    const groupId = this.data.groupId;
    if (!groupId) return;
    this.setData({ loading: true });
    try {
      this.applyGroupTables(await store.listTables());
    } catch (error) {
      this.setData({ group: null, loading: false });
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    }
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
