# TraceNote

TraceNote 是一个面向 `api_audit_log` 的审计报告控制台：先读汇总与关键发现，再看失败趋势、重复模式及代表请求。后端读取 MySQL 审计表，浏览器使用 Rust WebAssembly 计算失败排序、集中度和趋势摘要。同时提供 Telegram Bot，用来监控 `bid`，统计每天 `status_code = 400` 的调用并输出日报和排名。

Web 分析页统一把 `status_code = 200` 视为成功，把 `status_code != 200` 视为错误。这个口径适用于仪表盘汇总、时间趋势、状态码分布、热点排行和最新错误列表。

## 现在包含什么

- `/` 中英文报告优先视图，灰浅蓝页眉、灰红字标与方形报告图标，配合白色正文、衬线标题、右侧目录和原有审计数据；页脚以小字署名 allen flux
- 可切换失败数量 / 失败率的交互 SVG 趋势图，支持键盘逐小时查看与精确数据表
- 学术统计风格的接口散点图、接口失败 Pareto 图、Method 成功／失败构成图，标明坐标单位、统计分母与返回数据范围
- 完整窗口内的高频失败模式、覆盖率及代表请求；支持次数、服务端失败、最大耗时排序
- API Key 错误率排名及各 Key 的失败路由分布，页面显示完整 Key，可直接复制和筛选
- 点击失败路由展开该 Key 的高频错误排行，按错误类型查看次数、占比及典型请求
- 一键导出 Markdown 汇总报告，包含分析窗口、筛选条件、结论及样本标识
- 高级筛选、其他维度及原始明细折叠展示，明细展开后才请求数据
- Rust WebAssembly 分析模块，加载失败时自动使用相同算法的 JavaScript 实现
- `GET /api/dashboard` 非 200 错误聚合分析接口
- `GET /api/key-route-errors` 指定 Key、精确路由和报告时间范围内的高频错误与代表请求
- `GET /api/records` 最近记录列表，支持 `non_200=true` 并使用游标翻页
- `GET /api/records/:id` 按主键查询详情
- `GET /api/records/request/:request_id` 按 `request_id` 查询详情
- `GET /api/records/uuid/:uuid` 按 `uuid` 查询详情
- `GET /health` 健康检查
- MySQL `api_audit_log` 表初始化
- `api_audit_log` 滚动 14 天自动清理
- Telegram Bot：`bid` 监控、日报和排名

## 为什么这样设计

目标不是做一个“所有查询都开放”的后台，而是优先让低配数据库也能稳定跑起来，所以后端做了几层约束：

- 默认只查最近 24 小时
- 时间窗口有上限，避免无限制扫大表
- 仪表盘接口走聚合查询，不拉全量明细
- 仪表盘按周期和规范化筛选复用内存缓存，TTL 从计算完成后开始；同范围并发请求共用一次计算
- 最近记录列表用游标翻页，不用高 offset
- 列表接口只取摘要字段，详情页才查大字段
- path 过滤用前缀匹配，尽量利用 `(path, request_ts)` 索引
- 过期审计记录按 `request_ts` 索引小批量删除，避免单次大事务

## 报告刷新与性能

每份未缓存报告需要多项 MySQL 聚合，首次读取或缓存过期后仍取决于数据库速度。缓存键不含滚动时间桶，默认在一次完整计算结束后复用结果 15 秒；`LOGARK_ANALYTICS_CACHE_TTL_SECS=0` 关闭完成结果复用。同范围正在进行的计算仍会合并，浏览器离开或取消旧请求不会使其他等待者重新计算。缓存最多保留 64 个范围，完整报告并发按连接池大小限制为 1–2 份，避免每份报告的 9 个查询分支持续挤满连接池。

`LOGARK_ANALYTICS_QUERY_TIMEOUT_SECS` 限制每份报告开始执行后的应用等待时间，默认 300 秒；超时会停止 Rust 计算任务并允许重试，已经提交的 SQL 可能继续在数据库执行。服务日志按 `query`、`elapsed_ms`、`success` 记录各聚合项与整体计算，整体还记录 `queue_ms`；不会打印筛选值或审计正文。设置 `RUST_LOG=info,logark::service::dashboard_cache=debug` 可观察缓存命中与请求合并。

P95 使用精确最近秩：先按整数耗时统计频数，再按耗时降序累计，选择累计数量首次超过 `floor(N / 20)` 的耗时。计数与排名来自同一 SQL 快照，保留重复值，不做抽样或近似；排序面向频数组，不再通过 OFFSET 读取大量原始行。耗时几乎全部不同时，仍可能产生较大的临时表。

大表的首次查询依靠两个报表覆盖索引减少对请求/响应正文所在数据页的访问：`idx_report_summary` 覆盖汇总、时间序列和各维度所需字段，`idx_report_failures` 覆盖默认范围内的失败分组，再仅按代表 ID 读取少量样本。带 API Key 或任务类型筛选的失败分组可能仍需回表，原有选择性索引继续保留。

