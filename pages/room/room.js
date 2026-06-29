const store = require('../../services/store');

Page({
  data: {
    tableId: '',
    table: null,
    players: [],
    myPlayer: null,
    canGive: false,
    keypadVisible: false,
    targetPlayer: null,
    inputValue: '',
    keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '取消', '0', '确认'],
    mode: 'unknown',
    inviteVisible: false,
    inviteCodeImage: '',
    inviteLoading: false,
    pendingAutoInvite: false
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
  },

  onHide() {
    this.stopPolling();
  },

  onUnload() {
    this.stopPolling();
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
    const players = table.players.map((player) => ({
      ...player,
      initial: player.name.slice(0, 1),
      absScore: Math.abs(player.score)
    }));
    this.setData({
      table,
      players,
      myPlayer,
      canGive: !!myPlayer && table.status === 'active',
      mode: store.getStoredMode()
    });
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

  openJoin() {
    wx.navigateTo({
      url: `/pages/join/join?id=${this.data.tableId}`
    });
  },

  async openInvite() {
    if (!this.data.table || !this.data.table.shareCode) return;
    if (store.getStoredMode() !== 'cloud') {
      wx.showToast({
        title: '请先配置云开发并部署二维码云函数',
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

  showMore() {
    wx.showActionSheet({
      itemList: ['结束牌局', '复制分享码', '编辑我的资料'],
      success: async (res) => {
        if (res.tapIndex === 0) {
          await store.endTable(this.data.tableId);
          this.loadTable();
        }
        if (res.tapIndex === 1) {
          wx.setClipboardData({ data: this.data.table.shareCode });
        }
        if (res.tapIndex === 2) {
          this.openJoin();
        }
      }
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
