const store = require('../../services/store');
const { formatTime } = require('../../utils/format');

Page({
  data: {
    tableId: '',
    table: {},
    players: [],
    records: [],
    settlement: null
  },

  onLoad(options) {
    this.setData({ tableId: options.id || '' });
  },

  onShow() {
    this.loadDetail();
  },

  async loadDetail() {
    let table = null;
    if (this.data.tableId) {
      table = await store.getTable(this.data.tableId);
    } else {
      const tables = await store.listTables();
      table = tables[0] || null;
    }
    if (!table) {
      this.setData({ table: {}, players: [], records: [] });
      return;
    }
    this.setData({
      table: {
        ...table,
        statusText: table.status === 'active' ? '进行中' : '已结束'
      },
      players: store.sortPlayers(table.players),
      settlement: table.settlement || null,
      records: table.records.map((record) => ({
        ...record,
        isSettlement: record.type === 'settlement',
        timeText: formatTime(record.createdAt),
        statusText: record.revoked ? '已撤销' : ''
      }))
    });
  }
});
