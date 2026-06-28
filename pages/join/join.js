const store = require('../../services/store');

Page({
  data: {
    tableId: '',
    table: {},
    players: [],
    selectedId: '',
    name: ''
  },

  onLoad(options) {
    this.setData({ tableId: options.id || '' });
    this.loadTable();
  },

  async loadTable() {
    const table = await store.getTable(this.data.tableId);
    if (!table) {
      wx.showToast({ title: '牌局不存在', icon: 'none' });
      return;
    }
    const myPlayer = store.findMyPlayer(table);
    if (myPlayer) {
      wx.redirectTo({ url: `/pages/room/room?id=${table.id}` });
      return;
    }
    this.setData({
      table,
      players: table.players.map((player) => ({
        ...player,
        initial: player.name.slice(0, 1)
      }))
    });
  },

  selectPlayer(event) {
    const id = event.currentTarget.dataset.id;
    const player = this.data.players.find((item) => item.id === id);
    if (!player || player.openid) {
      wx.showToast({ title: '这个身份已被绑定', icon: 'none' });
      return;
    }
    this.setData({
      selectedId: id,
      name: this.data.name || player.name
    });
  },

  onNameInput(event) {
    this.setData({ name: event.detail.value });
  },

  async bindPlayer() {
    if (!this.data.selectedId) {
      wx.showToast({ title: '请选择玩家身份', icon: 'none' });
      return;
    }
    try {
      await store.joinTable(this.data.tableId, this.data.selectedId, this.data.name);
      wx.redirectTo({
        url: `/pages/room/room?id=${this.data.tableId}`
      });
    } catch (error) {
      wx.showToast({ title: error.message || '绑定失败', icon: 'none' });
    }
  }
});
