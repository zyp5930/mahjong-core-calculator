const store = require('../../services/store');

Page({
  copyOpenid() {
    wx.setClipboardData({
      data: store.getLocalOpenid()
    });
  },

  clearData() {
    wx.showModal({
      title: '清空本地数据',
      content: '会删除本机保存的所有牌局，确认继续吗？',
      success: (res) => {
        if (!res.confirm) return;
        wx.clearStorageSync();
        wx.showToast({ title: '已清空' });
      }
    });
  }
});
