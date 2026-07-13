const store = require('../../services/store');
const { formatDuration, formatTime } = require('../../utils/format');

Page({
  data: {
    tables: [],
    tableGroups: [],
    expandedGroupIds: {},
    mode: 'unknown',
    modeText: '检测中'
  },

  async onShow() {
    await store.ensureMe();
    this.setData({
      mode: store.getStoredMode(),
      modeText: store.getStoredMode() === 'cloud' ? '云同步模式' : '本地模式'
    });
    this.loadTables();
  },

  async loadTables() {
    const tables = await store.listTables();
    const formattedTables = tables.map((table) => this.formatTable(table));
    this.setData({
      tables: formattedTables,
      tableGroups: this.buildTableGroups(formattedTables)
    });
  },

  formatTable(table) {
    return {
      ...table,
      statusText: table.status === 'active' ? '进行中' : '已结束',
      createdText: formatTime(table.createdAt),
      durationText: table.status === 'active'
        ? `已进行${formatDuration(table.createdAt)}`
        : `持续${formatDuration(table.createdAt, table.endedAt)}`,
      roundText: `第${Number(table.roundNo) || 1}局`,
      players: (table.players || []).slice(0, 4).map((player) => ({
        ...player,
        initial: String(player.name || '').slice(0, 1)
      }))
    };
  },

  buildTableGroups(tables) {
    const expandedGroupIds = this.data.expandedGroupIds || {};
    const groupMap = tables.reduce((map, table) => {
      const groupId = table.groupId || table.id;
      if (!map[groupId]) {
        map[groupId] = {
          groupId,
          name: table.name,
          tables: [],
          createdAt: table.createdAt || 0,
          updatedAt: table.updatedAt || table.createdAt || 0
        };
      }
      map[groupId].tables.push(table);
      map[groupId].createdAt = Math.min(map[groupId].createdAt || table.createdAt || 0, table.createdAt || 0);
      map[groupId].updatedAt = Math.max(map[groupId].updatedAt || 0, table.updatedAt || table.createdAt || 0);
      return map;
    }, {});

    return Object.values(groupMap).map((group) => {
      const sortedTables = group.tables.slice().sort((left, right) => (
        (Number(left.roundNo) || 1) - (Number(right.roundNo) || 1) ||
        (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0)
      ));
      const activeTable = sortedTables.find((table) => table.status === 'active');
      const latestTable = sortedTables[sortedTables.length - 1];
      const displayTable = activeTable || latestTable || sortedTables[0];
      const endedCount = sortedTables.filter((table) => table.status === 'ended').length;
      const settledTable = sortedTables.find((table) => table.groupSettlement);
      const groupSettlement = settledTable ? settledTable.groupSettlement : null;
      const isSettled = !!groupSettlement || sortedTables.some((table) => table.groupStatus === 'settled');
      const status = activeTable ? 'active' : 'ended';
      const statusText = activeTable ? '进行中' : (isSettled ? '已总结' : '已结束');
      return {
        ...group,
        name: displayTable.name || group.name,
        status,
        statusText,
        isSettled,
        isExpanded: !!expandedGroupIds[group.groupId],
        activeTableId: activeTable ? activeTable.id : '',
        latestTableId: latestTable ? latestTable.id : '',
        tableCount: sortedTables.length,
        endedCount,
        activeCount: activeTable ? 1 : 0,
        players: displayTable.players || [],
        tables: sortedTables,
        createdText: formatTime(group.createdAt),
        updatedText: formatTime(group.updatedAt),
        summaryText: `${sortedTables.length}局 | 已结束${endedCount}局${activeTable ? ' | 1局进行中' : ''}`
      };
    }).sort((left, right) => right.updatedAt - left.updatedAt);
  },

  toggleGroup(event) {
    const groupId = event.currentTarget.dataset.id;
    if (!groupId) return;
    this.setData({
      expandedGroupIds: {
        ...this.data.expandedGroupIds,
        [groupId]: !this.data.expandedGroupIds[groupId]
      }
    }, () => {
      this.setData({
        tableGroups: this.buildTableGroups(this.data.tables)
      });
    });
  },

  openGroupTable(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    this.openTableById(id);
  },

  openTable(event) {
    const id = event.currentTarget.dataset.id;
    this.openTableById(id);
  },

  openTableById(id) {
    wx.navigateTo({
      url: `/pages/room/room?id=${id}`
    });
  }
});