任务类型汇总在没有指定任务类型时排除旧的 `idx_task_type_request_ts`，避免优化器仅因 `IS NOT NULL` 选择非覆盖索引、大量回表；明确筛选任务类型时仍允许使用该选择性索引。

新数据库由 `001_init.sql` 创建这些索引；已有数据库需经容量检查后执行一次 [`migrations/002_report_indexes.sql`](migrations/002_report_indexes.sql)。该迁移使用 `ALGORITHM=INPLACE, LOCK=NONE`，不修改业务行；建立索引期间仍会增加 CPU、I/O 和临时空间占用。服务启动时不会自动运行这次大表索引构建。迁移文件同时列出仅删除新增索引的回滚 SQL。

失败分组使用窗口统计，在一次 GROUP BY 后计算全窗口模式数与失败总数，再截取前 12 类；不再对同一窗口分组两次。此查询需要支持窗口函数的 MariaDB 10.2+ / MySQL 8.0+，已在 MariaDB 11.4 验证。可用 [`scripts/benchmark-report-indexes.py`](scripts/benchmark-report-indexes.py) 在自动清理的本机 MariaDB 容器中复现宽表基准、索引覆盖及结果一致性检查；不要将本机倍率视为线上性能保证。

刷新期间保留当前报告、导出及明细，界面标明已完成报告的实际范围；新报告返回后才切换范围。失败时也保留旧结果供查看与重试。相同筛选的进行中请求去重，切换范围取消旧 HTTP 等待，迟到响应不会覆盖新报告；不将审计数据写入浏览器持久存储。

### 可选 Redis 共享缓存

设置 `LOGARK_REDIS_URL` 后，成功报告会进入 Redis，共享给后续请求和重新启动的服务实例。`LOGARK_REDIS_CACHE_TTL_SECS` 默认 60 秒，从计算完成起算；读取不续期，本机缓存命中 Redis 后只保留两级缓存剩余有效期的较小值。Redis 查询在数据库并发队列之前执行，缓存命中不会被其他筛选的慢 SQL 阻挡。Redis 操作默认最多等待 200 ms，由 `LOGARK_REDIS_OPERATION_TIMEOUT_MS` 控制；连接失败、超时或坏缓存均自动回退数据库。未配置连接或 Redis TTL 为 0 时保持仅内存缓存。

启动日志 `report cache configured` 会输出 `redis_enabled` 和两级缓存的 TTL，不输出连接地址或密码。`redis_enabled=false` 表示该进程未启用 Redis；后续报告日志 `source="shared_cache"` 才表示实际命中共享缓存。仅默认 Compose 文件不会加载 `.env.redis`，使用下方覆盖文件命令注入该私有配置。

缓存键包含版本、数据库身份与全部规范化筛选的 SHA-256 摘要，不包含明文 API Key。缓存值包含报告及其代表请求摘要，因此应使用私有连接配置；不缓存请求/响应正文。缓存最长可复用默认 60 秒，页面继续显示报告真实时间范围。首次计算、过期或 Redis 不可用时仍需查询数据库。

把连接配置放在本机 `.env.redis`（已从 Git 和 Docker 构建上下文排除），例如 `LOGARK_REDIS_URL=redis://:URL编码后的密码@主机:端口/0`。本机启动先读取 `.env.redis` 再读取 `.env`，显式进程环境优先。Compose 部署时把私有配置单独放到应用服务器的项目目录，使用可选覆盖文件：

```bash
docker compose -f docker-compose.yml -f docker-compose.redis.yml up -d --build logark-server
```

[`examples/report_probe.rs`](examples/report_probe.rs) 可通过 `cargo run --example report_probe -- 24` 检查真实报告计算与跨实例缓存耗时，只输出时间与汇总计数；它不会执行数据库迁移、记录清理或启动机器人，配置 Redis 时会写入正常的报告缓存。

2026-09-05 实测：在线建立两条索引耗时 34.6 秒；24 小时约 95.6 万条请求，本机新版后端连接真实数据库的完整冷计算为 6.9–8.9 秒，另一个服务实例读取同一 Redis 报告为 26–29 ms。固定时间窗的 P95 新旧结果均为 465 ms，查询耗时由 10.3–14.3 秒降到 0.40 秒。这些是当时负载下的探针结果；线上旧后端仅加索引后的接口仍为 18.9–32.9 秒，必须部署新版后端才能使用查询改写和 Redis。冷计算仍受数据量与数据库负载影响。

## 典型失败与统计口径

