const store = require('../../services/store');
const { formatDuration, formatTime, normalizeScore } = require('../../utils/format');

function getLoadErrorState(error) {
  const message = String((error && (error.errMsg || error.message)) || '');
  const normalizedMessage = message.toLowerCase();
  if ((error && error.errCode === -504003) || message.includes('timed out')) {
    return {
      title: '云端同步超时',
      subtitle: '对局数据暂未加载，请稍后再试。'
    };
  }
  if (
    normalizedMessage.includes('function not found') ||
    normalizedMessage.includes('functionname') ||
    normalizedMessage.includes('function name') ||
    message.includes('云函数 login 未部署')
  ) {
    return {
      title: '云登录服务未部署',
      subtitle: '请在微信开发者工具中上传并部署 cloudfunctions/login。'
    };
  }
  if (
    normalizedMessage.includes('environment') ||
    normalizedMessage.includes('env') ||
    normalizedMessage.includes('invalid cloudbase') ||
    message.includes('云环境未初始化')
  ) {
    return {
      title: '云环境不可用',
      subtitle: '请确认 app.js 中的云环境 ID 与当前小程序 AppID 已关联。'
    };
  }
  if (
    normalizedMessage.includes('network') ||
    normalizedMessage.includes('network error') ||
    normalizedMessage.includes('request:fail') ||
    normalizedMessage.includes('fail timeout')
  ) {
    return {
      title: '网络连接失败',
      subtitle: '请检查手机网络后，重新进入首页刷新。'
    };
  }
  return {
    title: '云端连接失败',
    subtitle: '请检查云函数 login 和 tableOps 是否已部署到当前云环境。'
  };
}

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
    settlementScoreGroupIds: {},
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
      modeText: store.getStoredMode() === 'cloud' ? '云同步模式' : '云端检测中'
    });
    let loginError = null;
    try {
      const me = await store.ensureMe();
      const mode = me.mode || store.getStoredMode();
      this.setData({
        mode,
        modeText: mode === 'cloud' ? '云同步模式' : '云端不可用'
      });
    } catch (error) {
      console.error('[home ensureMe error]', error);
      loginError = error;
      this.setData({
        mode: 'error',
        modeText: '云端不可用'
      });
    }
    if (loginError) {
      const errorState = getLoadErrorState(loginError);
      this.setData({
        loadingTables: false,
        loadErrorText: errorState.title,
        emptyTitle: errorState.title,
        emptySubtitle: errorState.subtitle
      });
      return;
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
      const errorState = getLoadErrorState(error);
      this.setData({
        tables: [],
        tableGroups: [],
        latestGroup: null,
        quickStats: this.buildQuickStats([]),
        loadingTables: false,
        loadErrorText: errorState.title,
        emptyTitle: errorState.title,
        emptySubtitle: errorState.subtitle
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
      rawScore: normalizeScore(settlementScores[player.id] ? settlementScores[player.id].rawScore : player.score),
      settledScore: normalizeScore(settlementScores[player.id] ? settlementScores[player.id].finalScore : player.score),
      scoreFormula: settlementScores[player.id]
        ? `${settlementScores[player.id].rawScore} × ${settlementMultiplier} = ${settlementScores[player.id].finalScore}`
        : '',
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
      roundPlayers: players
    };
  },

  buildRoundDurationText(table, nextTable) {
    if (table.status === 'active') return `已进行${formatDuration(table.createdAt)}`;
    const createdAt = Number(table.createdAt) || 0;
    const nextStartedAt = Number(nextTable && nextTable.createdAt) || 0;
    const endedAt = nextStartedAt > createdAt ? nextStartedAt : table.endedAt;
    return `持续${formatDuration(table.createdAt, endedAt)}`;
  },

  buildGroupPlayers(tables, showSettlementScores) {
    const playerMap = {};
    tables.forEach((table) => {
      (table.roundPlayers || table.players || []).forEach((player) => {
        const groupPlayerId = player.groupPlayerId || player.openid || player.id;
        if (!playerMap[groupPlayerId]) {
          playerMap[groupPlayerId] = {
            ...player,
            id: groupPlayerId,
            rawScore: 0,
            settledScore: 0,
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
        playerMap[groupPlayerId].rawScore = normalizeScore(
          playerMap[groupPlayerId].rawScore + (Number(player.rawScore) || 0)
        );
        playerMap[groupPlayerId].settledScore = normalizeScore(
          playerMap[groupPlayerId].settledScore + (Number(player.settledScore) || 0)
        );
      });
    });
    return Object.values(playerMap)
      .map((player) => ({
        ...player,
        score: showSettlementScores ? player.settledScore : player.rawScore,
        scoreText: this.formatScoreText(showSettlementScores ? player.settledScore : player.rawScore)
      }))
      .sort((left, right) => right.score - left.score);
  },

  buildRoundPlayers(tables, showSettlementScores) {
    return tables.map((table) => {
      const roundPlayers = (table.roundPlayers || table.players || []).map((player) => {
        const rawScore = Number(player.rawScore) || 0;
        const settledScore = Number(player.settledScore) || 0;
        const displayScore = showSettlementScores ? settledScore : rawScore;
        return {
          ...player,
          score: displayScore,
          scoreText: this.formatScoreText(displayScore),
          displayScoreText: this.formatScoreText(displayScore)
        };
      });
      return {
        ...table,
        roundPlayers,
        roundPlayerColumnCount: Math.min(4, Math.max(1, roundPlayers.length)),
        canScrollRoundPlayers: roundPlayers.length > 4
      };
    });
  },

  buildLatestGroup(groups) {
    const latestGroup = groups[0];
    if (!latestGroup) return null;
    const groupTables = latestGroup.tables || [];
    const targetTableId = latestGroup.latestTableId || latestGroup.activeTableId || latestGroup.settleTableId;
    const entryTable = groupTables.find((table) => table.id === targetTableId) || groupTables[groupTables.length - 1] || null;
    const entryTableId = entryTable ? entryTable.id : targetTableId;
    const entryName = latestGroup.name || '麻将计分桌';
    const entryParts = [
      entryName,
      entryTable ? entryTable.roundText : '',
      entryTable && entryTable.createdText ? `${entryTable.createdText}开始` : ''
    ];
    return {
      ...latestGroup,
      entryTableId,
      entryName,
      entryRoundText: entryTable ? entryTable.roundText : '',
      entryCreatedText: entryTable ? entryTable.createdText : '',
      entryDesc: entryParts.filter(Boolean).join(' · ')
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
    const settlementScoreGroupIds = this.data.settlementScoreGroupIds || {};
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
      const tablesWithDuration = sortedTables.map((table, index) => ({
        ...table,
        durationText: this.buildRoundDurationText(table, sortedTables[index + 1])
      }));
      const hasSettlementScores = tablesWithDuration.some((table) => (
        !!(table.settlement && (table.settlement.finalScores || []).length)
      ));
      const showSettlementScores = hasSettlementScores && !!settlementScoreGroupIds[group.groupId];
      const displayTables = this.buildRoundPlayers(tablesWithDuration, showSettlementScores);
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
      const groupPlayers = this.buildGroupPlayers(displayTables, showSettlementScores);
      return {
        ...group,
        name: displayTable.name || group.name,
        status,
        statusText,
        isSettled,
        hasSettlementScores,
        showSettlementScores,
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

  openGroupDetail(event) {
    const groupId = event.currentTarget.dataset.id;
    if (!groupId) return;
    wx.navigateTo({
      url: `/pages/group-detail/group-detail?groupId=${groupId}`,
      success: (result) => {
        const group = (this.data.tableGroups || []).find((item) => item.groupId === groupId);
        if (group) result.eventChannel.emit('groupTables', { tables: group.tables });
      }
    });
  },

  toggleSettlementScores(event) {
    const groupId = event.currentTarget.dataset.id;
    if (!groupId) return;
    this.setData({
      settlementScoreGroupIds: {
        ...this.data.settlementScoreGroupIds,
        [groupId]: !this.data.settlementScoreGroupIds[groupId]
      }
    }, () => {
      this.setData({ tableGroups: this.buildTableGroups(this.data.tables) });
    });
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

  async deleteGroup(event) {
    const tableId = event.currentTarget.dataset.id;
    if (!tableId) return;
    const group = (this.data.tableGroups || []).find((item) => item.settleTableId === tableId);
    const roundCount = group ? group.tableCount : 1;
    const confirmResult = await new Promise((resolve) => {
      wx.showModal({
        title: '删除对局',
        content: roundCount > 1
          ? `将删除这组对局的全部 ${roundCount} 局及计分记录，确认继续吗？`
          : '将删除这局对局及计分记录，确认继续吗？',
        confirmText: '删除',
        confirmColor: '#d94f45',
        cancelText: '取消',
        success: resolve,
        fail: () => resolve({ confirm: false })
      });
    });
    if (!confirmResult.confirm) return;
    try {
      wx.showLoading({ title: '删除中' });
      await store.deleteGroup(tableId);
      wx.hideLoading();
      wx.showToast({ title: '已删除' });
      await this.loadTables();
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: error.message || '删除失败', icon: 'none' });
    }
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
