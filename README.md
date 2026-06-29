# Mahjong Core Calculator

微信原生小程序版麻将计分工具，面向个人和固定牌友使用。

## 第一版能力

- 创建牌局并生成分享码、二维码。
- 其他用户可通过分享路径或扫码进入牌局。
- 进入牌局后可设置自己的微信头像和昵称，昵称支持修改。
- 按截图风格展示玩家列表、顶部操作栏和底部给分键盘。
- 点击某个玩家的“给分”，输入分数后记为“我给对方 N 分”。
- 记录计分明细。
- 支持云开发模式下的多人扫码同步计分。

## 微信中使用

1. 用微信开发者工具以“小程序”类型导入本目录，不要选择“小游戏”。如果看到 `game.json: 未找到 game.json 文件`，说明当前是按小游戏打开了项目，请关闭后重新导入为小程序项目。
2. 将 `project.config.json` 里的 `appid` 换成你自己的小程序 AppID。
3. 如果只本机体验，可以直接编译运行；当前版本会使用本地存储模拟牌局数据。
4. 如果要让其他微信用户扫码加入同一牌局并实时同步，需要开通微信云开发，并把 [app.js](/Users/zyp/Documents/mahjong-core-calculator/app.js:3) 里的 `envId` 改成你的云环境 ID。
5. 在微信开发者工具里右键上传并部署 `cloudfunctions/login`、`cloudfunctions/tableOps` 和 `cloudfunctions/tableCode`。
6. 上传体验版后，把牌友加入体验成员；不发布到市场也可以让固定人员使用。

首页左上角会显示当前模式：

- `云同步模式`：说明 `login` 云函数调用成功，当前读写走云开发。
- `本地模式`：说明未配置云环境，或云函数未部署成功，当前只会在本机保存数据。

## 云开发集合

当前实现只依赖一个集合：

- `tables`

每桌牌局的数据都保存在一条文档里，里面包含：

- `shareCode`
- `ownerOpenid`
- `participantOpenids`
- `players`
- `records`

云函数已经内置在项目中，不需要你再手写：

- `cloudfunctions/login`
- `cloudfunctions/tableOps`

更详细的接入步骤见 [docs/cloud-migration.md](/Users/zyp/Documents/mahjong-core-calculator/docs/cloud-migration.md:1)。
