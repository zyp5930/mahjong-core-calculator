const store = require('../../services/store');
const { formatTime } = require('../../utils/format');

Page({
  data: {
    tableId: '',
    table: {},
    records: []
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
      this.setData({ table: {}, records: [] });
      return;
    }
    this.setData({
      table: {
        ...table,
        statusText: table.status === 'active' ? '进行中' : (table.settlementStatus === 'pending' ? '待结算' : '已结束')
      },
      records: table.records
        .filter((record) => record.type !== 'settlement')
        .map((record) => ({
        ...record,
        timeText: formatTime(record.createdAt),
        statusText: record.revoked ? '已撤销' : ''
      }))
    });
  }
});
