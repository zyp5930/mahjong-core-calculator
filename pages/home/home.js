const store = require('../../services/store');
const { formatDuration, formatTime } = require('../../utils/format');

Page({
  data: {
    tables: []
  },

  onShow() {
    this.loadTables();
  },

  async loadTables() {
    const tables = await store.listTables();
    this.setData({
      tables: tables.map((table) => ({
        ...table,
        statusText: table.status === 'active' ? '进行中' : '已结束',
        createdText: formatTime(table.createdAt),
        durationText: table.status === 'active'
          ? `已进行${formatDuration(table.createdAt)}`
          : `持续${formatDuration(table.createdAt, table.endedAt)}`,
        players: table.players.slice(0, 4).map((player) => ({
          ...player,
          initial: player.name.slice(0, 1)
        }))
      }))
    });
  },

  openTable(event) {
    const id = event.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/room/room?id=${id}`
    });
  }
});
