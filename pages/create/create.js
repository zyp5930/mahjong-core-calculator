const store = require('../../services/store');

function redirectTo(url) {
  return new Promise((resolve, reject) => {
    wx.redirectTo({
      url,
      success: resolve,
      fail: reject
    });
  });
}

Page({
  data: {
    name: '麻将计分桌',
    creating: false
  },

  onNameInput(event) {
    this.setData({ name: event.detail.value });
  },

  async createTable() {
    if (this.data.creating) return;
    this.setData({ creating: true });
    wx.showLoading({ title: '创建中' });
    try {
      const table = await store.createTable({
        name: this.data.name.trim() || '麻将计分桌',
        playerNames: ['我']
      });
      if (!table || !table.id) throw new Error('牌局创建结果异常');
      await redirectTo(`/pages/room/room?id=${table.id}&autoInvite=1`);
    } catch (error) {
      wx.showModal({
        title: '创建牌局失败',
        content: (error && error.message) || '请检查云开发配置',
        showCancel: false
      });
    } finally {
      wx.hideLoading();
      this.setData({ creating: false });
    }
  }
});
