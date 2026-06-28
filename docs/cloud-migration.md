# 云开发接入说明

当前版本的页面和交互已经完成，但数据保存在本机 `wx.setStorageSync` 中。要让不同微信用户扫码进入同一牌局并实时同步，需要把 `services/store.js` 替换为云开发实现。

## 必要步骤

1. 在微信开发者工具中开通云开发。
2. 在 `app.js` 中填写云环境 ID：

```js
globalData: {
  envId: '你的云环境 ID',
  me: null
}
```

3. 创建云数据库集合：

```text
tables
players
score_records
```

4. 增加一个云函数 `login`，返回调用者 `openid`。
5. 将 `services/store.js` 中的本地读写替换为云数据库读写。

## 云端计分建议

给分必须在云函数里完成，避免两个用户同时计分时分数覆盖。

输入：

```js
{
  tableId,
  fromPlayerId,
  toPlayerId,
  amount
}
```

云函数内执行：

```text
1. 校验牌局存在且 status 为 active。
2. 校验调用者 openid 已绑定 fromPlayerId。
3. 校验 fromPlayerId 和 toPlayerId 不相同。
4. 写入 score_records。
5. fromPlayer score -= amount。
6. toPlayer score += amount。
```

## 实时同步

第一版可以在 `pages/room/room.js` 中定时刷新：

```js
setInterval(() => this.loadTable(), 3000)
```

后续再升级为云数据库 watch 监听。
