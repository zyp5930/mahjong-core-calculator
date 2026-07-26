const store = require('../../services/store');
const { formatDuration, formatTime, normalizeScore } = require('../../utils/format');

Page({
  data: {
    tables: [],
    tableGroups: [],
    latestGroup: null,
    quickStats: {
      totalGroups: 0,
      activeGroups: 0,
      pendingGroups: 0
    },
    expandedGroupIds: {},
    mode: 'unknown',
    modeText: '检测中',
    loadingTables: true,
    loadErrorText: '',
    emptyTitle: '正在加载对局',
    emptySubtitle: '稍等一下，正在同步牌桌。',
    settlementVisible: false,
    settlementTableId: '',
    settlementInputValue: '0.3'
  },

  async onShow() {
    this.setData({
      mode: store.getStoredMode(),
      modeText: store.getStoredMode() === 'cloud' ? '云同步模式' : '本地模式'
    });
    try {
      const me = await store.ensureMe();
      const mode = me.mode || store.getStoredMode();
      this.setData({
        mode,
        modeText: mode === 'cloud' ? '云同步模式' : '本地模式'
      });
    } catch (error) {
      console.error('[home ensureMe error]', error);
      this.setData({
        mode: 'local',
        modeText: '本地模式'
      });
    }
    await this.loadTables();
  },

  async loadTables() {
    this.setData({
      loadingTables: true,
      loadErrorText: '',
      emptyTitle: '正在加载对局',
      emptySubtitle: '稍等一下，正在同步牌桌。'
    });
    try {
      const tables = await store.listTables();
      const formattedTables = tables.map((table) => this.formatTable(table));
      const tableGroups = this.buildTableGroups(formattedTables);
      this.setData({
        tables: formattedTables,
        tableGroups,
        latestGroup: this.buildLatestGroup(tableGroups),
        quickStats: this.buildQuickStats(tableGroups),
        loadingTables: false,
        emptyTitle: '还没有对局',
        emptySubtitle: '先创建一桌，牌友就能从分享进入。'
      });
    } catch (error) {
      console.error('[home loadTables error]', error);
      this.setData({
        tables: [],
        tableGroups: [],
        latestGroup: null,
        quickStats: this.buildQuickStats([]),
        loadingTables: false,
        loadErrorText: error.message || '对局加载失败',
        emptyTitle: error.message || '对局加载失败',
        emptySubtitle: '可以先新开一桌，或稍后再试。'
      });
      wx.showToast({
        title: '对局加载失败',
        icon: 'none'
      });
    }
  },

  formatScoreText(score) {
    const value = normalizeScore(Number(score) || 0);
    return value > 0 ? `+${value}` : `${value}`;
  },

  formatTable(table) {
    const isPendingSettlement = table.status === 'ended' && table.settlementStatus === 'pending';
    const isSettled = table.status === 'ended' && table.settlementStatus === 'settled';
    const settlementMultiplier = table.settlement ? table.settlement.multiplier : '';
    const settlementScores = ((table.settlement && table.settlement.finalScores) || []).reduce((map, score) => {
      map[score.playerId] = score;
      return map;
    }, {});
    const players = (table.players || []).map((player) => ({
      ...player,
      score: settlementScores[player.id] ? settlementScores[player.id].finalScore : player.score,
      scoreFormula: settlementScores[player.id]
        ? `${settlementScores[player.id].rawScore} × ${settlementMultiplier} = ${settlementScores[player.id].finalScore}`
        : '',
      scoreText: this.formatScoreText(settlementScores[player.id] ? settlementScores[player.id].finalScore : player.score),
      initial: String(player.name || '').slice(0, 1)
    }));
    return {
      ...table,
      statusText: table.status === 'active' ? '进行中' : (isPendingSettlement ? '待结算' : (isSettled ? '已结算' : '已结束')),
      createdText: formatTime(table.createdAt),
      durationText: table.status === 'active'
        ? `已进行${formatDuration(table.createdAt)}`
        : `持续${formatDuration(table.createdAt, table.endedAt)}`,
      roundText: `第${Number(table.roundNo) || 1}局`,
      players,
      roundPlayers: players,
      settlementMultiplier
    };
  },

  buildRoundDurationText(table, nextTable) {
    if (table.status === 'active') return `已进行${formatDuration(table.createdAt)}`;
    const createdAt = Number(table.createdAt) || 0;
    const nextStartedAt = Number(nextTable && nextTable.createdAt) || 0;
    const endedAt = nextStartedAt > createdAt ? nextStartedAt : table.endedAt;
    return `持续${formatDuration(table.createdAt, endedAt)}`;
  },

  buildGroupPlayers(tables) {
    const playerMap = {};
    tables.forEach((table) => {
      const settlementScores = ((table.settlement && table.settlement.finalScores) || []).reduce((map, score) => {
        map[score.playerId] = score;
        return map;
      }, {});
      (table.roundPlayers || table.players || []).forEach((player) => {
        const groupPlayerId = player.groupPlayerId || player.openid || player.id;
        if (!playerMap[groupPlayerId]) {
          playerMap[groupPlayerId] = {
            ...player,
            id: groupPlayerId,
            score: 0,
            initial: String(player.name || '').slice(0, 1)
          };
        } else {
          playerMap[groupPlayerId] = {
            ...playerMap[groupPlayerId],
            name: player.name || playerMap[groupPlayerId].name,
            avatarUrl: player.avatarUrl || playerMap[groupPlayerId].avatarUrl,
            avatarFileId: player.avatarFileId || playerMap[groupPlayerId].avatarFileId,
            avatarColor: player.avatarColor || playerMap[groupPlayerId].avatarColor,
            initial: String(player.name || playerMap[groupPlayerId].name || '').slice(0, 1)
          };
        }
        const score = settlementScores[player.id]
          ? settlementScores[player.id].finalScore
          : player.score;
        playerMap[groupPlayerId].score = normalizeScore(playerMap[groupPlayerId].score + (Number(score) || 0));
      });
    });
    return Object.values(playerMap)
      .map((player) => ({
        ...player,
        scoreText: this.formatScoreText(player.score)
      }))
      .sort((left, right) => right.score - left.score);
  },

  buildLatestGroup(groups) {
    const latestGroup = groups[0];
    if (!latestGroup) return null;
    return {
      ...latestGroup,
      entryTableId: latestGroup.latestTableId || latestGroup.activeTableId || latestGroup.settleTableId
    };
  },

  buildQuickStats(groups) {
    return {
      totalGroups: groups.length,
      activeGroups: groups.filter((group) => group.status === 'active').length,
      pendingGroups: groups.filter((group) => !group.isSettled && group.status !== 'active').length
    };
  },

  buildTableGroups(tables) {
    const expandedGroupIds = this.data.expandedGroupIds || {};
    const groupMap = tables.reduce((map, table) => {
      const groupId = table.groupId || table.id;
      if (!map[groupId]) {
        map[groupId] = {
          groupId,
          name: table.name,
          tables: [],
          createdAt: table.createdAt || 0,
          updatedAt: table.updatedAt || table.createdAt || 0
        };
      }
      map[groupId].tables.push(table);
      map[groupId].createdAt = Math.min(map[groupId].createdAt || table.createdAt || 0, table.createdAt || 0);
      map[groupId].updatedAt = Math.max(map[groupId].updatedAt || 0, table.updatedAt || table.createdAt || 0);
      return map;
    }, {});

    return Object.values(groupMap).map((group) => {
      const sortedTables = group.tables.slice().sort((left, right) => (
        (Number(left.roundNo) || 1) - (Number(right.roundNo) || 1) ||
        (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0)
      ));
      const displayTables = sortedTables.map((table, index) => ({
        ...table,
        durationText: this.buildRoundDurationText(table, sortedTables[index + 1])
      }));
      const activeTable = displayTables.slice().reverse().find((table) => table.status === 'active');
      const latestTable = displayTables[displayTables.length - 1];
      const displayTable = activeTable || latestTable || displayTables[0];
      const endedCount = displayTables.filter((table) => table.status === 'ended').length;
      const pendingSettlementCount = displayTables.filter((table) => (
        table.status === 'ended' && table.settlementStatus === 'pending'
      )).length;
      const settledTable = displayTables.find((table) => table.groupSettlement);
      const groupSettlement = settledTable ? settledTable.groupSettlement : null;
      const isSettled = !!groupSettlement || displayTables.some((table) => table.groupStatus === 'settled');
      const isOwner = displayTables.some((table) => {
        const myPlayer = store.findMyPlayer({
          ...table,
          players: table.roundPlayers || table.players || []
        });
        return !!myPlayer && table.ownerOpenid === myPlayer.openid;
      });
      const status = activeTable ? 'active' : 'ended';
      const statusText = activeTable ? '进行中' : (isSettled ? '已结束' : (pendingSettlementCount ? '待结算' : '已结束'));
      const pendingText = pendingSettlementCount ? ` | 待结算${pendingSettlementCount}局` : '';
      const settleTable = activeTable || latestTable || displayTables[0];
      const groupPlayers = this.buildGroupPlayers(displayTables);
      return {
        ...group,
        name: displayTable.name || group.name,
        status,
        statusText,
        isSettled,
        isExpanded: !!expandedGroupIds[group.groupId],
        activeTableId: activeTable ? activeTable.id : '',
        latestTableId: latestTable ? latestTable.id : '',
        settleTableId: settleTable ? settleTable.id : '',
        canSettleGroupFromHome: !!(
          isOwner &&
          !activeTable &&
          !isSettled &&
          pendingSettlementCount > 0 &&
          settleTable
        ),
        tableCount: displayTables.length,
        endedCount,
        activeCount: activeTable ? 1 : 0,
        players: groupPlayers,
        playerColumnCount: Math.min(5, Math.max(1, groupPlayers.length)),
        canScrollPlayers: groupPlayers.length > 5,
        tables: displayTables,
        createdText: formatTime(group.createdAt),
        updatedText: formatTime(group.updatedAt),
        summaryText: `${displayTables.length}局 | 已结束${endedCount}局${pendingText}${activeTable ? ' | 1局进行中' : ''}`
      };
    }).sort((left, right) => right.updatedAt - left.updatedAt);
  },

  toggleGroup(event) {
    const groupId = event.currentTarget.dataset.id;
    if (!groupId) return;
    this.setData({
      expandedGroupIds: {
        ...this.data.expandedGroupIds,
        [groupId]: !this.data.expandedGroupIds[groupId]
      }
    }, () => {
      this.setData({
        tableGroups: this.buildTableGroups(this.data.tables)
      });
    });
  },

  openGroupTable(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    this.openTableById(id);
  },

  openTable(event) {
    const id = event.currentTarget.dataset.id;
    this.openTableById(id);
  },

  openTableById(id) {
    wx.navigateTo({
      url: `/pages/room/room?id=${id}`
    });
  },

  openLatestTable() {
    const latestGroup = this.data.latestGroup;
    if (!latestGroup || !latestGroup.entryTableId) return;
    this.openTableById(latestGroup.entryTableId);
  },

  settleGroupFromHome(event) {
    const tableId = event.currentTarget.dataset.id;
    if (!tableId) return;
    this.setData({
      settlementVisible: true,
      settlementTableId: tableId,
      settlementInputValue: '0.3'
    });
  },

  closeHomeSettlement() {
    this.setData({
      settlementVisible: false,
      settlementTableId: '',
      settlementInputValue: '0.3'
    });
  },

  onHomeSettlementInput(event) {
    this.setData({
      settlementInputValue: event.detail.value
    });
  },

  async confirmHomeSettlement() {
    const multiplier = Number(String(this.data.settlementInputValue || '').trim());
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      wx.showToast({ title: '请输入有效倍率', icon: 'none' });
      return;
    }
    try {
      wx.showLoading({ title: '结算中' });
      await store.settleGroup(this.data.settlementTableId, multiplier);
      wx.hideLoading();
      this.closeHomeSettlement();
      this.loadTables();
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: error.message || '结算失败', icon: 'none' });
    }
  }
});
