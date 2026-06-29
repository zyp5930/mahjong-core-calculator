App({
  globalData: {
    envId: 'cloudbase-d6grnpgowa641981a',
    me: null
  },

  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({
        env: this.globalData.envId || undefined,
        traceUser: true
      });
    }
  }
});
