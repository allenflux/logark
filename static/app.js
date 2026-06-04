const state = {
  nextCursorTs: null,
  nextCursorId: null,
  appendMode: false,
};

const el = (id) => document.getElementById(id);

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    throw new Error(text.slice(0, 200) || `HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(body.error || "Request failed");
  }
  return body;
}

function queryString(params) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      qs.set(key, value);
    }
  });
  return qs.toString();
}

function buildDashboardParams() {
  return {
    hours: el("hours").value,
    path: el("path").value.trim(),
    method: el("method").value.trim(),
    api_key: el("apiKey").value.trim(),
  };
}

function buildRecordParams() {
  return {
    ...buildDashboardParams(),
    request_id: el("requestId").value.trim(),
    uuid: el("listUuid").value.trim(),
    task_id: el("taskId").value.trim(),
    status_code: el("statusCode").value.trim(),
    cursor_ts: state.appendMode ? state.nextCursorTs : "",
    cursor_id: state.appendMode ? state.nextCursorId : "",
    limit: 30,
  };
}

function numberFormat(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.round(value));
}

function timeFormat(ts) {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function statusClass(code) {
  if (code >= 500) return "status-pill status-bad";
  if (code >= 400) return "status-pill status-warn";
  return "status-pill status-good";
}

function renderMetricCards(summary) {
  const cards = [
    ["总请求数", numberFormat(summary.total_requests)],
    ["错误请求", numberFormat(summary.error_requests)],
    ["成功率", `${summary.success_rate.toFixed(1)}%`],
    ["平均耗时", `${summary.avg_duration_ms.toFixed(0)} ms`],
    ["P95 耗时", `${summary.p95_duration_ms} ms`],
    ["最大耗时", `${summary.max_duration_ms} ms`],
    ["活跃 API Key", numberFormat(summary.unique_api_keys)],
    ["活跃任务 ID", numberFormat(summary.unique_task_ids)],
  ];
  el("metricCards").innerHTML = cards
    .map(([label, value]) => `
      <div class="col-12 col-md-6 col-xl-3">
        <div class="card h-100 shadow-sm border">
          <div class="card-body">
            <div class="small text-secondary">${label}</div>
            <div class="metric-value fw-semibold text-primary-emphasis mt-2">${value}</div>
          </div>
        </div>
      </div>
    `)
    .join("");
}

function renderBarList(targetId, items) {
  const host = el(targetId);
  if (!items.length) {
    host.innerHTML = `<div class="border bg-light-subtle text-secondary small p-3">当前筛选条件下没有数据</div>`;
    return;
  }
  const max = Math.max(...items.map((item) => item.value), 1);
  host.innerHTML = items
    .map((item) => {
      const pct = Math.max((item.value / max) * 100, 6);
      return `
        <div class="bar-row">
          <div class="bar-meta">
            <div class="bar-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</div>
            <div class="bar-value">${numberFormat(item.value)}</div>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        </div>
      `;
    })
    .join("");
}

function renderTrendChart(points) {
  const host = el("trendChart");
  if (!points.length) {
    host.innerHTML = `<div class="border bg-light-subtle text-secondary small p-3">当前时间窗口没有可展示的趋势数据</div>`;
    return;
  }

  if (points.length === 1) {
    const point = points[0];
    host.innerHTML = `
      <div class="border rounded-0 p-4 bg-light-subtle">
        <div class="small text-secondary mb-2">当前时间窗口内只有 1 个时间桶，因此不适合绘制折线趋势。</div>
        <div class="fw-semibold text-body-emphasis mb-3">${timeFormat(point.ts)}</div>
        <div class="row g-3">
          <div class="col-12 col-md-4">
            <div class="border bg-white p-3 h-100">
              <div class="small text-secondary">请求数</div>
              <div class="fs-2 fw-semibold text-primary-emphasis">${numberFormat(point.count)}</div>
            </div>
          </div>
          <div class="col-12 col-md-4">
            <div class="border bg-white p-3 h-100">
              <div class="small text-secondary">错误数</div>
              <div class="fs-2 fw-semibold text-primary-emphasis">${numberFormat(point.error_count)}</div>
            </div>
          </div>
          <div class="col-12 col-md-4">
            <div class="border bg-white p-3 h-100">
              <div class="small text-secondary">平均耗时</div>
              <div class="fs-2 fw-semibold text-primary-emphasis">${point.avg_duration_ms.toFixed(0)} ms</div>
            </div>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const width = 1100;
  const height = 240;
  const padding = 20;
  const maxCount = Math.max(...points.map((point) => point.count), 1);
  const maxLatency = Math.max(...points.map((point) => point.avg_duration_ms), 1);
  const step = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;

  const linePath = (field, maxValue) =>
    points
      .map((point, index) => {
        const x = padding + index * step;
        const y = height - padding - (point[field] / maxValue) * (height - padding * 2);
        return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");

  const errorBars = points
    .map((point, index) => {
      const x = padding + index * step;
      const barHeight = (point.error_count / maxCount) * (height - padding * 2);
      const y = height - padding - barHeight;
      return `<rect x="${x - 3}" y="${y}" width="6" height="${Math.max(barHeight, 2)}" rx="3" fill="rgba(156,53,37,0.35)"></rect>`;
    })
    .join("");

  host.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="请求趋势">
      <defs>
        <linearGradient id="countLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#bf5b2c"></stop>
          <stop offset="100%" stop-color="#dca86a"></stop>
        </linearGradient>
        <linearGradient id="latencyLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#215b5d"></stop>
          <stop offset="100%" stop-color="#66a3a0"></stop>
        </linearGradient>
      </defs>
      ${errorBars}
      <path d="${linePath("count", maxCount)}" fill="none" stroke="url(#countLine)" stroke-width="4" stroke-linecap="round"></path>
      <path d="${linePath("avg_duration_ms", maxLatency)}" fill="none" stroke="url(#latencyLine)" stroke-width="3" stroke-dasharray="8 7" stroke-linecap="round"></path>
    </svg>
  `;
}

function renderRecords(payload) {
  const rows = payload.items
    .map((item) => `
      <tr data-record-id="${item.id}">
        <td>#${item.id}</td>
        <td>${timeFormat(item.request_ts)}</td>
        <td><strong>${item.method}</strong> ${item.path}</td>
        <td><span class="${statusClass(item.status_code)}">${item.status_code}</span></td>
        <td>${item.duration_ms} ms</td>
        <td>${item.request_id}</td>
        <td>${item.task_id || "-"}</td>
      </tr>
    `)
    .join("");

  if (state.appendMode) {
    el("recordsTable").insertAdjacentHTML("beforeend", rows);
  } else {
    el("recordsTable").innerHTML = rows || `<tr><td colspan="7"><div class="border bg-light-subtle text-secondary small p-3">没有命中记录</div></td></tr>`;
  }

  state.nextCursorTs = payload.next_cursor_ts;
  state.nextCursorId = payload.next_cursor_id;
  el("loadMoreButton").disabled = !payload.next_cursor_ts;

  Array.from(document.querySelectorAll("tbody tr[data-record-id]")).forEach((row) => {
    row.onclick = () => loadDetailById(row.dataset.recordId);
  });
}

function renderDetail(record) {
  if (!record) {
    el("detailMeta").innerHTML = `<div class="col-12"><div class="border bg-light-subtle text-secondary small p-3">没有找到记录</div></div>`;
    return;
  }

  const chips = [
    ["ID", `#${record.id}`],
    ["request_id", record.request_id],
    ["uuid", record.uuid || "-"],
    ["接口", `${record.method} ${record.path}`],
    ["状态", String(record.status_code)],
    ["耗时", `${record.duration_ms} ms`],
    ["api_key", record.api_key || "-"],
    ["客户端", record.client_ip || "-"],
    ["任务", record.task_id || "-"],
    ["错误码", record.error_code || "-"],
  ];

  el("detailMeta").innerHTML = chips
    .map(([label, value]) => `
      <div class="col-12 col-md-6 col-xl-4">
        <div class="border p-3 h-100 bg-light-subtle">
          <div class="small text-secondary">${label}</div>
          <div class="fw-semibold text-primary-emphasis mt-2">${value}</div>
        </div>
      </div>
    `)
    .join("");

  el("requestHeaders").textContent = prettyText(record.request_headers_json);
  el("responseHeaders").textContent = prettyText(record.response_headers_json);
  el("requestBody").textContent = prettyText(record.request_body);
  el("responseBody").textContent = prettyText(record.response_body);
}

function prettyText(value) {
  if (!value) return "暂无内容";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch (_) {
    return value;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function loadDashboard() {
  const params = queryString(buildDashboardParams());
  const payload = await fetchJson(`/api/dashboard?${params}`);
  renderMetricCards(payload.summary);
  renderTrendChart(payload.throughput);
  renderBarList("topPaths", payload.top_paths);
  renderBarList("statusDist", payload.status_distribution);
  renderBarList("topKeys", payload.top_api_keys);
  renderBarList("topTasks", payload.top_task_types);
  el("windowBadge").textContent = `最近 ${payload.window.hours} 小时`;
}

async function loadRecords(reset = true) {
  state.appendMode = !reset;
  const params = queryString(buildRecordParams());
  const payload = await fetchJson(`/api/records?${params}`);
  renderRecords(payload);
}

async function loadDetailById(id) {
  const payload = await fetchJson(`/api/records/${id}`);
  renderDetail(payload);
}

async function loadDetailByRequestId(requestId) {
  const payload = await fetchJson(`/api/records/request/${encodeURIComponent(requestId)}`);
  renderDetail(payload);
}

async function loadDetailByUuid(uuid) {
  const payload = await fetchJson(`/api/records/uuid/${encodeURIComponent(uuid)}`);
  renderDetail(payload);
}

async function refreshAll() {
  try {
    await Promise.all([loadDashboard(), loadRecords(true)]);
  } catch (error) {
    alert(error.message);
  }
}

el("refreshButton").onclick = refreshAll;
el("searchButton").onclick = () => loadRecords(true).catch((error) => alert(error.message));
el("loadMoreButton").onclick = () => loadRecords(false).catch((error) => alert(error.message));
el("detailByIdButton").onclick = () => {
  const id = el("detailId").value.trim();
  if (!id) return;
  loadDetailById(id).catch((error) => alert(error.message));
};
el("detailByRequestButton").onclick = () => {
  const requestId = el("detailRequestId").value.trim();
  if (!requestId) return;
  loadDetailByRequestId(requestId).catch((error) => alert(error.message));
};
el("detailByUuidButton").onclick = () => {
  const uuid = el("detailUuid").value.trim();
  if (!uuid) return;
  loadDetailByUuid(uuid).catch((error) => alert(error.message));
};

refreshAll();
