const store = require('../../services/store');

Page({
  data: {
    name: '麻将计分桌'
  },

  onNameInput(event) {
    this.setData({ name: event.detail.value });
  },

  async createTable() {
    const table = await store.createTable({
      name: this.data.name.trim() || '麻将计分桌',
      playerNames: ['我']
    });
    wx.redirectTo({
      url: `/pages/room/room?id=${table.id}&autoInvite=1`
    });
  }
});
