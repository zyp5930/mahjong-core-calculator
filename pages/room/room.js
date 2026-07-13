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
    settlementTitle: '结束牌局',
    settlementSubtitle: '请输入倍率后结算最终积分',
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
    tableWatcher: null,
    notices: [],
    noticeToasts: [],
    settlementPlayers: [],
    settlementMultiplier: '',
    finalScores: [],
    groupSettlement: null,
    canStartNextRound: false,
    canSettleGroup: false
  },

  async onLoad(options) {
    this.noticeToastTimers = {};
    this.avatarDisplayCache = {};
    this.failedAvatarKeys = {};
    this.avatarRetryCounts = {};
    await store.ensureMe();
    this.setData({
      mode: store.getStoredMode(),
      pendingAutoInvite: options.autoInvite === '1'
    });
    const tableId = options.id || '';
    const shareCode = options.shareCode || options.scene || '';
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
    this.setData({ noticeToasts: [] });
  },

  onUnload() {
    this.stopWatching();
    this.stopPolling();
    this.clearNoticeToastTimer();
    this.setData({ noticeToasts: [] });
  },

  onPullDownRefresh() {
    this.loadTable().finally(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {
    const table = this.data.table || {};
    return {
      title: `加入${table.name || '麻将计分桌'}`,
      path: `/pages/room/room?shareCode=${table.shareCode}`
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
      players: this.buildPlayers(table.players)
    });
    this.loadTable();
    this.startWatching();
    this.startPolling();
  },

  async loadTable() {
    try {
      const table = await store.getTable(this.data.tableId);
      if (!table) {
        wx.showToast({ title: '牌局不存在', icon: 'none' });
        return;
      }
      this.applyTable(table);
    } catch (error) {
      if (!this.tablePollTimer) {
        wx.showToast({ title: error.message || '刷新失败', icon: 'none' });
      }
    }
  },

  applyTable(table) {
    const myPlayer = store.findMyPlayer(table);
    const players = this.buildPlayers(table.players);
    const targetPlayer = this.data.targetPlayer
      ? players.find((player) => player.id === this.data.targetPlayer.id) || this.data.targetPlayer
      : null;
    const settlement = table.settlement || null;
    const groupSettlement = table.groupSettlement || null;
    const isOwner = !!myPlayer && table.ownerOpenid === myPlayer.openid;
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
      notices: (table.notifications || []).filter((item) => !myPlayer || !item.targetOpenid || item.targetOpenid === myPlayer.openid)
    });
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

  buildPlayers(players) {
    const playerList = players || [];
    const scores = playerList.map((player) => Number(player.score) || 0);
    const maxScore = scores.length ? Math.max(...scores) : 0;
    const minScore = scores.length ? Math.min(...scores) : 0;
    const hasWinnerAndLoser = playerList.length > 1 && maxScore !== minScore;
    this.avatarDisplayCache = this.avatarDisplayCache || {};
    this.failedAvatarKeys = this.failedAvatarKeys || {};

    return playerList.map((player) => {
      const score = Number(player.score) || 0;
      const avatarCacheKey = `${player.id}:${player.avatarFileId || player.avatarUrl || ''}`;
      let avatarDisplayUrl = this.buildAvatarDisplayUrl(player.avatarUrl, player.avatarFileId);
      if (avatarDisplayUrl) {
        this.avatarDisplayCache[avatarCacheKey] = avatarDisplayUrl;
      } else if (this.avatarDisplayCache[avatarCacheKey]) {
        avatarDisplayUrl = this.avatarDisplayCache[avatarCacheKey];
      }
      const viewKey = `${player.id}_${player.avatarFileId || ''}_${avatarDisplayUrl || player.avatarUrl || 'avatar-empty'}`;
      return {
        ...player,
        initial: String(player.name || '').slice(0, 1),
        absScore: Math.abs(score),
        rankEmoji: hasWinnerAndLoser && score === maxScore ? '🐶' : (hasWinnerAndLoser && score === minScore ? '😭' : ''),
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
    const viewKey = event.currentTarget.dataset.viewKey;
    if (viewKey && this.failedAvatarKeys && this.failedAvatarKeys[viewKey]) {
      delete this.failedAvatarKeys[viewKey];
    }
  },

  onAvatarError(event) {
    const dataset = event.currentTarget.dataset || {};
    const viewKey = dataset.viewKey;
    const avatarFileId = dataset.avatarFileId;
    const avatarUrl = dataset.avatarUrl;
    if (viewKey) this.markAvatarLoadFailed(viewKey);
    this.retryAvatarLoad(avatarFileId || avatarUrl || viewKey, avatarFileId);
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

  retryAvatarLoad(retryKey, avatarFileId) {
    if (!retryKey) return;
    this.avatarRetryCounts = this.avatarRetryCounts || {};
    const retryCount = this.avatarRetryCounts[retryKey] || 0;
    if (retryCount >= 1) return;
    this.avatarRetryCounts[retryKey] = retryCount + 1;
    if (avatarFileId && store.clearAvatarUrlCache) {
      store.clearAvatarUrlCache(avatarFileId);
    }
    setTimeout(() => {
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

  async openInvite() {
    if (!this.data.table || !this.data.table.shareCode) return;
    await store.ensureMe();
    this.setData({ mode: store.getStoredMode() });
    if (store.getStoredMode() !== 'cloud') {
      wx.showToast({
        title: '当前牌局为本地模式，请重新创建云端牌局',
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
        if (res.tapIndex === 0) this.openSettlementInput('table');
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
      settlementTitle: isGroupMode ? '结算所有对局' : '结束牌局',
      settlementSubtitle: isGroupMode
        ? '请输入倍率，先结算本局后汇总所有对局'
        : '请输入倍率后结算最终积分',
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
        : await store.endTable(this.data.tableId, multiplier);
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
    try {
      const table = await store.giveScore(
        this.data.tableId,
        myPlayer.id,
        targetPlayer.id,
        amount
      );
      this.applyTable(table);
    } catch (error) {
      if (previousTable) this.applyTable(previousTable);
      this.closeNotice({ currentTarget: { dataset: { id: toastId } } });
      wx.showToast({ title: error.message || '计分失败', icon: 'none' });
    } finally {
      this.givingScore = false;
    }
  }
});
