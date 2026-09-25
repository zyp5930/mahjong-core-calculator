const config = require('../config/compliance');
const KEY = 'mahjong_privacy_consent';
let consentNavigationPending = false;

function hasConsent() {
  return wx.getStorageSync(KEY) === config.version;
}

function requireConsent() {
  if (hasConsent()) return;
  const pages = getCurrentPages();
  const current = pages[pages.length - 1];
  if (current && current.route !== 'pages/legal/legal') {
    const query = Object.entries(current.options || {}).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
    wx.setStorageSync('mahjong_privacy_return', `/${current.route}${query ? '?' + query : ''}`);
  }
  if ((!pages.length || pages[pages.length - 1].route !== 'pages/legal/legal') && !consentNavigationPending) {
    consentNavigationPending = true;
    wx.navigateTo({
      url: '/pages/legal/legal?consent=1',
      fail() { consentNavigationPending = false; }
    });
  }
  throw new Error('请先阅读并确认隐私说明后使用云同步');
}

module.exports = {
  hasConsent,
  requireConsent,
  accept() {
    consentNavigationPending = false;
    wx.setStorageSync(KEY, config.version);
  },
  revoke() {
    consentNavigationPending = false;
    wx.removeStorageSync(KEY);
  },
  resetConsentNavigation() { consentNavigationPending = false; }
};
