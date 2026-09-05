# TraceNote

TraceNote 是一个面向 `api_audit_log` 的审计报告控制台：先读汇总与关键发现，再看失败趋势、重复模式及代表请求。后端读取 MySQL 审计表，浏览器使用 Rust WebAssembly 计算失败排序、集中度和趋势摘要。同时提供 Telegram Bot，用来监控 `bid`，统计每天 `status_code = 400` 的调用并输出日报和排名。

Web 分析页统一把 `status_code = 200` 视为成功，把 `status_code != 200` 视为错误。这个口径适用于仪表盘汇总、时间趋势、状态码分布、热点排行和最新错误列表。

## 现在包含什么

- `/` 中英文报告优先视图，灰浅蓝页眉、灰红字标与方形报告图标，配合白色正文、衬线标题、右侧目录和原有审计数据；页脚以小字署名 allen flux
- 可切换失败数量 / 失败率的交互 SVG 趋势图，支持键盘逐小时查看与精确数据表
- 学术统计风格的接口散点图、接口失败 Pareto 图、Method 成功／失败构成图，标明坐标单位、统计分母与返回数据范围
- 完整窗口内的高频失败模式、覆盖率及代表请求；支持次数、服务端失败、最大耗时排序
- 一键导出 Markdown 汇总报告，包含分析窗口、筛选条件、结论及样本标识
- 高级筛选、其他维度及原始明细折叠展示，明细展开后才请求数据
- Rust WebAssembly 分析模块，加载失败时自动使用相同算法的 JavaScript 实现
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

## 典型失败与统计口径

仪表盘的 `failure_patterns` 按 `method + path + status_code + error_code` 分组，空值和去除首尾空格后为空的错误码统一为 `null`。计数来自完整筛选窗口，按出现次数取前 12 类，不从“最新 8 条”推算。每类返回次数、全部失败中的占比、首末出现时间、平均和最大耗时，以及组内 **ID 最大** 的代表记录。它代表最新入库样本，未必是请求时间最新或耗时最大的那条。

分组区分字符串大小写，例如 `/Generate` 与 `/generate` 属于不同模式，即使源表采用大小写不敏感的排序规则。

`failure_pattern_coverage` 返回总模式数、返回模式数、覆盖失败数及占比。分组、覆盖统计与样本在同一 SQL 语句读取，避免三者在写入期间使用不同快照；仪表盘其他指标仍为独立查询。页面排序只在返回的高频模式内切换，服务端失败优先指 HTTP 500–599；最大耗时排序比较该类的最大耗时。分组描述重复特征，不代表已经确认根因。

点击“查看代表请求”会打开完整审计详情，优先显示响应体。报告导出不包含请求/响应正文，筛选条件中的 API Key 使用掩码。

## WebAssembly 开发与验证

`static/analytics.wasm` 已随源码提供，现有静态资源部署和 Docker 镜像会直接包含它。修改 Rust 分析算法后重新构建：

```bash
rustup target add wasm32-unknown-unknown
bash scripts/build-wasm.sh
node scripts/test-analytics.mjs
node scripts/test-scientific-charts.mjs
node scripts/check-static.mjs
cargo test
```

浏览器回归测试使用本地模拟数据，无需数据库；安装 `playwright` 并准备 Chrome 后运行 `node scripts/test-report.mjs`。可通过 `PLAYWRIGHT_MODULE` 指定模块位置，通过 `CHROME_EXECUTABLE` 指定浏览器。

数据库集成测试默认跳过；准备独立临时数据库并设置 `LOGARK_TEST_DATABASE_URL` 后，运行 `cargo test failure_patterns_execute_against_full_window_fixture -- --ignored`。该测试使用临时表，覆盖完整窗口、分组归一化、大小写差异和样本覆盖率。

算法、回退行为和 ABI 见 [analytics-wasm/README.md](analytics-wasm/README.md)。计算在浏览器本地执行，WASM 与 JavaScript 使用一致的数值规则。

视觉参考、字体替代与图表统计口径见 [docs/visual-design.md](docs/visual-design.md)。新增图表使用已有接口与 Method 聚合，不增加数据库查询；散点图只描述返回的含失败接口，Pareto 图展示前 8 个接口，累计占比仍以完整窗口的失败数为分母。分母缺失或小于已展示计数时，保留计数并明确显示累计占比不可用。

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
