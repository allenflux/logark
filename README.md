# LogArk

LogArk 现在是一个面向 `api_audit_log` 的审计分析控制台：后端读取 MySQL 审计表，前端重点展示非 200 错误率、错误趋势、热点维度和单条请求详情。同时也提供一个 Telegram Bot，用来监控 `bid`，统计每天 `status_code = 400` 的调用并输出日报和排名。

Web 分析页统一把 `status_code = 200` 视为成功，把 `status_code != 200` 视为错误。这个口径适用于仪表盘汇总、时间趋势、状态码分布、热点排行和最新错误列表。

## 现在包含什么

- `/` 基于 Bootstrap 5 + Bootstrap Icons 的中英文非 200 解释性报告
- 原生 SVG 每小时拦截量折线图与非 200 / 200 占比图
- `GET /api/dashboard` 非 200 错误聚合分析接口
- `GET /api/records` 最近记录列表，支持 `non_200=true` 并使用游标翻页
- `GET /api/records/:id` 按主键查询详情
- `GET /api/records/request/:request_id` 按 `request_id` 查询详情
- `GET /api/records/uuid/:uuid` 按 `uuid` 查询详情
- `GET /health` 健康检查
- MySQL `api_audit_log` 表初始化
- `api_audit_log` 滚动 30 天自动清理
- Telegram Bot：`bid` 监控、日报和排名

## 为什么这样设计

目标不是做一个“所有查询都开放”的后台，而是优先让低配数据库也能稳定跑起来，所以后端做了几层约束：

- 默认只查最近 24 小时
- 时间窗口有上限，避免无限制扫大表
- 仪表盘接口走聚合查询，不拉全量明细
- 仪表盘结果做短 TTL 内存缓存，降低重复查询压力
- 最近记录列表用游标翻页，不用高 offset
- 列表接口只取摘要字段，详情页才查大字段
- path 过滤用前缀匹配，尽量利用 `(path, request_ts)` 索引
- 过期审计记录按 `request_ts` 索引小批量删除，避免单次大事务

## 快速启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后打开：

- [http://127.0.0.1:7700](http://127.0.0.1:7700)

如果只想本地跑 Web：

```bash
cargo run --bin logark-server
```

如果只想本地跑 Telegram Bot：

```bash
cargo run --bin logark-tg-bot
```

## 关键配置

- `DATABASE_URL` MySQL 连接串
- `LOGARK_DB_MAX_CONNECTIONS` 连接池大小
- `LOGARK_ANALYTICS_CACHE_TTL_SECS` 仪表盘缓存秒数
- `LOGARK_DEFAULT_WINDOW_HOURS` 默认分析窗口
- `LOGARK_MAX_WINDOW_HOURS` 最大分析窗口
- `LOGARK_MAX_LIST_LIMIT` 单次最多返回多少条记录
- `LOGARK_SLOW_REQUEST_MS` 慢请求阈值，便于后续扩展
- `LOGARK_AUDIT_RETENTION_DAYS` 审计日志保留天数，默认 `30`
- `LOGARK_AUDIT_CLEANUP_INTERVAL_SECS` 自动清理间隔，默认 `3600` 秒
- `LOGARK_AUDIT_CLEANUP_BATCH_SIZE` 每批删除行数，默认 `1000`，最大 `10000`
- `TG_BOT_TOKEN` Telegram 机器人 token
- `TG_CHAT_ID` 每日自动推送的 chat id
- `TG_REPORT_HOUR` 每天几点发日报
- `TG_REPORT_MINUTE` 每天几分发日报
- `TG_TIMEZONE_OFFSET_HOURS` 报表时区，默认 `8`
- `TG_DEFAULT_REPORT_LIMIT` 日报默认取前多少个 bid

## 接口示例

健康检查：

```bash
curl http://127.0.0.1:7700/health
```

最近 24 小时仪表盘：

```bash
curl 'http://127.0.0.1:7700/api/dashboard?hours=24'
```

按 path 前缀查询最近记录：

```bash
curl 'http://127.0.0.1:7700/api/records?hours=24&path=/api/v1/task&limit=20'
```

只查询非 200 记录：

```bash
curl 'http://127.0.0.1:7700/api/records?hours=24&non_200=true&limit=20'
```

同时传入 `status_code` 和 `non_200=true` 时，精确的 `status_code` 条件优先。

## 数据保留

`logark-server` 成功绑定监听端口后会自动启动清理任务：启动时立即执行一次，之后默认每小时执行。每轮固定计算一次边界，删除满足以下条件的记录：

```sql
request_ts < 当前 UTC 毫秒时间 - 30 × 24 小时
```

清理只作用于 `api_audit_log`，不会删除保存 Telegram 监控配置的 `tg_bid_watch`。删除按 `request_ts` 从旧到新每批自动提交，批间暂停 50 ms；每组最多执行 100 批，仍有积压时暂停 30 秒后继续追赶。单次失败只记录日志，HTTP 服务不会退出，并会在下一个周期重试。

按 ID 查详情：

```bash
curl 'http://127.0.0.1:7700/api/records/1001'
```

## Telegram Bot 指令

- `/report [N]` 查看前一天 `status=400` 的 bid 排行
- `/report_today [N]` 查看今天到当前的排行
- `/bid <bid>` 查看某个 bid 今天的 `status=400` 统计
- `/watch add <bid> [note]` 把 bid 加入监控
- `/watch remove <bid>` 取消监控
- `/watch list` 查看监控列表
- `/watched` 查看监控 bid 今天的异常摘要

## 表结构

项目会确保存在这张表：

- `api_audit_log`
- `tg_bid_watch`

字段与索引定义在 [`migrations/001_init.sql`](/Users/allenflux/RustroverProjects/logark/migrations/001_init.sql:1)。

## 项目结构

```text
cmd/logark-server   服务入口
cmd/logark-tg-bot   Telegram Bot 入口
internal/config     配置
internal/bot        Telegram Bot 逻辑
internal/db         MySQL 连接与表初始化
internal/handler    HTTP 路由与接口
internal/model      数据结构
internal/retention  审计日志定时清理
internal/service    分析查询与缓存
static              前端页面
migrations          表结构 SQL
```