仪表盘的 `failure_patterns` 按 `method + path + status_code + error_code` 分组，空值和去除首尾空格后为空的错误码统一为 `null`。计数来自完整筛选窗口，按出现次数取前 12 类，不从“最新 8 条”推算。每类返回次数、全部失败中的占比、首末出现时间、平均和最大耗时，以及组内 **ID 最大** 的代表记录。它代表最新入库样本，未必是请求时间最新或耗时最大的那条。

分组区分字符串大小写，例如 `/Generate` 与 `/generate` 属于不同模式，即使源表采用大小写不敏感的排序规则。

`failure_pattern_coverage` 返回总模式数、返回模式数、覆盖失败数及占比。分组、覆盖统计与样本在同一 SQL 语句读取，避免三者在写入期间使用不同快照；仪表盘其他指标仍为独立查询。页面排序只在返回的高频模式内切换，服务端失败优先指 HTTP 500–599；最大耗时排序比较该类的最大耗时。分组描述重复特征，不代表已经确认根因。

点击“查看代表请求”会打开完整审计详情，优先显示响应体。报告导出不包含请求/响应正文，筛选条件中的 API Key 使用掩码。

### API Key 失败分析

`api_key_analysis` 使用完整筛选窗口，排除 `NULL` 和纯空白 Key，按原始字节区分 Key 与路由的大小写，不去掉非空 Key 的首尾空白。错误率为该 Key 的非 200 请求数 / 该 Key 的全部请求数；按错误率、失败数、总请求数降序，再按 Key 稳定排序，返回前 20 个有失败的 Key，不设最小样本量。页面同时显示分子、分母，避免把少量请求的 100% 与大量失败混为一谈。

每个 Key 的路由合并不同 HTTP 方法，按失败数、总请求数降序及路径排序取前 5 个失败路由。路由错误率以该 Key 该路由的总请求为分母，失败占比以该 Key 的全部失败为分母；`affected_routes` 包含未展示的失败路由，`returned_route_errors` 仅累计已展示路由。全局 Key 数、请求数及失败数也包含 Top 20 之外的 Key。零失败窗口仍返回这些全局总量。

新查询替换原 API Key 查询，只扫描一次现有报表覆盖索引所含字段，并在限制排名前用窗口函数计算各级分母；兼容字段 `top_error_api_keys` 仍返回失败次数最多的 8 个 Key。查询与分母来自同一 SQL 快照。Redis 报告缓存版本已更新，旧报告不会缺少该字段。页面、复制和详情显示明文 Key；导出的 Markdown 报告只保留 Key 前后各 4 位，短 Key 完全隐藏。

点击右侧路由的“查看 Top 错误”，在宽屏明细面板中按 HTTP 方法、状态码和业务错误码列出出现最多的 12 类错误。次数与占比来自该 Key 在这条精确路由内的全部非 200 请求，包含未展示的类型；路径前缀相似、大小写不同或其他 Key 的请求不会混入。左侧选择错误类型，右侧直接显示对应的最新入库代表请求，可切换响应体、请求体和两类请求头；更多请求属性可展开。手机使用纵向布局，长列表和正文可滚动，关闭后回到报告原位置。没有业务错误码时，同方法、同状态码的请求归为一类，界面明确说明其可能包含不同原因；单条样本响应不代表整组的共同原因。

明细接口要求 `api_key`、`path`、`from_ts`、`to_ts`，时间为报告返回的毫秒时间戳；可附带报告已应用的 `method` 和 `task_type`。明细只在点击时请求，使用固定报告时间范围，保留内存缓存、同范围请求合并及可选 Redis 缓存。打开后自动读取首个代表请求，其余请求在选中时读取；切换语言或重复打开已完成的路由与样本复用本页缓存。新报告成功返回后清除页面旧明细，不增加首页报表的查询分支。

等待期间使用骨架、轻量动画和真实经过秒数，区分“统计错误排行”与“读取代表请求”，长等待时保留返回报告的入口；不模拟百分比。遵循系统减少动画偏好。正文按原文换行显示，若日志自身标记 `request_body_truncated` / `response_body_truncated`，会提示保存时已截断，避免与页面显示范围混淆。

“复制特征”和“复制 Key”优先使用浏览器剪贴板接口；普通 HTTP 或权限不允许时尝试兼容复制，仍失败则显示已选中的只读文本供手动复制，不再把复制问题显示为报告加载失败。

## WebAssembly 开发与验证

`static/analytics.wasm` 已随源码提供，构建服务时会与 HTML、脚本、样式和图标一起嵌入可执行文件。修改 Rust 分析算法后重新构建：

```bash
rustup target add wasm32-unknown-unknown
bash scripts/build-wasm.sh
node scripts/test-analytics.mjs
node scripts/test-scientific-charts.mjs
node scripts/check-static.mjs
cargo test
```

