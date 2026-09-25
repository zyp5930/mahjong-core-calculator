const store = require('../../services/store');
const privacy = require('../../services/privacy');
const config = require('../../config/compliance');
Page({
  data: { ...config, deleting: false, deletionProgress: '' },
  copyContact() { wx.setClipboardData({ data: config.contactEmail }); },
  clearData() {
    wx.showModal({ title: '清除本地缓存', content: '仅清除本机缓存，不删除云端牌局或个人信息。',
      success: (res) => { if (res.confirm) { store.clearLocalData(); wx.showToast({ title: '缓存已清除' }); } }
    });
  },
  revokeConsent() {
    wx.showModal({ title: '撤回隐私同意', content: '将停止本机云同步并清除缓存。云端记录仍保留，可使用“删除我的云端个人数据”清理。',
      success: (res) => { if (res.confirm) { privacy.revoke(); store.clearLocalData(); wx.reLaunch({ url: '/pages/home/home' }); } }
    });
  },
  deleteMyData() {
    if (this.data.deleting) return;
    wx.showModal({ title: '删除我的云端个人数据',
      content: '此操作不可恢复。将解除全部牌局关联，清除昵称、身份信息和历史头像；其他成员积分保留。桌主将交给剩余成员，无剩余成员的牌局删除。中断后可再次点击继续。',
      confirmText: '确认删除', confirmColor: '#c34236',
      success: (res) => { if (res.confirm) this.runDeletion(); }
    });
  },
  async runDeletion() {
    this.setData({ deleting: true, deletionProgress: '正在清理，请保持页面打开' });
    try {
      for (let batch = 0; batch < 100; batch += 1) {
        const result = await store.deleteMyData();
        if (result.done) {
          store.clearLocalData(); privacy.revoke();
          this.setData({ deletionProgress: '云端个人数据已清理，本机同意已撤回' });
          wx.showToast({ title: '删除完成' }); return;
        }
        this.setData({ deletionProgress: `正在清理，已检查 ${result.processed || 0} 条记录` });
      }
      this.setData({ deletionProgress: '数据较多，请再次点击删除按钮继续' });
    } catch (error) { this.setData({ deletionProgress: error.message || '删除未完成，请稍后再次点击继续' }); }
    finally { this.setData({ deleting: false }); }
  }
});
