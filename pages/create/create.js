const store = require('../../services/store');

Page({
  data: {
    name: '麻将计分桌',
    playerNames: ['我', '玩家2', '玩家3', '玩家4']
  },

  onNameInput(event) {
    this.setData({ name: event.detail.value });
  },

  onPlayerInput(event) {
    const index = event.currentTarget.dataset.index;
    const playerNames = this.data.playerNames.slice();
    playerNames[index] = event.detail.value;
    this.setData({ playerNames });
  },

  async createTable() {
    const table = await store.createTable({
      name: this.data.name.trim() || '麻将计分桌',
      playerNames: this.data.playerNames
    });
    wx.redirectTo({
      url: `/pages/room/room?id=${table.id}`
    });
  }
});
