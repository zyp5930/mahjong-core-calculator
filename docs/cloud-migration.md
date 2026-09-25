# 云开发部署

当前版本通过 login、tableOps、tableCode 云函数提供计分服务，不再使用客户端数据库 watch。成员每5秒通过受权限检查的接口同步。

**请按 [上线交付清单](release-checklist.md) 的顺序创建辅助集合、配置仅服务端访问规则，再部署全部云函数和客户端。** 不要再使用“所有用户可读写”或开发测试权限。

集合：tables、request_limits、privacy_jobs、privacy_locks、legacy_avatar_files。

服务端依赖已固定 wx-server-sdk 4.0.2。tableOps/config.json 声明文本安全检测权限，tableCode/config.json 声明小程序码权限。库版本、云调用权限、事务、索引必须在测试云环境验证。

云环境 ID 在 app.js；已有 ID 未修改。二维码环境变量 MINIPROGRAM_ENV_VERSION 在测试环境设置 trial，在正式环境设置 release（默认值）。不要把正式发布连接到旧云函数或宽松权限的测试环境。
