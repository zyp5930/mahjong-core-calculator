const store = require('../../services/store');

Page({
  data: {
    tableId: '',
    table: null,
    players: [],
    myPlayer: null,
    canGive: false,
    keypadVisible: false,
    settlementVisible: false,
    targetPlayer: null,
    inputValue: '',
    keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '取消', '0', '确认'],
    endInputValue: '',
    mode: 'unknown',
    inviteVisible: false,
    inviteCodeImage: '',
    inviteLoading: false,
    pendingAutoInvite: false,
    refreshTimer: null,
    tableWatcher: null,
    noticeTimer: null,
    notices: [],
    noticeVisible: false,
    noticeText: '',
    settlementPlayers: [],
    settlementMultiplier: '',
    finalScores: []
  },

  async onLoad(options) {
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
      return;
    }
    if (shareCode) {
      const parsedShareCode = decodeURIComponent(shareCode).replace(/^shareCode=/, '');
      this.resolveShareCode(parsedShareCode);
    }
  },

  onShow() {
    if (this.data.tableId) this.loadTable();
    this.startPolling();
    this.startWatching();
    this.pullNotices();
  },

  onHide() {
    this.stopPolling();
    this.stopWatching();
  },

  onUnload() {
    this.stopPolling();
    this.stopWatching();
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
    this.loadTable();
  },

  async loadTable() {
    const table = await store.getTable(this.data.tableId);
    if (!table) {
      wx.showToast({ title: '牌局不存在', icon: 'none' });
      return;
    }
    const myPlayer = store.findMyPlayer(table);
    const currentPlayers = this.data.players || [];
    const players = table.players.map((player) => {
      const currentPlayer = currentPlayers.find((item) => item.id === player.id);
      const avatarUrl = currentPlayer &&
        currentPlayer.avatarFileId === player.avatarFileId &&
        currentPlayer.avatarUrl
        ? currentPlayer.avatarUrl
        : player.avatarUrl;
      return {
        ...player,
        avatarUrl,
        initial: player.name.slice(0, 1),
        absScore: Math.abs(player.score)
      };
    });
    const settlement = table.settlement || null;
    this.setData({
      table,
      players,
      myPlayer,
      canGive: !!myPlayer && table.status === 'active',
      mode: store.getStoredMode(),
      settlementPlayers: settlement ? this.buildSettlementPlayers(settlement, table.players) : [],
      settlementMultiplier: settlement ? settlement.multiplier : '',
      finalScores: settlement ? settlement.finalScores || [] : [],
      notices: (table.notifications || []).filter((item) => !myPlayer || !item.targetOpenid || item.targetOpenid === myPlayer.openid)
    });
    this.showPendingNotice();
    if (this.data.pendingAutoInvite) {
      this.setData({ pendingAutoInvite: false });
      this.openInvite();
    }
  },

  startPolling() {
    this.stopPolling();
    if (!this.data.tableId || store.getStoredMode() !== 'cloud') return;
    this.pollTimer = setInterval(() => {
      this.loadTable();
    }, 3000);
  },

  stopPolling() {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  },

  startWatching() {
    this.stopWatching();
    if (!this.data.tableId || store.getStoredMode() !== 'cloud' || !wx.cloud || !wx.cloud.database) return;
    try {
      const db = wx.cloud.database();
      this.tableWatcher = db.collection('tables').doc(this.data.tableId).watch({
        onChange: () => {
          this.loadTable();
          this.pullNotices();
        },
        onError: () => {
          this.stopWatching();
        }
      });
    } catch (error) {
      this.stopWatching();
    }
  },

  stopWatching() {
    if (this.tableWatcher && typeof this.tableWatcher.close === 'function') {
      this.tableWatcher.close();
    }
    this.tableWatcher = null;
  },

  pullNotices() {
    this.stopNoticeTimer();
    this.noticeTimer = setInterval(() => {
      this.showPendingNotice();
    }, 1000);
  },

  stopNoticeTimer() {
    if (!this.noticeTimer) return;
    clearInterval(this.noticeTimer);
    this.noticeTimer = null;
  },

  showPendingNotice() {
    const notices = this.data.notices || [];
    const unread = notices.find((item) => !store.isNoticeSeen(this.data.tableId, item.id));
    if (!unread) return;
    store.markNoticeSeen(this.data.tableId, unread.id);
    this.setData({
      noticeVisible: true,
      noticeText: `${unread.title}：${unread.content}`,
      notices
    });
  },

  closeNotice() {
    this.setData({
      noticeVisible: false,
      noticeText: ''
    });
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
    this.setData({
      settlementVisible: true,
      endInputValue: '0.3'
    });
  },

  closeSettlement() {
    this.setData({
      settlementVisible: false,
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
      await store.endTable(this.data.tableId, multiplier);
      this.closeSettlement();
      this.loadTable();
    } catch (error) {
      wx.showToast({ title: error.message || '结算失败', icon: 'none' });
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
    try {
      await store.undoLastGive(
        this.data.tableId,
        this.data.myPlayer.id,
        event.currentTarget.dataset.id
      );
      this.loadTable();
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

  async confirmGive() {
    const amount = Number(this.data.inputValue);
    if (!amount) {
      wx.showToast({ title: '请输入分数', icon: 'none' });
      return;
    }
    try {
      await store.giveScore(
        this.data.tableId,
        this.data.myPlayer.id,
        this.data.targetPlayer.id,
        amount
      );
      this.closeKeypad();
      this.loadTable();
    } catch (error) {
      wx.showToast({ title: error.message || '计分失败', icon: 'none' });
    }
  }
});
