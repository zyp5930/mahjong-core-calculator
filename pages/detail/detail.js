const store = require('../../services/store');
const { formatTime } = require('../../utils/format');

Page({
  data: {
    tableId: '',
    table: {},
    records: [],
    loading: true,
    loadError: ''
  },

  onLoad(options) {
    this.setData({ tableId: options.id || '' });
    try {
      this.getOpenerEventChannel().on('detailTableSnapshot', ({ table }) => {
        if (!table || this.detailLoadedFromCloud) return;
        this.applyDetailTable(table, true);
      });
    } catch (error) {
      // The page may be opened without an event channel, for example by a direct link.
    }
  },

  onShow() {
    this.loadDetail();
  },

  async loadDetail() {
    const loadGeneration = (this.detailLoadGeneration || 0) + 1;
    this.detailLoadGeneration = loadGeneration;
    this.setData({ loading: true, loadError: '' });
    let table = null;
    try {
      if (this.data.tableId) {
        table = await store.getTable(this.data.tableId);
      } else {
        const tables = await store.listTables();
        table = tables[0] || null;
      }
    } catch (error) {
      if (loadGeneration !== this.detailLoadGeneration) return;
      console.error('[detail load failed]', error);
      this.setData({
        loading: false,
        loadError: error.message || '明细加载失败，请重试'
      });
      return;
    }
    if (loadGeneration !== this.detailLoadGeneration) return;
    this.detailLoadedFromCloud = true;
    if (!table) {
      this.setData({
        table: {},
        records: [],
        loading: false
      });
      return;
    }
    this.applyDetailTable(table, false);
  },

  applyDetailTable(table, loading) {
    this.setData({
      table: {
        ...table,
        statusText: table.status === 'active' ? '进行中' : (table.settlementStatus === 'pending' ? '待结算' : '已结束')
      },
      records: (table.records || [])
        .filter((record) => record.type !== 'settlement')
        .map((record) => ({
          ...record,
          timeText: formatTime(record.createdAt),
          statusText: record.revoked ? '已撤销' : ''
        })),
      loading,
      loadError: ''
    });
  },

  retryLoadDetail() {
    this.detailLoadedFromCloud = false;
    this.loadDetail();
  },

});
