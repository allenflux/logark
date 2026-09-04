(() => {
  "use strict";

  const messages = {
    "zh-CN": {
      "meta.description": "LogArk 非 200 拦截请求解释性分析报告",
      "meta.title": "LogArk · 非 200 拦截请求分析报告",
      "nav.homeAria": "LogArk 首页",
      "nav.audit": "非 200 拦截报告",
      "status.awaitingRefresh": "等待刷新",
      "page.title": "非 200 拦截请求分析报告",
      "page.subtitle": "以非 200 请求为主体，从状态码、接口、Method 与时间趋势解释拦截数据；全部请求仅用于计算错误率。",
      "time.lastHours": "最近 {count} 小时",
      "time.lastDays": "最近 {count} 天",
      "time.rangeTitle": "{from} 至 {to}",
      "feedback.loadFailedPrefix": "加载失败：",
      "common.close": "关闭",
      "common.other": "其他",
      "filters.title": "分析范围",
      "filters.help": "筛选条件同时作用于错误率、趋势和排行榜",
      "filters.timeWindow": "时间窗口",
      "fields.pathPrefix": "Path 前缀",
      "fields.method": "Method",
      "fields.taskType": "任务类型",
      "fields.apiKey": "API Key",
      "fields.requestId": "request_id",
      "fields.uuid": "uuid",
      "fields.taskId": "task_id",
      "fields.errorCode": "错误码",
      "fields.exactStatusCode": "精确状态码",
      "placeholders.path": "例如 /api/public",
      "placeholders.method": "例如 POST",
      "placeholders.exactMatch": "精确匹配",
      "placeholders.statusCode": "例如 400",
      "placeholders.exact": "精确",
      "actions.resetFilters": "重置筛选",
      "actions.refresh": "刷新",
      "actions.clearRecordFilters": "清空明细条件",
      "actions.search": "查询",
      "actions.loadMore": "加载更多",
      "actions.view": "查看",
      "overview.ariaLabel": "错误概览",
      "states.loading": "正在加载",
      "states.calculatingErrorRate": "正在计算错误率…",
      "report.title": "报告摘要",
      "report.help": "综合当前筛选窗口内的非 200 数据，结论会随筛选自动更新。",
      "report.generated": "数据驱动结论",
      "report.dimensions": "综合维度：总体 · 状态码 · 接口 · Method · 时间 · API Key · 任务类型",
      "report.overallTitle": "总体规模与错误率",
      "report.overallBody": "当前样本 n = {total}，其中非 200 请求 {errors} 条，占 {rate}。",
      "report.compositionTitle": "错误构成",
      "report.compositionBody": "HTTP {status} 是主要状态码，占全部非 200 的 {statusShare}；{method} 贡献 {methodShare} 的非 200 请求，其自身错误率为 {methodRate}。",
      "report.concentrationTitle": "接口集中度",
      "report.concentrationBody": "错误量最高的接口是 {path}，贡献全部非 200 的 {topShare}；前三个接口合计贡献 {topThreeShare}。",
      "report.peakTitle": "时间峰值",
      "report.peakBody": "非 200 数量峰值出现在 {period}，该时段共有 {errors} 条，错误率为 {rate}。",
      "report.noComposition": "当前筛选窗口没有足够的状态码或 Method 数据用于解释错误构成。",
      "report.noConcentration": "当前筛选窗口没有可用于计算接口集中度的非 200 数据。",
      "report.noPeak": "当前筛选窗口没有可用于定位峰值的趋势数据。",
      "report.noData": "当前筛选窗口没有审计请求，暂时无法生成解释性结论。",
      "hourly.title": "每小时非 200 请求量",
      "hourly.help": "按自然小时汇总拦截数量，用于识别突增、峰值和持续异常",
      "hourly.peakBadge": "峰值 {value} / 小时",
      "hourly.axisY": "非 200 请求数",
      "hourly.chartAria": "每小时非 200 请求量折线图，共 {count} 个小时数据点，峰值 {peak} 条",
      "hourly.scrollAria": "可横向滚动查看完整的每小时折线图",
      "hourly.pointAria": "{time}：非 200 为 {errors} 条，总请求 {total} 条，错误率 {rate}",
      "hourly.caption": "图 1. 按自然小时汇总 status_code != 200；首个小时与当前小时可能是不完整时段。",
      "hourly.dataTable": "查看每小时精确数据",
      "hourly.tableAria": "每小时非 200 请求量精确数据",
      "trend.title": "错误率趋势",
      "trend.help": "每个时间段的非 200 数量 / 总请求数",
      "share.title": "非 200 占比",
      "share.help": "非 200 与 200 在全部审计请求中的构成",
      "share.non200": "非 200",
      "share.status200": "状态码 200",
      "share.aria": "非 200 占全部审计请求 {rate}，共 {errors} 条；样本量 {total} 条",
      "share.noDataAria": "当前筛选窗口没有审计请求",
      "share.caption": "分母：当前筛选窗口全部审计请求（n = {total}）",
      "statusDistribution.title": "非 200 状态码分布",
      "statusDistribution.help": "各状态码占全部错误的比例，最多显示 8 项",
      "topPaths.title": "错误量最高的接口",
      "topPaths.help": "按非 200 数量排序，同时展示该接口自身错误率",
      "methods.title": "Method 构成",
      "methods.help": "错误贡献占比 / 该 Method 自身错误率",
      "methods.contribution": "占全部错误 {rate}",
      "methods.ownRate": "自身错误率 {rate}",
      "methods.aggregated": "其余 Method 合并项",
      "dimensions.aria": "其他错误维度",
      "ranking.apiKeys": "API Key 错误排行",
      "ranking.taskTypes": "任务类型错误排行",
      "latest.title": "最新非 200 请求",
      "latest.help": "来自当前分析窗口，点击任一行查看完整审计内容",
      "latest.limit": "最新 {count} 条",
      "columns.endpointPath": "接口路径",
      "columns.non200": "非 200",
      "columns.totalRequests": "总请求",
      "columns.errorRate": "错误率",
      "columns.time": "时间",
      "columns.status": "状态",
      "columns.endpoint": "接口",
      "columns.duration": "耗时",
      "columns.errorAndAction": "错误码 / 操作",
      "columns.intervalLatestFirst": "时间段（最新在上）",
      "columns.averageDuration": "平均耗时",
      "records.title": "拦截明细",
      "records.help": "默认仅显示非 200；精确状态码优先于范围选择",
      "records.scope": "记录范围",
      "scope.non200Only": "仅非 200",
      "scope.allStatuses": "全部状态",
      "scope.statusCode": "状态码 {status}",
      "records.loadedCount": "已加载 {value} 条 · {scope}",
      "detail.title": "请求详情",
      "detail.requestBody": "请求体",
      "detail.responseBody": "响应体",
      "detail.requestHeaders": "请求头",
      "detail.responseHeaders": "响应头",
      "detail.recordId": "记录 ID",
      "detail.clientIp": "客户端 IP",
      "detail.query": "查询参数",
      "detail.bodySize": "Body 大小",
      "detail.loadingRecord": "正在读取记录 #{id}",
      "detail.recordLoadFailed": "记录 #{id} 加载失败",
      "errors.requestFailed": "请求失败（HTTP {status}）",
      "validation.statusCodeRange": "精确状态码必须是 100–599 之间的整数",
      "metrics.non200Rate": "非 200 错误率",
      "metrics.requestRatio": "{errors} / {total} 个请求",
      "metrics.non200Count": "非 200 拦截量",
      "metrics.status200Count": "状态码 200：{value} 个",
      "metrics.auditTotal": "审计请求总量",
      "metrics.keyTaskCount": "API Key：{apiKeys} · 任务：{tasks}",
      "metrics.affectedEndpoints": "受影响接口",
      "metrics.latencySummary": "错误平均耗时 {average} · 全量 P95 {p95}",
      "units.minutes": "{count} 分钟",
      "units.hours": "{count} 小时",
      "bucket.originalMerged": "原始粒度 {size} · 合并展示",
      "bucket.granularity": "粒度 {size}",
      "empty.noAuditInWindow": "当前窗口没有审计记录",
      "empty.noHourlyVolume": "当前筛选范围内没有可绘制的小时数据",
      "empty.noTrend": "当前筛选范围内没有趋势数据",
      "empty.noNon200Statuses": "当前窗口没有非 200 状态码",
      "empty.noNon200Paths": "当前筛选范围没有出现非 200 的接口",
      "empty.noNon200Data": "暂无非 200 数据",
      "empty.noMethods": "当前窗口没有可统计的 Method",
      "empty.noNon200Requests": "当前窗口没有非 200 请求",
      "empty.noMatchingRecords": "没有符合条件的审计记录",
      "content.empty": "暂无内容",
      "aria.intervalErrorRate": "该时间段错误率",
      "aria.statusShare": "状态码 {status} 占比",
      "aria.endpointErrorRate": "接口错误率",
      "aria.methodContribution": "Method {method} 占全部错误的比例",
      "aria.viewRequest": "查看请求 {requestId} 详情",
      "ranking.errorCount": "{value} 错误",
      "ranking.rateAndTotal": "{rate} / {total} 次",
      "status.updatedAt": "更新于 {time}",
    },
    en: {
      "meta.description": "LogArk explanatory report for intercepted non-200 requests",
      "meta.title": "LogArk · Non-200 Interception Analysis Report",
      "nav.homeAria": "LogArk home",
      "nav.audit": "Non-200 report",
      "status.awaitingRefresh": "Waiting to refresh",
      "page.title": "Non-200 Interception Analysis Report",
      "page.subtitle": "An explanatory view of intercepted non-200 requests by status, endpoint, Method, and time; all requests are used only as the error-rate denominator.",
      "time.lastHours.one": "Last {count} hour",
      "time.lastHours.other": "Last {count} hours",
      "time.lastDays.one": "Last {count} day",
      "time.lastDays.other": "Last {count} days",
      "time.rangeTitle": "{from} to {to}",
      "feedback.loadFailedPrefix": "Failed to load: ",
      "common.close": "Close",
      "common.other": "Other",
      "filters.title": "Analysis scope",
      "filters.help": "Filters apply to the error rate, trend, and rankings",
      "filters.timeWindow": "Time window",
      "fields.pathPrefix": "Path prefix",
      "fields.method": "Method",
      "fields.taskType": "Task type",
      "fields.apiKey": "API Key",
      "fields.requestId": "request_id",
      "fields.uuid": "uuid",
      "fields.taskId": "task_id",
      "fields.errorCode": "Error code",
      "fields.exactStatusCode": "Exact status code",
      "placeholders.path": "e.g. /api/public",
      "placeholders.method": "e.g. POST",
      "placeholders.exactMatch": "Exact match",
      "placeholders.statusCode": "e.g. 400",
      "placeholders.exact": "Exact",
      "actions.resetFilters": "Reset filters",
      "actions.refresh": "Refresh",
      "actions.clearRecordFilters": "Clear detail filters",
      "actions.search": "Search",
      "actions.loadMore": "Load more",
      "actions.view": "View",
      "overview.ariaLabel": "Error overview",
      "states.loading": "Loading",
      "states.calculatingErrorRate": "Calculating error rate…",
      "report.title": "Report summary",
      "report.help": "Synthesizes non-200 data in the current filter window; findings update with the filters.",
      "report.generated": "Data-driven findings",
      "report.dimensions": "Dimensions: overall · status · endpoint · Method · time · API key · task type",
      "report.overallTitle": "Scale and error rate",
      "report.overallBody": "The current sample is n = {total}; {errors} requests are non-200, representing {rate}.",
      "report.compositionTitle": "Error composition",
      "report.compositionBody": "HTTP {status} is the leading status code at {statusShare} of all non-200 requests; {method} contributes {methodShare}, with an error rate of {methodRate} within that Method.",
      "report.concentrationTitle": "Endpoint concentration",
      "report.concentrationBody": "{path} contributes the most errors at {topShare} of all non-200 requests; the top three endpoints contribute {topThreeShare} combined.",
      "report.peakTitle": "Time peak",
      "report.peakBody": "The non-200 peak occurs in {period}: {errors} requests with an error rate of {rate}.",
      "report.noComposition": "The current filter window does not have enough status-code or Method data to explain error composition.",
      "report.noConcentration": "No non-200 data is available to calculate endpoint concentration in the current filter window.",
      "report.noPeak": "No trend data is available to identify a peak in the current filter window.",
      "report.noData": "There are no audited requests in the current filter window, so explanatory findings cannot yet be generated.",
      "hourly.title": "Hourly non-200 request volume",
      "hourly.help": "Intercepted requests grouped by clock hour to reveal spikes, peaks, and sustained anomalies",
      "hourly.peakBadge": "Peak {value} / hour",
      "hourly.axisY": "Non-200 requests",
      "hourly.chartAria": "Hourly non-200 request-volume line chart with {count} hourly buckets and a peak of {peak}",
      "hourly.scrollAria": "Scrollable view of the complete hourly line chart",
      "hourly.pointAria": "{time}: {errors} non-200 requests, {total} total requests, and an error rate of {rate}",
      "hourly.caption": "Figure 1. status_code != 200 grouped by clock hour; the first and current hours may be partial intervals.",
      "hourly.dataTable": "View exact hourly data",
      "hourly.tableAria": "Exact hourly non-200 request-volume data",
      "trend.title": "Error-rate trend",
      "trend.help": "Non-200 requests / total requests in each interval",
      "share.title": "Non-200 share",
      "share.help": "Non-200 and 200 responses as a share of all audited requests",
      "share.non200": "Non-200",
      "share.status200": "Status 200",
      "share.aria": "Non-200 requests account for {rate} of all audited requests: {errors} records from a sample of {total}",
      "share.noDataAria": "No audited requests in the current filter window",
      "share.caption": "Denominator: all audited requests in the current filter window (n = {total})",
      "statusDistribution.title": "Non-200 status-code distribution",
      "statusDistribution.help": "Share of all errors by status code; up to 8 shown",
      "topPaths.title": "Endpoints with the most errors",
      "topPaths.help": "Sorted by non-200 count, with each endpoint's error rate",
      "methods.title": "Method composition",
      "methods.help": "Share of errors / error rate within each Method",
      "methods.contribution": "{rate} of all errors",
      "methods.ownRate": "Own error rate {rate}",
      "methods.aggregated": "Remaining Methods combined",
      "dimensions.aria": "Additional error dimensions",
      "ranking.apiKeys": "API key error ranking",
      "ranking.taskTypes": "Task-type error ranking",
      "latest.title": "Latest non-200 requests",
      "latest.help": "From the current analysis window; select a row to view the full audit record",
      "latest.limit.one": "Latest {count} record",
      "latest.limit.other": "Latest {count} records",
      "columns.endpointPath": "Endpoint path",
      "columns.non200": "Non-200",
      "columns.totalRequests": "Total requests",
      "columns.errorRate": "Error rate",
      "columns.time": "Time",
      "columns.status": "Status",
      "columns.endpoint": "Endpoint",
      "columns.duration": "Duration",
      "columns.errorAndAction": "Error code / Action",
      "columns.intervalLatestFirst": "Time interval (latest first)",
      "columns.averageDuration": "Average duration",
      "records.title": "Intercepted-request details",
      "records.help": "Shows non-200 records by default; an exact status code overrides the scope",
      "records.scope": "Record scope",
      "scope.non200Only": "Non-200 only",
      "scope.allStatuses": "All statuses",
      "scope.statusCode": "Status {status}",
      "records.loadedCount.one": "{value} record loaded · {scope}",
      "records.loadedCount.other": "{value} records loaded · {scope}",
      "detail.title": "Request details",
      "detail.requestBody": "Request body",
      "detail.responseBody": "Response body",
      "detail.requestHeaders": "Request headers",
      "detail.responseHeaders": "Response headers",
      "detail.recordId": "Record ID",
      "detail.clientIp": "Client IP",
      "detail.query": "Query parameters",
      "detail.bodySize": "Body size",
      "detail.loadingRecord": "Loading record #{id}",
      "detail.recordLoadFailed": "Failed to load record #{id}",
      "errors.requestFailed": "Request failed (HTTP {status})",
      "validation.statusCodeRange": "Exact status code must be an integer from 100 to 599",
      "metrics.non200Rate": "Non-200 error rate",
      "metrics.requestRatio.one": "{errors} / {total} request",
      "metrics.requestRatio.other": "{errors} / {total} requests",
      "metrics.non200Count": "Intercepted non-200 requests",
      "metrics.status200Count.one": "Status 200: {value} request",
      "metrics.status200Count.other": "Status 200: {value} requests",
      "metrics.auditTotal": "Total audited requests",
      "metrics.keyTaskCount": "API keys: {apiKeys} · Tasks: {tasks}",
      "metrics.affectedEndpoints": "Affected endpoints",
      "metrics.latencySummary": "Average error latency {average} · Overall P95 {p95}",
      "units.minutes.one": "{count} minute",
      "units.minutes.other": "{count} minutes",
      "units.hours.one": "{count} hour",
      "units.hours.other": "{count} hours",
      "bucket.originalMerged": "Original interval {size} · Aggregated for display",
      "bucket.granularity": "Interval {size}",
      "empty.noAuditInWindow": "No audit records in the current window",
      "empty.noHourlyVolume": "No hourly data is available for the current filters",
      "empty.noTrend": "No trend data for the current filters",
      "empty.noNon200Statuses": "No non-200 status codes in the current window",
      "empty.noNon200Paths": "No endpoints returned non-200 responses for the current filters",
      "empty.noNon200Data": "No non-200 data",
      "empty.noMethods": "No Method data in the current window",
      "empty.noNon200Requests": "No non-200 requests in the current window",
      "empty.noMatchingRecords": "No audit records match the filters",
      "content.empty": "No content",
      "aria.intervalErrorRate": "Error rate for this interval",
      "aria.statusShare": "Share of status code {status}",
      "aria.endpointErrorRate": "Endpoint error rate",
      "aria.methodContribution": "Share of all errors from Method {method}",
      "aria.viewRequest": "View details for request {requestId}",
      "ranking.errorCount.one": "{value} error",
      "ranking.errorCount.other": "{value} errors",
      "ranking.rateAndTotal.one": "{rate} / {total} request",
      "ranking.rateAndTotal.other": "{rate} / {total} requests",
      "status.updatedAt": "Updated at {time}",
    },
  };

  const supportedLocales = new Set(Object.keys(messages));
  const storageKey = "logark.locale";

  function initialLocale() {
    if (window.location?.search) {
      const requested = new URLSearchParams(window.location.search).get("lang");
      if (requested && supportedLocales.has(requested)) return requested;
    }
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved && supportedLocales.has(saved)) return saved;
    } catch (_) {
      // Storage can be unavailable in private or restricted browser contexts.
    }
    return navigator.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  }

  let locale = initialLocale();

  function translate(key, variables = {}) {
    const dictionary = messages[locale] || messages["zh-CN"];
    let template;
    if (Object.prototype.hasOwnProperty.call(variables, "count")) {
      const category = new Intl.PluralRules(locale).select(Number(variables.count));
      template = dictionary[`${key}.${category}`] ?? dictionary[`${key}.other`];
    }
    template ??= dictionary[key] ?? messages["zh-CN"][key] ?? key;
    return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match,
    );
  }

  function setLocale(nextLocale) {
    if (!supportedLocales.has(nextLocale)) return false;
    locale = nextLocale;
    try {
      localStorage.setItem(storageKey, locale);
    } catch (_) {
      // The in-memory locale still works when storage is unavailable.
    }
    return true;
  }

  function has(key, targetLocale = locale) {
    const dictionary = messages[targetLocale];
    if (!dictionary) return false;
    return Object.prototype.hasOwnProperty.call(dictionary, key)
      || Object.keys(dictionary).some((candidate) => candidate.startsWith(`${key}.`));
  }

  function apply(root = document) {
    document.documentElement.lang = locale;
    document.title = translate("meta.title");
    root.querySelectorAll("[data-i18n]").forEach((node) => {
      const variables = node.dataset.i18nCount === undefined
        ? {}
        : { count: Number(node.dataset.i18nCount) };
      node.textContent = translate(node.dataset.i18n, variables);
    });
    const attributes = ["aria-label", "content", "placeholder", "title"];
    attributes.forEach((attribute) => {
      const dataAttribute = `data-i18n-${attribute}`;
      root.querySelectorAll(`[${dataAttribute}]`).forEach((node) => {
        node.setAttribute(attribute, translate(node.getAttribute(dataAttribute)));
      });
    });
    const selector = document.getElementById("localeSelect");
    if (selector) selector.value = locale;
  }

  window.LogArkI18n = {
    apply,
    get locale() {
      return locale;
    },
    has,
    setLocale,
    t: translate,
  };
})();
