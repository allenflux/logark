# LogArk

LogArk 现在是一个面向 `api_audit_log` 的审计分析控制台：后端读取 MySQL 审计表，前端提供趋势分析、热点维度和单条请求详情查询。

## 现在包含什么

- `/` 简洁前端分析页
- `GET /api/dashboard` 聚合分析接口
- `GET /api/records` 最近记录列表，使用游标翻页
- `GET /api/records/:id` 按主键查询详情
- `GET /api/records/request/:request_id` 按 `request_id` 查询详情
- `GET /health` 健康检查
- MySQL `api_audit_log` 表初始化

## 为什么这样设计

目标不是做一个“所有查询都开放”的后台，而是优先让低配数据库也能稳定跑起来，所以后端做了几层约束：

- 默认只查最近 24 小时
- 时间窗口有上限，避免无限制扫大表
- 仪表盘接口走聚合查询，不拉全量明细
- 仪表盘结果做短 TTL 内存缓存，降低重复查询压力
- 最近记录列表用游标翻页，不用高 offset
- 列表接口只取摘要字段，详情页才查大字段
- path 过滤用前缀匹配，尽量利用 `(path, request_ts)` 索引

## 快速启动

```bash
cp .env.example .env
docker compose up -d mysql
cargo run --bin logark-server
```

启动后打开：

- [http://127.0.0.1:7700](http://127.0.0.1:7700)

## 关键配置

- `DATABASE_URL` MySQL 连接串
- `LOGARK_DB_MAX_CONNECTIONS` 连接池大小
- `LOGARK_ANALYTICS_CACHE_TTL_SECS` 仪表盘缓存秒数
- `LOGARK_DEFAULT_WINDOW_HOURS` 默认分析窗口
- `LOGARK_MAX_WINDOW_HOURS` 最大分析窗口
- `LOGARK_MAX_LIST_LIMIT` 单次最多返回多少条记录
- `LOGARK_SLOW_REQUEST_MS` 慢请求阈值，便于后续扩展

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

按 ID 查详情：

```bash
curl 'http://127.0.0.1:7700/api/records/1001'
```

## 表结构

项目会确保存在这张表：

- `api_audit_log`

字段与索引定义在 [`migrations/001_init.sql`](/Users/allenflux/RustroverProjects/logark/migrations/001_init.sql:1)。

## 项目结构

```text
cmd/logark-server   服务入口
internal/config     配置
internal/db         MySQL 连接与表初始化
internal/handler    HTTP 路由与接口
internal/model      数据结构
internal/service    分析查询与缓存
static              前端页面
migrations          表结构 SQL
```
