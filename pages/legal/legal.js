const config = require('../../config/compliance');
const privacy = require('../../services/privacy');

Page({
  data: { ...config, requestingConsent: false, agreed: false },
  onLoad(options) { this.setData({ requestingConsent: options.consent === '1' }); },
  onUnload() { privacy.resetConsentNavigation(); },
  onAgreement(event) { this.setData({ agreed: event.detail.value.includes('agree') }); },
  accept() {
    if (!this.data.agreed) return;
    wx.removeStorageSync('mahjong_table_list_cache_v1');
    wx.removeStorageSync('mahjong_tables_v1');
    privacy.accept();
    const target = wx.getStorageSync('mahjong_privacy_return');
    wx.removeStorageSync('mahjong_privacy_return');
    wx.reLaunch({ url: typeof target === 'string' && /^\/pages\/(create|join|room)\//.test(target) ? target : '/pages/home/home' });
  },
  decline() {
    privacy.revoke();
    wx.reLaunch({ url: '/pages/home/home' });
  },
  copyContact() { wx.setClipboardData({ data: config.contactEmail }); }
});