浏览器回归测试使用本地模拟数据，无需数据库；安装 `playwright` 并准备 Chrome 后运行 `node scripts/test-report.mjs`。独立剪贴板兼容测试为 `node scripts/test-clipboard.mjs`，覆盖普通 HTTP、权限拒绝及手动复制。可通过 `PLAYWRIGHT_MODULE` 指定模块位置，通过 `CHROME_EXECUTABLE` 指定浏览器。

数据库集成测试默认跳过；准备独立临时数据库并设置 `LOGARK_TEST_DATABASE_URL` 后，运行 `cargo test failure_patterns_execute_against_full_window_fixture -- --ignored`。该测试使用临时表，覆盖完整窗口、分组归一化、大小写差异和样本覆盖率。

API Key 的隔离数据库测试为 `cargo test api_key_analysis_preserves_full_denominators_and_exact_identities -- --ignored`，使用会话临时表，验证大小写与尾空格身份、HTML 字符串、空白 Key、全部筛选、零失败、Top 20 / Top 5 截断及完整分母。已在 MariaDB 11.4.13、`ONLY_FULL_GROUP_BY` 模式验证；测试不连接线上数据库。

路由错误明细测试为 `cargo test key_route_patterns_preserve_scope_full_denominators_and_newest_samples -- --ignored`，使用同类隔离数据库，验证精确 Key/路由、字面通配符、时间及方法/任务筛选、Top 12 的完整分母和样本归属。

算法、回退行为和 ABI 见 [analytics-wasm/README.md](analytics-wasm/README.md)。计算在浏览器本地执行，WASM 与 JavaScript 使用一致的数值规则。

视觉参考、字体替代与图表统计口径见 [docs/visual-design.md](docs/visual-design.md)。新增图表使用已有接口与 Method 聚合，不增加数据库查询；散点图只描述返回的含失败接口，Pareto 图展示前 8 个接口，累计占比仍以完整窗口的失败数为分母。分母缺失或小于已展示计数时，保留计数并明确显示累计占比不可用。

### 前端发布与浏览器缓存

服务从同一可执行文件提供 HTML、语言包、脚本、样式、WASM 和图标，不再从运行目录读取 `static/`。修改前端后需重新构建并重启服务，Docker 部署使用 `docker compose up -d --build`；仅复制新的 `static/` 文件不会更新页面。

构建内的全部前端内容共同生成 SHA-256 版本。HTML 使用 `/assets/<版本>/…` 并返回 `Cache-Control: no-cache`，浏览器加载页面时会重新验证；版本资源可长期缓存，任何前端内容变化都会更换 URL，避免新页面混用旧语言包或旧脚本。WASM 从其脚本所在版本目录加载。旧固定资源 URL 保留兼容并返回 `no-cache`；不存在的资源或不匹配的版本返回 404，不会静默替换成另一版文件。

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
- `LOGARK_ANALYTICS_CACHE_TTL_SECS` 完整报告计算结束后的缓存秒数，默认 `15`
- `LOGARK_ANALYTICS_QUERY_TIMEOUT_SECS` 完整报告计算超时，默认 `300` 秒，范围 `1–3600`
- `LOGARK_DEFAULT_WINDOW_HOURS` 默认分析窗口
- `LOGARK_MAX_WINDOW_HOURS` 最大分析窗口
- `LOGARK_MAX_LIST_LIMIT` 单次最多返回多少条记录
- `LOGARK_SLOW_REQUEST_MS` 慢请求阈值，便于后续扩展
- `LOGARK_AUDIT_RETENTION_DAYS` 审计日志保留天数，默认 `14`
- `LOGARK_AUDIT_CLEANUP_INTERVAL_SECS` 自动清理间隔，默认 `3600` 秒
- `LOGARK_AUDIT_CLEANUP_BATCH_SIZE` 每批删除行数，默认 `1000`，最大 `10000`
- `TG_BOT_TOKEN` Telegram 机器人 token
- `TG_CHAT_ID` 每日自动推送的 chat id
- `TG_REPORT_HOUR` 每天几点发日报
- `TG_REPORT_MINUTE` 每天几分发日报
- `TG_TIMEZONE_OFFSET_HOURS` 报表时区，默认 `8`
- `TG_DEFAULT_REPORT_LIMIT` 日报默认取前多少个 bid

## 接口示例

健康检查只执行 `SELECT 1` 验证数据库连接，连接池等待与查询合计最多 2 秒，避免定时健康检查全表统计与报表争抢资源。就绪返回 HTTP `200` / `status: "ok"`，数据库不可用或超时返回 HTTP `503` / `status: "unavailable"`，Docker 会据此判断健康状态。响应保留 `total_records`、`latest_request_ts` 字段以兼容已有结构，但二者始终为 `null`，不再提供全表统计；报表统计请使用仪表盘接口。

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
request_ts < 当前 UTC 毫秒时间 - 14 × 24 小时
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
