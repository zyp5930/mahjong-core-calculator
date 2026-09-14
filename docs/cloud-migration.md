# 云开发接入说明

当前版本已经内置云开发实现，`services/store.js` 的牌局读写统一调用云函数，失败时直接提示错误，不会回退本地模式。要让不同微信用户扫码进入同一牌局并实时同步，需要把云环境和云函数部署好。

## 必要步骤

1. 在微信开发者工具中开通云开发。
2. 在 [app.js](/Users/zyp/Documents/mahjong-core-calculator/app.js:3) 中填写云环境 ID：

```js
globalData: {
  envId: '你的云环境 ID',
  me: null
}
```

3. 创建云数据库集合：

```text
tables
```

4. 在开发者工具中分别上传并部署：

```text
cloudfunctions/login
cloudfunctions/tableOps
cloudfunctions/tableCode
```

`tableCode` 需要随目录里的 `config.json` 一起上传部署，它声明了 `wxacode.getUnlimited` 云调用权限。缺少这个文件或没有重新部署时，生成二维码会报 `-604101 function has no permission to call this API`。

5. 给 `tables` 集合设置读写权限：

```text
仅创建者可读写
```

或者开发阶段先使用更宽松的测试权限，等功能跑通后再收紧。

## 云端计分建议

当前版本已经把给分和撤销都放到了 `tableOps` 云函数里，避免两个用户同时计分时分数覆盖。

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

当前版本在 [pages/room/room.js](/Users/zyp/Documents/mahjong-core-calculator/pages/room/room.js:1) 中使用 3 秒轮询刷新。这样部署最简单，也方便你先验证多人同步链路。

后续优化建议：

- 改成数据库 `watch` 监听，减少请求次数。
- 将 `tables` 拆为 `tables` + `records` 两个集合，避免单文档越积越大。
- 增加桌主强制撤销、踢人、锁定身份等管理能力。

## 一次性数据修复（用后删除）

`tableOps` 里的 `repairScore` 动作用于补记因并发冲突等原因没有写入的给分。在云开发控制台的云函数「云端测试」中触发（桌主或控制台调用）：

```json
{
  "action": "repairScore",
  "tableId": "牌局 ID",
  "fromPlayerId": "给分玩家 ID",
  "toPlayerId": "收分玩家 ID",
  "amount": 42,
  "repairKey": "唯一标识，用于幂等",
  "createdAt": 0
}
```

- 记录 id 由 `repairKey` 决定（`repair_<repairKey>`），重复触发不会重复加分。
- 这是临时入口，修复完成后请删除 `repairScore` 函数以及 `exports.main` 中的 `repairScore` case。
