const i18n = window.LogArkI18n;
const t = (key, variables = {}) => i18n.t(key, variables);

const state = {
  nextCursorTs: null,
  nextCursorId: null,
  renderedRecordCount: 0,
  detailRequestToken: 0,
  dashboardRequestToken: 0,
  recordRequestToken: 0,
  refreshToken: 0,
  dashboardRequest: null,
  dashboardLoading: false,
  dashboardSlow: false,
  dashboardRefreshFailed: false,
  dashboardUpdatedAt: null,
  recordRequestController: null,
  recordBaseParams: null,
  detailModal: null,
  dashboardPayload: null,
  appliedDashboardParams: null,
  recordsLoaded: false,
  recordsLoading: false,
  chartMode: "volume",
  detailPattern: null,
  selectedApiKey: null,
};

const el = (id) => document.getElementById(id);

async function fetchJson(url, signal) {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal });
  const text = await response.text();
  let body;

  try {
    body = JSON.parse(text);
  } catch (_) {
    throw new Error(text.slice(0, 200) || `HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(body.error || t("errors.requestFailed", { status: response.status }));
  }

  return body;
}

function queryString(params) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, String(value));
    }
  });
  return query.toString();
}

function buildDashboardParams() {
  return {
    hours: el("hours").value,
    path: el("path").value.trim(),
    method: el("method").value.trim().toUpperCase(),
    task_type: el("taskType").value.trim(),
    api_key: el("apiKey").value.trim() ? el("apiKey").value : "",
  };
}

function buildRecordParams(append) {
  let baseParams = state.recordBaseParams;
  if (!append || !baseParams) {
    const statusCode = validatedStatusCode();
    baseParams = {
      ...(state.appliedDashboardParams || buildDashboardParams()),
      request_id: el("requestId").value.trim(),
      uuid: el("listUuid").value.trim(),
      task_id: el("taskId").value.trim(),
      error_code: el("errorCode").value.trim(),
      status_code: statusCode,
      non_200: statusCode === "" && el("recordScope").value === "errors" ? true : "",
    };
  }

  if (!append) {
    state.recordBaseParams = { ...baseParams };
  }

  return {
    ...baseParams,
    cursor_ts: append ? state.nextCursorTs : "",
    cursor_id: append ? state.nextCursorId : "",
    limit: 30,
  };
}

function validatedStatusCode() {
  const raw = el("statusCode").value.trim();
  if (raw === "") return "";
  const code = Number(raw);
  if (!Number.isInteger(code) || code < 100 || code > 599) {
    throw new Error(t("validation.statusCodeRange"));
  }
  return code;
}

function numberFormat(value) {
  return new Intl.NumberFormat(i18n.locale).format(Number(value) || 0);
}

function rateFormat(value, digits = 1) {
  const rate = Number(value);
  return `${Number.isFinite(rate) ? rate.toFixed(digits) : "0.0"}%`;
}

function durationFormat(value) {
  const duration = Number(value) || 0;
  return `${new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 0 }).format(duration)} ms`;
}

function timeFormat(timestamp) {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(i18n.locale, { hour12: false });
}

function compactTimeFormat(timestamp) {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(i18n.locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function timeWindowLabel(hours) {
  const numericHours = Number(hours) || 0;
  if (numericHours >= 168 && numericHours % 24 === 0) {
    return t("time.lastDays", { count: numericHours / 24 });
  }
  return t("time.lastHours", { count: numericHours });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function iconMarkup(name) {
  const iconClasses = {
    eye: "bi-eye",
    inbox: "bi-inbox",
  };
  const iconClass = iconClasses[name];
  return iconClass
    ? `<i class="bi ${iconClass} app-icon" aria-hidden="true"></i>`
    : "";
}

function clampRate(value) {
  const rate = Number(value) || 0;
  return Math.min(Math.max(rate, 0), 100);
}


function statusBadgeClass(code) {
  if (code === 200) return "text-bg-success";
  if (code >= 500) return "text-bg-dark";
  if (code >= 400) return "text-bg-danger";
  if (code >= 300) return "text-bg-warning";
  return "text-bg-secondary";
}

function statusBadge(code) {
  const numericCode = Number(code);
  const safeCode = Number.isFinite(numericCode) ? numericCode : "—";
  return `<span class="badge rounded-pill status-badge ${statusBadgeClass(numericCode)}">${safeCode}</span>`;
}

function emptyState(message) {
  return `
    <div class="empty-state">
      <div class="empty-state-mark" aria-hidden="true">${iconMarkup("inbox")}</div>
      <div>${escapeHtml(message)}</div>
    </div>
  `;
}

function emptyRow(colspan, message) {
  return `<tr><td colspan="${colspan}" class="p-0">${emptyState(message)}</td></tr>`;
}

function renderMetricCards(summary) {
  const total = Number(summary.total_requests) || 0;
  const errors = Number(summary.error_requests) || 0;
  const success = Number(summary.successful_requests) || 0;
  const errorRate = clampRate(summary.error_rate);
  const hasData = total > 0;

  const cards = [
    {
      label: t("metrics.non200Rate"),
      value: hasData ? rateFormat(errorRate, 2) : "—",
      helper: hasData
        ? t("metrics.requestRatio", {
            count: total,
            errors: numberFormat(errors),
            total: numberFormat(total),
          })
        : t("empty.noAuditInWindow"),
      danger: true,
      progress: errorRate,
    },
    {
      label: t("metrics.non200Count"),
      value: numberFormat(errors),
      helper: t("metrics.status200Count", {
        count: success,
        value: numberFormat(success),
      }),
    },
    {
      label: t("metrics.auditTotal"),
      value: numberFormat(total),
      helper: t("metrics.keyTaskCount", {
        apiKeys: numberFormat(summary.unique_api_keys),
        tasks: numberFormat(summary.unique_task_ids),
      }),
    },
    {
      label: t("metrics.affectedEndpoints"),
      value: numberFormat(summary.affected_paths),
      helper: t("metrics.latencySummary", {
        average: durationFormat(summary.avg_error_duration_ms),
        p95: durationFormat(summary.p95_duration_ms),
      }),
    },
  ];

  el("metricCards").innerHTML = cards
    .map(
      (card) => `
        <div class="col-12 col-sm-6 col-xl-3">
          <article class="card metric-card ${card.danger ? "metric-danger" : ""} h-100">
            <div class="card-body p-4 d-flex flex-column">
              <div class="metric-label mb-3">${escapeHtml(card.label)}</div>
              <div class="metric-value mb-3">${escapeHtml(card.value)}</div>
              <div class="metric-helper mt-auto">${escapeHtml(card.helper)}</div>
              ${
                card.progress === undefined
                  ? ""
                  : `<div class="progress rate-progress mt-3" role="progressbar" aria-label="${escapeHtml(t("metrics.non200Rate"))}" aria-valuenow="${card.progress}" aria-valuemin="0" aria-valuemax="100">
                       <div class="progress-bar bg-danger" style="width: ${card.progress}%"></div>
                     </div>`
              }
            </div>
          </article>
        </div>
      `,
    )
    .join("");
}

function renderErrorShare(summary) {
  const host = el("errorShareFigure");
  const total = Number(summary.total_requests) || 0;
  const errors = Number(summary.error_requests) || 0;
  const success = Number(summary.successful_requests) || 0;
  const errorRate = total > 0 ? clampRate((errors / total) * 100) : 0;
  const successRate = total > 0 ? clampRate((success / total) * 100) : 0;
  const errorRateLabel = total > 0 ? rateFormat(errorRate, 2) : "—";
  const chartLabel = total > 0
    ? t("share.aria", {
        rate: errorRateLabel,
        errors: numberFormat(errors),
        total: numberFormat(total),
      })
    : t("share.noDataAria");

  host.innerHTML = `
    <figure class="share-figure mb-0">
      <svg class="share-donut" viewBox="0 0 44 44" role="img" aria-label="${escapeHtml(chartLabel)}">
        <title>${escapeHtml(chartLabel)}</title>
        <circle class="share-donut-track" cx="22" cy="22" r="16" pathLength="100"></circle>
        ${
          total > 0
            ? `<circle class="share-donut-value" cx="22" cy="22" r="16" pathLength="100" stroke-dasharray="${errorRate} ${100 - errorRate}" transform="rotate(-90 22 22)"></circle>`
            : ""
        }
        <text class="share-donut-rate" x="22" y="21" text-anchor="middle">${escapeHtml(errorRateLabel)}</text>
        <text class="share-donut-sample" x="22" y="26" text-anchor="middle">n = ${escapeHtml(numberFormat(total))}</text>
      </svg>
      <figcaption class="mt-4">
        <div class="share-legend-row">
          <span class="share-swatch share-swatch-error" aria-hidden="true"></span>
          <span>${escapeHtml(t("share.non200"))}</span>
          <span class="ms-auto font-monospace text-end">${numberFormat(errors)} · ${rateFormat(errorRate, 2)}</span>
        </div>
        <div class="share-legend-row">
          <span class="share-swatch share-swatch-success" aria-hidden="true"></span>
          <span>${escapeHtml(t("share.status200"))}</span>
          <span class="ms-auto font-monospace text-end">${numberFormat(success)} · ${rateFormat(successRate, 2)}</span>
        </div>
        <p class="figure-note mb-0 mt-3">${escapeHtml(t("share.caption", { total: numberFormat(total) }))}</p>
      </figcaption>
    </figure>
  `;
}

function groupTimeline(points, windowInfo, maxGroups = 16) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const fromTs = Number(windowInfo.from_ts);
  const toTs = Number(windowInfo.to_ts);
  const sourceBucketMs = Math.max(Number(windowInfo.bucket_ms) || 1, 1);
  const alignedFromTs = Math.floor(fromTs / sourceBucketMs) * sourceBucketMs;
  const sourceBucketCount = Math.max(1, Math.floor((toTs - alignedFromTs) / sourceBucketMs) + 1);
  const bucketsPerGroup = Math.max(1, Math.ceil(sourceBucketCount / maxGroups));
  const groupSpan = bucketsPerGroup * sourceBucketMs;
  const groupCount = Math.ceil(sourceBucketCount / bucketsPerGroup);
  const groups = Array.from({ length: groupCount }, (_, index) => {
    const groupStart = alignedFromTs + index * groupSpan;
    return {
      fromTs: Math.max(groupStart, fromTs),
      toTs: Math.min(groupStart + groupSpan, toTs),
      count: 0,
      errorCount: 0,
      weightedLatency: 0,
      errorRate: 0,
      avgDurationMs: 0,
      bucketCount: bucketsPerGroup,
    };
  });

  points.forEach((point) => {
    const pointTs = Number(point.ts);
    const index = Math.min(
      Math.max(Math.floor((pointTs - alignedFromTs) / groupSpan), 0),
      groups.length - 1,
    );
    const count = Number(point.count) || 0;
    groups[index].count += count;
    groups[index].errorCount += Number(point.error_count) || 0;
    groups[index].weightedLatency += (Number(point.avg_duration_ms) || 0) * count;
  });

  groups.forEach((group) => {
    if (group.count > 0) {
      group.errorRate = (group.errorCount / group.count) * 100;
      group.avgDurationMs = group.weightedLatency / group.count;
    }
    delete group.weightedLatency;
  });

  return groups;
}

function groupHourlyTimeline(points, windowInfo) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const hourMs = 3_600_000;
  const fromTs = Number(windowInfo.from_ts);
  const toTs = Number(windowInfo.to_ts);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs < fromTs) return [];

  const alignedFromTs = Math.floor(fromTs / hourMs) * hourMs;
  const groupCount = Math.floor((toTs - alignedFromTs) / hourMs) + 1;
  const groups = Array.from({ length: groupCount }, (_, index) => {
    const groupStart = alignedFromTs + index * hourMs;
    return {
      fromTs: Math.max(groupStart, fromTs),
      toTs: Math.min(groupStart + hourMs, toTs),
      count: 0,
      errorCount: 0,
      errorRate: 0,
    };
  });

  points.forEach((point) => {
    const pointTs = Number(point.ts);
    const index = Math.floor((pointTs - alignedFromTs) / hourMs);
    if (index < 0 || index >= groups.length) return;
    groups[index].count += Number(point.count) || 0;
    groups[index].errorCount += Number(point.error_count) || 0;
  });

  groups.forEach((group) => {
    group.errorRate = group.count > 0 ? (group.errorCount / group.count) * 100 : 0;
  });
  return groups;
}

function niceCountAxis(maxValue, targetIntervals = 4) {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return { max: 1, ticks: [0, 1] };
  }
  const roughStep = maxValue / targetIntervals;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = Math.max(1, factor * magnitude);
  const max = Math.ceil(maxValue / step) * step;
  const ticks = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  return { max, ticks };
}

function sampledIndices(length, targetCount = 7) {
  if (length <= 0) return [];
  if (length <= targetCount) return Array.from({ length }, (_, index) => index);
  const indices = new Set();
  for (let index = 0; index < targetCount; index += 1) {
    indices.add(Math.round((index * (length - 1)) / (targetCount - 1)));
  }
  return [...indices];
}

function hourTickFormat(timestamp) {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(i18n.locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function renderHourlyVolumeChart(points, windowInfo) {
  const host = el("hourlyVolumeChart");
  const groups = groupHourlyTimeline(points, windowInfo);
  if (!groups.length) {
    el("hourlyPeakBadge").textContent = "—";
    host.innerHTML = emptyState(t("empty.noHourlyVolume"));
    return;
  }
  const analysis = window.LogArkAnalytics.summarizeTrend(groups.map((group) => ({
    count: group.count, error_count: group.errorCount,
  })));
  const rateMode = state.chartMode === "rate";
  const values = groups.map((group) => rateMode ? group.errorRate : group.errorCount);
  const peakIndex = rateMode ? values.indexOf(Math.max(...values)) : Math.max(0, analysis.peak_failure_index);
  const peak = groups[peakIndex];
  el("hourlyPeakBadge").textContent = t("hourly.peakBadge", { value: numberFormat(analysis.peak_failures) });
  const width = Math.max(280, Math.min(880, host.clientWidth - (window.innerWidth < 768 ? 32 : 48)));
  const height = width < 560 ? 244 : 284;
  const margin = { top: 24, right: 12, bottom: 44, left: width < 560 ? 40 : 56 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const axis = rateMode ? { max: 100, ticks: [0, 25, 50, 75, 100] } : niceCountAxis(Math.max(...values));
  const x = (index) => margin.left + index / Math.max(groups.length - 1, 1) * plotWidth;
  const y = (value) => margin.top + plotHeight - value / axis.max * plotHeight;
  const line = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  const baseline = margin.top + plotHeight;
  const grid = axis.ticks.map((value) => `<line class="hourly-grid-line" x1="${margin.left}" y1="${y(value)}" x2="${width-margin.right}" y2="${y(value)}"/>
    <text class="hourly-axis-label" x="${margin.left-12}" y="${y(value)+4}" text-anchor="end">${escapeHtml(rateMode ? `${value}%` : numberFormat(value))}</text>`).join("");
  const labels = sampledIndices(groups.length, width < 560 ? 3 : 5).map((index) => `<text class="hourly-axis-label" x="${x(index)}" y="${height-16}" text-anchor="${index===0?"start":index===groups.length-1?"end":"middle"}">${escapeHtml(hourTickFormat(groups[index].fromTs))}</text>`).join("");
  const description = (group) => t("hourly.pointAria", { time: timelineRangeLabel(group), errors: numberFormat(group.errorCount), total: numberFormat(group.count), rate: group.count ? rateFormat(group.errorRate,2) : "—" });
  const caption = t("hourly.caption");
  host.innerHTML = `<figure class="hourly-figure mb-0">
    <div class="d-flex align-items-center justify-content-between gap-3 mb-3 flex-wrap">
      <div class="chart-mode-switch" role="group" aria-label="${escapeHtml(t("patterns.chartMode"))}">
        <button type="button" data-chart-mode="volume" aria-pressed="${!rateMode}" class="${!rateMode?"active":""}">${escapeHtml(t("patterns.volume"))}</button>
        <button type="button" data-chart-mode="rate" aria-pressed="${rateMode}" class="${rateMode?"active":""}">${escapeHtml(t("columns.errorRate"))}</button>
      </div>
      <span class="figure-note">${escapeHtml(t("patterns.peakAt", {time: hourTickFormat(peak.fromTs)}))}</span>
    </div>
    <div class="hourly-chart-scroll">
      <svg class="hourly-chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="hourlyChartTitle hourlyChartDescription">
        <title id="hourlyChartTitle">${escapeHtml(rateMode?t("patterns.rateChart"):t("hourly.chartAria", {count:groups.length,peak:numberFormat(analysis.peak_failures)}))}</title>
        <desc id="hourlyChartDescription">${escapeHtml(caption)}</desc>
        <text class="scientific-axis-variable" x="${margin.left}" y="14">${rateMode ? "p(t), %" : "n(t)"}</text>
        <text class="scientific-axis-variable" x="${width - margin.right}" y="${height - 1}" text-anchor="end">t</text>
        ${grid}${labels}
        <path class="hourly-area" d="${line} L${x(groups.length-1)},${baseline} L${x(0)},${baseline} Z"/>
        <path class="hourly-line" d="${line}"/>
        <line class="chart-cursor" x1="${x(peakIndex)}" x2="${x(peakIndex)}" y1="${margin.top}" y2="${baseline}" stroke="var(--app-muted)" stroke-dasharray="4 4" opacity=".45"/>
        <circle class="chart-selected hourly-point hourly-point-peak" cx="${x(peakIndex)}" cy="${y(values[peakIndex])}" r="5"/>
        ${groups.map((group,index)=>`<circle data-chart-point="${index}" cx="${x(index)}" cy="${y(values[index])}" r="10" fill="transparent"><title>${escapeHtml(description(group))}</title></circle>`).join("")}
      </svg>
    </div>
    <div class="chart-tooltip" aria-live="polite">${escapeHtml(description(peak))}</div>
    <input class="chart-scrubber" type="range" min="0" max="${groups.length-1}" value="${peakIndex}" step="1" aria-label="${escapeHtml(t("patterns.exploreHour"))}" aria-valuetext="${escapeHtml(description(peak))}">
    <figcaption class="figure-note mt-2">${escapeHtml(caption)}</figcaption>
    </figure>
    <details class="hourly-data-details mt-3"><summary class="small fw-semibold text-body-secondary">${escapeHtml(t("hourly.dataTable"))}</summary>
      <div class="table-responsive hourly-data-table-wrap mt-2"><table class="table table-sm align-middle mb-0">
        <thead class="table-light"><tr><th>${escapeHtml(t("columns.time"))}</th><th>${escapeHtml(t("columns.non200"))}</th><th>${escapeHtml(t("columns.totalRequests"))}</th><th>${escapeHtml(t("columns.errorRate"))}</th></tr></thead>
        <tbody>${groups.map(group=>`<tr><td>${escapeHtml(timelineRangeLabel(group))}</td><td>${numberFormat(group.errorCount)}</td><td>${numberFormat(group.count)}</td><td>${group.count?rateFormat(group.errorRate,2):"—"}</td></tr>`).join("")}</tbody>
      </table></div></details>`;
  const scrubber = host.querySelector(".chart-scrubber");
  function selectPoint(index) {
    host.querySelector(".chart-tooltip").textContent = description(groups[index]);
    host.querySelector(".chart-selected").setAttribute("cx", x(index));
    host.querySelector(".chart-selected").setAttribute("cy", y(values[index]));
    const cursor = host.querySelector(".chart-cursor");
    cursor.setAttribute("x1",x(index)); cursor.setAttribute("x2",x(index));
    scrubber.value=index; scrubber.setAttribute("aria-valuetext",description(groups[index]));
  }
  scrubber.addEventListener("input",()=>selectPoint(Number(scrubber.value)));
  host.querySelectorAll("[data-chart-point]").forEach(point=>point.addEventListener("pointerenter",()=>selectPoint(Number(point.dataset.chartPoint))));
}

function renderReport(payload) {
  const host = el("reportFindings");
  const summary = payload.summary || {};
  const total = Number(summary.total_requests) || 0;
  const errors = Number(summary.error_requests) || 0;
  if (total <= 0) {
    host.innerHTML = `<li class="list-group-item px-4 py-4 text-body-secondary">${escapeHtml(t("report.noData"))}</li>`;
    return;
  }

  const findings = [
    {
      title: t("report.overallTitle"),
      body: t("report.overallBody", {
        total: numberFormat(total),
        errors: numberFormat(errors),
        rate: rateFormat((errors / total) * 100, 2),
      }),
    },
  ];

  const topStatus = payload.error_status_distribution?.[0];
  const topMethod = payload.error_method_distribution?.[0];
  findings.push({
    title: t("report.compositionTitle"),
    body: errors > 0 && topStatus && topMethod
      ? t("report.compositionBody", {
          status: topStatus.label,
          statusShare: rateFormat((Number(topStatus.value) / errors) * 100, 2),
          method: topMethod.label,
          methodShare: rateFormat((Number(topMethod.error_requests) / errors) * 100, 2),
          methodRate: rateFormat(topMethod.error_rate, 2),
        })
      : t("report.noComposition"),
  });

  const topPaths = Array.isArray(payload.top_error_paths) ? payload.top_error_paths : [];
  const leadingPath = topPaths[0];
  const topThreeErrors = topPaths
    .slice(0, 3)
    .reduce((sum, item) => sum + (Number(item.error_requests) || 0), 0);
  findings.push({
    title: t("report.concentrationTitle"),
    body: errors > 0 && leadingPath
      ? t("report.concentrationBody", {
          path: leadingPath.label,
          topShare: rateFormat((Number(leadingPath.error_requests) / errors) * 100, 2),
          topThreeShare: rateFormat((topThreeErrors / errors) * 100, 2),
        })
      : t("report.noConcentration"),
  });

  const groups = groupHourlyTimeline(payload.error_timeline, payload.window);
  const peak = groups.reduce(
    (current, group) => (!current || group.errorCount > current.errorCount ? group : current),
    null,
  );
  findings.push({
    title: t("report.peakTitle"),
    body: peak && peak.errorCount > 0
      ? t("report.peakBody", {
          period: timelineRangeLabel(peak),
          errors: numberFormat(peak.errorCount),
          rate: rateFormat(peak.errorRate, 2),
        })
      : t("report.noPeak"),
  });

  host.innerHTML = findings
    .map(
      (finding) => `
        <li class="list-group-item report-finding px-4 py-3">
          <div class="ms-2 me-auto">
            <div class="paper-heading fw-semibold mb-1">${escapeHtml(finding.title)}</div>
            <div class="small text-body-secondary">${escapeHtml(finding.body)}</div>
          </div>
        </li>
      `,
    )
    .join("");
  host.insertAdjacentHTML("afterbegin", `<li class="report-lead-finding"><div class="metric-label mb-2">${escapeHtml(t("patterns.startHere"))}</div><p class="mb-0">${escapeHtml(reportConclusion(payload))}</p><a href="#typicalFailures" class="small d-inline-block mt-3">${escapeHtml(t("patterns.inspectTypes"))} <span aria-hidden="true">↓</span></a></li>`);
}

function failureSignature(pattern) {
  return `${pattern.method} ${pattern.path} · HTTP ${pattern.status_code} · ${pattern.error_code || t("patterns.noCode")}`;
}

function rankedPatterns(payload) {
  const ranked = window.LogArkAnalytics.rankFailures(payload.failure_patterns || [], payload.failure_pattern_coverage?.total_error_requests ?? payload.summary.error_requests);
  const mode = el("patternSort").value;
  if (mode === "severity") ranked.sort((a,b) => Number(b.status_code >= 500 && b.status_code < 600) - Number(a.status_code >= 500 && a.status_code < 600) || b.count - a.count);
  if (mode === "latency") ranked.sort((a,b) => b.max_duration_ms - a.max_duration_ms || b.count - a.count);
  return ranked;
}

function renderFailurePatterns(payload) {
  const patterns = rankedPatterns(payload);
  const coverage = payload.failure_pattern_coverage;
  const errors = Number(coverage?.total_error_requests ?? payload.summary.error_requests) || 0;
  el("patternCount").textContent = coverage ? t("patterns.groupCount", {shown:patterns.length,total:numberFormat(coverage.total_patterns)}) : "—";
  if (!patterns.length) {
    el("failureCoverage").innerHTML = "";
    el("failurePatterns").innerHTML = emptyState(t(errors > 0 ? "patterns.unavailable" : "patterns.noFailures"));
    return;
  }
  const concentration = window.LogArkAnalytics.concentration(patterns.map(pattern=>pattern.count),errors);
  const covered = clampRate(coverage?.covered_error_rate ?? concentration.coverage_share_pct);
  el("failureCoverage").innerHTML = `<div class="failure-coverage-summary">
    <div><span class="metric-label">${escapeHtml(t("patterns.coverageLabel"))}</span><strong class="coverage-number">${rateFormat(covered)}</strong></div>
    <div class="flex-grow-1"><p class="mb-2 small">${escapeHtml(t("patterns.coverage", {count:patterns.length,shown:numberFormat(coverage?.returned_error_requests ?? patterns.reduce((sum,p)=>sum+p.count,0)),total:numberFormat(errors)}))}</p>
      <div class="coverage-track" role="meter" aria-label="${escapeHtml(t("patterns.coverageLabel"))}" aria-valuenow="${covered}" aria-valuemin="0" aria-valuemax="100"><div class="coverage-value" style="width:${covered}%"></div></div>
      <p class="figure-note mt-2 mb-0">${escapeHtml(t("patterns.coverageNote", {limit:coverage?.limit ?? patterns.length}))}</p>
    </div></div><p class="failure-selection-note">${escapeHtml(t("patterns.sampleStrategy"))}</p>`;
  el("failurePatterns").innerHTML = patterns.map((pattern,index)=>{
    const share = clampRate(pattern.impact_share_pct);
    const originalIndex = payload.failure_patterns.findIndex(item=>item.representative?.id === pattern.representative?.id);
    const label = pattern.status_code >= 500 && pattern.status_code < 600 ? t("patterns.serverFailure") : t("patterns.non200Failure");
    return `<article class="failure-card ${index===0?"failure-card-leading":""}">
      <div class="failure-identity">
      <div class="failure-labels"><span class="failure-rank">${String(index+1).padStart(2,"0")}</span><span class="failure-priority">${escapeHtml(label)}</span></div>
      <div class="failure-signature"><span class="badge text-bg-light border font-monospace">${escapeHtml(pattern.method)}</span><span class="font-monospace small ms-2">HTTP ${Number(pattern.status_code)}</span><h3 class="failure-path">${escapeHtml(pattern.path)}</h3><code class="failure-code">${escapeHtml(pattern.error_code || t("patterns.noCode"))}</code></div>
      </div>
      <div class="failure-stats"><div><strong>${numberFormat(pattern.count)}</strong><span>${escapeHtml(t("patterns.occurrences"))}</span></div><div><strong>${rateFormat(share)}</strong><span>${escapeHtml(t("patterns.failureShare"))}</span></div><div><strong>${durationFormat(pattern.max_duration_ms)}</strong><span>${escapeHtml(t("patterns.maxLatency"))}</span></div></div>
      <div class="failure-evidence"><div>${escapeHtml(t("patterns.average",{duration:durationFormat(pattern.avg_duration_ms)}))}</div><div>${escapeHtml(t("patterns.firstSeen",{time:compactTimeFormat(pattern.first_seen_ts)}))}</div><div>${escapeHtml(t("patterns.lastSeen",{time:compactTimeFormat(pattern.last_seen_ts)}))}</div></div>
      <div class="failure-actions"><button type="button" class="btn ${index===0?"btn-primary":"btn-outline-primary"} btn-sm" data-pattern-detail="${originalIndex}">${escapeHtml(t("patterns.inspect"))}</button><button type="button" class="btn btn-sm btn-link" data-pattern-copy="${originalIndex}">${escapeHtml(t("patterns.copy"))}</button></div>
    </article>`;
  }).join("");
}

function reportConclusion(payload) {
  const errors = Number(payload.failure_pattern_coverage?.total_error_requests ?? payload.summary.error_requests) || 0;
  if (!payload.summary.total_requests && !errors) return t("report.noData");
  if (!errors) return t("patterns.noFailures");
  const groups = payload.failure_patterns || [];
  if (!groups.length) return t("patterns.unavailable");
  const concentration = window.LogArkAnalytics.concentration(groups.map(group=>group.count),errors);
  return t("patterns.conclusion", {count:Math.min(3,groups.length),share:rateFormat(concentration.top_three_share_pct),method:groups[0].method,path:groups[0].path,status:groups[0].status_code,code:groups[0].error_code || t("patterns.noCode")});
}

function maskExportApiKey(value) {
  const key = String(value ?? "");
  if (!key) return "—";
  return key.length <= 8 ? "••••••••" : `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function exportReport() {
  const payload = state.dashboardPayload;
  if (!payload) return;
  const md = value => String(value ?? "").replace(/[\\`*_[\]<>#|]/g,"\\$&").replace(/[\r\n]+/g," ");
  const params = state.appliedDashboardParams || {};
  const filters = Object.entries(params).filter(([,value])=>value!=="").map(([key,value])=>`${key}: ${key === "api_key" ? maskExportApiKey(value) : value}`).join(" · ");
  const lines = [`# TraceNote · ${t("reportView.title")}`,"",`${timeFormat(payload.window.from_ts)} — ${timeFormat(payload.window.to_ts)}`,md(filters),"",`> ${t("patterns.rule")}`,"",`## ${t("report.title")}`,"",md(reportConclusion(payload)),"",
    `- ${t("metrics.auditTotal")}: ${numberFormat(payload.summary.total_requests)}`,
    `- ${t("metrics.non200Count")}: ${numberFormat(payload.summary.error_requests)}`,
    `- ${t("metrics.non200Rate")}: ${rateFormat(payload.summary.error_rate,2)}`,"",
    ...Array.from(el("reportFindings").querySelectorAll(".report-finding")).map(item=>`- ${md(item.textContent.trim())}`),"",
    `## ${t("reportView.failuresTitle")}`,"", md(el("failureCoverage").textContent.trim()),"",t("patterns.sampleStrategy"),""];
  for (const pattern of rankedPatterns(payload)) {
    lines.push(`### ${md(failureSignature(pattern))}`,"",`${t("patterns.occurrences")}: ${numberFormat(pattern.count)} · ${t("patterns.failureShare")}: ${rateFormat(pattern.impact_share_pct)} · ${t("patterns.maxLatency")}: ${durationFormat(pattern.max_duration_ms)}`,md(`request_id: ${pattern.representative?.request_id || "—"} · ID: ${pattern.representative?.id || "—"}`),`${timeFormat(pattern.first_seen_ts)} — ${timeFormat(pattern.last_seen_ts)}`,"");
  }
  const analysis = payload.api_key_analysis;
  if (analysis && Array.isArray(analysis.keys)) {
    lines.push(`## ${t("keyAnalysis.title")}`, "", md(t("keyAnalysis.rankingHelp")), "",
      `${t("keyAnalysis.failingKeys")}: ${analysis.failing_keys} / ${analysis.total_keys}`,
      `${t("keyAnalysis.keyErrors")}: ${numberFormat(analysis.error_requests)}`,
      `${t("keyAnalysis.keyRequests")}: ${numberFormat(analysis.total_requests)}`, "");
    for (const key of analysis.keys) {
      lines.push(`### ${md(maskExportApiKey(key.api_key))}`, "", `${t("keyAnalysis.keyRate")}: ${rateFormat(key.error_rate, 2)}`,
        md(t("keyAnalysis.counts", { errors: numberFormat(key.error_requests), total: numberFormat(key.total_requests) })),
        `${t("keyAnalysis.errorShare")}: ${rateFormat(key.error_share, 2)}`,
        ...(key.total_requests < 20 ? [t("keyAnalysis.smallSample")] : []), "");
      for (const route of key.routes) {
        lines.push(`- ${md(route.path || t("keyAnalysis.emptyPath"))}: ${md(t("keyAnalysis.counts", { errors: numberFormat(route.error_requests), total: numberFormat(route.total_requests) }))} · ${md(t("keyAnalysis.routeRate", { rate: rateFormat(route.error_rate, 2) }))} · ${rateFormat(route.error_share, 1)}`);
      }
      lines.push("", md(t("keyAnalysis.coverage", { shown: key.routes.length, total: key.affected_routes,
        errors: numberFormat(key.returned_route_errors), all: numberFormat(key.error_requests),
        share: rateFormat(key.error_requests ? key.returned_route_errors / key.error_requests * 100 : 0, 1) })), "");
    }
    lines.push(md(t("keyAnalysis.routeMeasure")), "", md(t("keyAnalysis.methodology")), "");
  }
  const url=URL.createObjectURL(new Blob([lines.join("\n")],{type:"text/markdown;charset=utf-8"}));
  const anchor=document.createElement("a"); anchor.href=url; anchor.download=`tracenote-report-${new Date(payload.window.to_ts).toISOString().slice(0,10)}.md`;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function timelineRangeLabel(group) {
  if (group.toTs <= group.fromTs) {
    return compactTimeFormat(group.fromTs);
  }
  return `${compactTimeFormat(group.fromTs)} – ${compactTimeFormat(group.toTs)}`;
}

function bucketLabel(bucketMs) {
  const milliseconds = Number(bucketMs) || 0;
  if (milliseconds < 3_600_000) {
    const count = Math.round(milliseconds / 60_000);
    return t("units.minutes", { count });
  }
  const count = Math.round(milliseconds / 3_600_000);
  return t("units.hours", { count });
}

function renderTimeline(points, windowInfo) {
  const host = el("errorTrend");
  const groups = groupTimeline(points, windowInfo);
  const bucketMs = Number(windowInfo.bucket_ms);
  el("bucketBadge").textContent = groups.some((group) => group.bucketCount > 1)
    ? t("bucket.originalMerged", { size: bucketLabel(bucketMs) })
    : t("bucket.granularity", { size: bucketLabel(bucketMs) });

  if (groups.length === 0) {
    host.innerHTML = emptyState(t("empty.noTrend"));
    return;
  }

  const rows = [...groups]
    .reverse()
    .map((group) => {
      const label = timelineRangeLabel(group);
      const rate = clampRate(group.errorRate);
      const rateLabel = group.count > 0 ? rateFormat(rate) : "—";
      return `
        <tr>
          <td class="ps-4 text-nowrap">${escapeHtml(label)}</td>
          <td class="text-end fw-semibold text-danger-emphasis">${numberFormat(group.errorCount)}</td>
          <td class="text-end text-body-secondary">${numberFormat(group.count)}</td>
          <td class="trend-rate-cell">
            <div class="d-flex align-items-center gap-2">
              <div class="progress rate-progress flex-grow-1" role="progressbar" aria-label="${escapeHtml(t("aria.intervalErrorRate"))}" aria-valuenow="${rate}" aria-valuemin="0" aria-valuemax="100">
                <div class="progress-bar bg-danger" style="width: ${rate}%"></div>
              </div>
              <span class="mini-rate text-end" style="width: 4.4rem">${rateLabel}</span>
            </div>
          </td>
          <td class="pe-4 text-end text-nowrap">${durationFormat(group.avgDurationMs)}</td>
        </tr>
      `;
    })
    .join("");

  host.innerHTML = `
    <div class="table-responsive trend-table-wrap">
      <table class="table trend-table table-hover align-middle mb-0">
        <thead class="table-light">
          <tr>
            <th scope="col" class="ps-4">${escapeHtml(t("columns.intervalLatestFirst"))}</th>
            <th scope="col" class="text-end">${escapeHtml(t("columns.non200"))}</th>
            <th scope="col" class="text-end">${escapeHtml(t("columns.totalRequests"))}</th>
            <th scope="col">${escapeHtml(t("columns.errorRate"))}</th>
            <th scope="col" class="pe-4 text-end">${escapeHtml(t("columns.averageDuration"))}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderStatusDistribution(items, totalErrors) {
  const host = el("statusDistribution");
  if (!Array.isArray(items) || !items.length || totalErrors <= 0) {
    host.innerHTML = emptyState(t("empty.noNon200Statuses"));
    return;
  }
  const rows = [...items].sort((a,b)=>Number(b.value)-Number(a.value));
  const other = Math.max(0,totalErrors-rows.reduce((sum,item)=>sum+Number(item.value),0));
  if(other) rows.push({label:t("common.other"),value:other});
  host.innerHTML = `<div class="status-bars">${rows.map((item,index)=>{
    const share = clampRate(Number(item.value)/totalErrors*100);
    return `<div class="status-bar-row ${index===0?"is-leading":""}">
      <div class="d-flex align-items-center justify-content-between gap-2 mb-2"><span class="font-monospace small fw-semibold">${escapeHtml(/^\d+$/.test(String(item.label))?`HTTP ${item.label}`:item.label)}</span><span class="small">${numberFormat(item.value)} <span class="text-body-secondary ms-2">${rateFormat(share)}</span></span></div>
      <div class="coverage-track" role="meter" aria-label="${escapeHtml(t("aria.statusShare",{status:item.label}))}" aria-valuenow="${share}" aria-valuemin="0" aria-valuemax="100"><div class="coverage-value" style="width:${share}%;background:${index===0?"var(--app-danger)":"var(--app-muted)"}"></div></div>
    </div>`;
  }).join("")}<p class="figure-note mt-4 mb-0">${escapeHtml(t("patterns.statusBasis",{count:numberFormat(totalErrors)}))}</p></div>`;
}

function renderMethodDistribution(items, totalErrors) {
  const host = el("errorMethodDistribution");
  if (!Array.isArray(items) || items.length === 0 || totalErrors <= 0) {
    host.innerHTML = emptyState(t("empty.noMethods"));
    return;
  }

  const rows = items.map((item) => ({ ...item }));
  const representedErrors = rows.reduce(
    (sum, item) => sum + (Number(item.error_requests) || 0),
    0,
  );
  const otherErrors = Math.max(totalErrors - representedErrors, 0);
  if (otherErrors > 0) {
    rows.push({
      label: t("common.other"),
      error_requests: otherErrors,
      error_rate: null,
    });
  }

  host.innerHTML = rows
    .map((item) => {
      const errors = Number(item.error_requests) || 0;
      const contribution = clampRate((errors / totalErrors) * 100);
      const ownRate = Number(item.error_rate);
      const ownRateLabel = Number.isFinite(ownRate)
        ? t("methods.ownRate", { rate: rateFormat(ownRate) })
        : t("methods.aggregated");
      return `
        <div class="list-group-item px-4 py-3">
          <div class="d-flex justify-content-between align-items-start gap-3 mb-2">
            <span class="badge text-bg-light border font-monospace">${escapeHtml(item.label)}</span>
            <div class="text-end">
              <div class="fw-semibold">${numberFormat(errors)}</div>
              <div class="mini-rate">${escapeHtml(t("methods.contribution", { rate: rateFormat(contribution) }))}</div>
            </div>
          </div>
          <div class="progress rate-progress" role="progressbar" aria-label="${escapeHtml(t("aria.methodContribution", { method: item.label }))}" aria-valuenow="${contribution}" aria-valuemin="0" aria-valuemax="100">
            <div class="progress-bar bg-danger" style="width: ${contribution}%"></div>
          </div>
          <div class="figure-note mt-2">${escapeHtml(ownRateLabel)}</div>
        </div>
      `;
    })
    .join("");
}

function renderTopErrorPaths(items) {
  const host = el("topErrorPaths");
  if (!Array.isArray(items) || items.length === 0) {
    host.innerHTML = emptyRow(4, t("empty.noNon200Paths"));
    return;
  }

  host.innerHTML = items
    .map((item) => {
      const rate = clampRate(item.error_rate);
      return `
        <tr>
          <td class="ps-4 path-cell"><code class="text-body">${escapeHtml(item.label)}</code></td>
          <td class="text-end fw-semibold text-danger-emphasis">${numberFormat(item.error_requests)}</td>
          <td class="text-end text-body-secondary">${numberFormat(item.total_requests)}</td>
          <td class="pe-4 error-rate-column">
            <div class="d-flex align-items-center gap-2">
              <div class="progress rate-progress flex-grow-1" role="progressbar" aria-label="${escapeHtml(t("aria.endpointErrorRate"))}" aria-valuenow="${rate}" aria-valuemin="0" aria-valuemax="100">
                <div class="progress-bar bg-danger" style="width: ${rate}%"></div>
              </div>
              <span class="mini-rate text-end" style="width: 4.4rem">${rateFormat(rate)}</span>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderApiKeyAnalysis(payload) {
  const analysis = payload.api_key_analysis;
  const keys = analysis?.keys;
  if (!analysis || !Array.isArray(keys)) {
    el("apiKeySummary").innerHTML = "";
    el("apiKeyCount").textContent = "";
    el("apiKeyRanking").innerHTML = emptyState(t("keyAnalysis.unavailable"));
    el("apiKeyRoutes").innerHTML = emptyState(t("keyAnalysis.unavailable"));
    return;
  }
  el("apiKeySummary").innerHTML = [
    [t("keyAnalysis.failingKeys"), `${numberFormat(analysis.failing_keys)} / ${numberFormat(analysis.total_keys)}`],
    [t("keyAnalysis.keyErrors"), numberFormat(analysis.error_requests)],
    [t("keyAnalysis.keyRequests"), numberFormat(analysis.total_requests)],
  ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  el("apiKeyCount").textContent = t("keyAnalysis.count", { shown: keys.length, total: numberFormat(analysis.failing_keys) });
  if (!keys.length) {
    state.selectedApiKey = null;
    const message = t(analysis.total_keys ? "keyAnalysis.noFailures" : "keyAnalysis.noKeys");
    el("apiKeyRanking").innerHTML = emptyState(message);
    el("apiKeyRoutes").innerHTML = emptyState(message);
    return;
  }
  if (!keys.some(key => key.api_key === state.selectedApiKey)) state.selectedApiKey = keys[0].api_key;
  el("apiKeyRanking").innerHTML = keys.map((key, index) => {
    const selected = key.api_key === state.selectedApiKey;
    return `<button type="button" class="key-ranking-row${selected ? " is-selected" : ""}" data-key-index="${index}" aria-pressed="${selected}" aria-controls="apiKeyRoutes">
      <span class="key-rank" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
      <span class="key-identity"><code class="key-value">${escapeHtml(key.api_key)}</code><span class="key-counts">${escapeHtml(t("keyAnalysis.counts", { errors: numberFormat(key.error_requests), total: numberFormat(key.total_requests) }))}</span>${key.total_requests < 20 ? `<span class="key-sample-note">${escapeHtml(t("keyAnalysis.smallSample"))}</span>` : ""}</span>
      <span class="key-rate">${rateFormat(key.error_rate, 2)}<span class="key-rate-track" aria-hidden="true"><span style="width:${clampRate(key.error_rate)}%"></span></span></span>
    </button>`;
  }).join("");
  renderApiKeyRoutes(keys.find(key => key.api_key === state.selectedApiKey));
}

function renderApiKeyRoutes(key) {
  const routes = key.routes || [];
  const covered = key.error_requests > 0 ? key.returned_route_errors / key.error_requests * 100 : 0;
  el("apiKeyRoutes").innerHTML = `
    <div class="key-selected-heading"><div><span class="key-selected-label">${escapeHtml(t("keyAnalysis.selected"))}</span><code id="selectedApiKey">${escapeHtml(key.api_key)}</code></div><button type="button" class="btn btn-sm btn-outline-secondary" data-copy-api-key>${escapeHtml(t("keyAnalysis.copy"))}</button></div>
    <dl class="key-selected-stats"><div><dt>${escapeHtml(t("keyAnalysis.keyRate"))}</dt><dd>${rateFormat(key.error_rate, 2)}</dd></div><div><dt>${escapeHtml(t("keyAnalysis.errorShare"))}</dt><dd>${rateFormat(key.error_share, 2)}</dd></div><div><dt>${escapeHtml(t("keyAnalysis.affectedRoutes"))}</dt><dd>${numberFormat(key.affected_routes)}</dd></div></dl>
    <p class="key-route-measure">${escapeHtml(t("keyAnalysis.routeMeasure"))}</p>
    <div class="key-route-axis" aria-hidden="true"><span>0%</span><span>50%</span><span>100%</span></div>
    <ol class="key-route-list">${routes.map((route, index) => `<li class="key-route-row${index === 0 ? " is-leading" : ""}">
      <div class="key-route-heading"><code class="route-path">${escapeHtml(route.path || t("keyAnalysis.emptyPath"))}</code><strong class="route-share">${rateFormat(route.error_share, 1)}</strong></div>
      <div class="key-route-track" aria-hidden="true"><span style="width:${clampRate(route.error_share)}%"></span></div>
      <div class="key-route-evidence"><span>${escapeHtml(t("keyAnalysis.counts", { errors: numberFormat(route.error_requests), total: numberFormat(route.total_requests) }))}</span><span>${escapeHtml(t("keyAnalysis.routeRate", { rate: rateFormat(route.error_rate, 2) }))}</span></div>
    </li>`).join("")}</ol>
    <p id="apiKeyRouteCoverage" class="key-route-coverage">${escapeHtml(t("keyAnalysis.coverage", { shown: routes.length, total: numberFormat(key.affected_routes), errors: numberFormat(key.returned_route_errors), all: numberFormat(key.error_requests), share: rateFormat(covered, 1) }))}</p>`;
}

function renderDimensionList(targetId, items) {
  const host = el(targetId);
  if (!Array.isArray(items) || items.length === 0) {
    host.innerHTML = emptyState(t("empty.noNon200Data"));
    return;
  }

  host.innerHTML = items
    .map((item) => {
      const displayLabel = item.label;
      return `
        <div class="list-group-item px-4 py-3 d-flex align-items-center justify-content-between gap-3">
          <div class="dimension-label" title="${escapeHtml(displayLabel)}">${escapeHtml(displayLabel)}</div>
          <div class="text-end flex-shrink-0">
            <div class="fw-semibold text-danger-emphasis">${escapeHtml(t("ranking.errorCount", {
              count: Number(item.error_requests) || 0,
              value: numberFormat(item.error_requests),
            }))}</div>
            <div class="mini-rate">${escapeHtml(t("ranking.rateAndTotal", {
              count: Number(item.total_requests) || 0,
              rate: rateFormat(item.error_rate),
              total: numberFormat(item.total_requests),
            }))}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function recordRow(item, columns = "full") {
  const id = Number(item.id);
  const safeId = Number.isFinite(id) ? id : "";
  const common = `class="table-action-row" data-record-id="${safeId}" tabindex="0" aria-label="${escapeHtml(t("aria.viewRequest", { requestId: item.request_id }))}"`;
  const methodPath = `<span class="badge text-bg-light border me-2">${escapeHtml(item.method)}</span><code class="text-body">${escapeHtml(item.path)}</code>`;
  const detailButton = `<button type="button" class="btn btn-sm btn-outline-secondary text-nowrap" aria-label="${escapeHtml(t("aria.viewRequest", { requestId: item.request_id }))}">${iconMarkup("eye")}<span class="ms-1">${escapeHtml(t("actions.view"))}</span></button>`;

  if (columns === "latest") {
    return `
      <tr ${common}>
        <td class="ps-4 text-nowrap">${escapeHtml(timeFormat(item.request_ts))}</td>
        <td>${statusBadge(item.status_code)}</td>
        <td class="path-cell">${methodPath}</td>
        <td class="text-nowrap">${escapeHtml(durationFormat(item.duration_ms))}</td>
        <td class="mono-cell" title="${escapeHtml(item.request_id)}">${escapeHtml(item.request_id)}</td>
        <td class="pe-4">
          <div class="d-flex align-items-center justify-content-between gap-2">
            <span>${escapeHtml(item.error_code || "—")}</span>
            ${detailButton}
          </div>
        </td>
      </tr>
    `;
  }

  return `
    <tr ${common}>
      <td class="ps-4 text-nowrap">#${Number.isFinite(id) ? id : "—"}</td>
      <td class="text-nowrap">${escapeHtml(timeFormat(item.request_ts))}</td>
      <td>${statusBadge(item.status_code)}</td>
      <td class="path-cell">${methodPath}</td>
      <td class="text-nowrap">${escapeHtml(durationFormat(item.duration_ms))}</td>
      <td class="mono-cell" title="${escapeHtml(item.request_id)}">${escapeHtml(item.request_id)}</td>
      <td class="mono-cell" title="${escapeHtml(item.task_id || "")}">${escapeHtml(item.task_id || "—")}</td>
      <td class="pe-4 text-nowrap">
        <div class="d-flex align-items-center justify-content-between gap-2">
          <span>${escapeHtml(item.error_code || "—")}</span>
          ${detailButton}
        </div>
      </td>
    </tr>
  `;
}

function renderLatestErrors(items) {
  el("latestErrors").innerHTML = Array.isArray(items) && items.length > 0
    ? items.map((item) => recordRow(item, "latest")).join("")
    : emptyRow(6, t("empty.noNon200Requests"));
}

function renderRecords(payload, append) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const rows = items.map((item) => recordRow(item)).join("");

  if (append) {
    el("recordsTable").insertAdjacentHTML("beforeend", rows);
    state.renderedRecordCount += items.length;
  } else {
    el("recordsTable").innerHTML = rows || emptyRow(8, t("empty.noMatchingRecords"));
    state.renderedRecordCount = items.length;
  }

  state.nextCursorTs = payload.next_cursor_ts;
  state.nextCursorId = payload.next_cursor_id;
  el("loadMoreButton").disabled = !payload.next_cursor_ts;
  const appliedFilters = state.recordBaseParams || {};
  const scope = appliedFilters.status_code !== "" && appliedFilters.status_code !== undefined
    ? t("scope.statusCode", { status: appliedFilters.status_code })
    : appliedFilters.non_200
      ? t("scope.non200Only")
      : t("scope.allStatuses");
  el("recordCount").textContent = t("records.loadedCount", {
    count: state.renderedRecordCount,
    value: numberFormat(state.renderedRecordCount),
    scope,
  });
}

function prettyText(value) {
  if (value === null || value === undefined || value === "") return t("content.empty");
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch (_) {
    return value;
  }
}

function renderDetail(record) {
  el("detailError").classList.add("d-none");
  el("detailStatus").innerHTML = statusBadge(record.status_code);
  el("detailSubtitle").textContent = `${record.method} ${record.path} · ${timeFormat(record.request_ts)}`;
  const context = el("detailPatternContext");
  context.classList.toggle("d-none", !state.detailPattern);
  context.textContent = state.detailPattern ? t("patterns.detailContext", {count: numberFormat(state.detailPattern.count), share: rateFormat(state.detailPattern.impact_share_pct ?? state.detailPattern.error_share), signature: failureSignature(state.detailPattern)}) : "";

  const meta = [
    [t("detail.recordId"), `#${record.id}`],
    ["request_id", record.request_id],
    ["uuid", record.uuid || "—"],
    ["task_id", record.task_id || "—"],
    [t("fields.taskType"), record.task_type || "—"],
    [t("fields.errorCode"), record.error_code || "—"],
    [t("columns.duration"), durationFormat(record.duration_ms)],
    [t("detail.clientIp"), record.client_ip || "—"],
    ["API Key", record.api_key || "—"],
    ["bid", record.bid || "—"],
    [t("detail.query"), record.query_string || "—"],
    [t("detail.bodySize"), `${numberFormat(record.request_body_size)} B → ${numberFormat(record.response_body_size)} B`],
  ];

  el("detailMeta").innerHTML = meta
    .map(
      ([label, value]) => `
        <div class="col-12 col-sm-6 col-lg-4">
          <div class="detail-meta-card">
            <div class="detail-label">${escapeHtml(label)}</div>
            <div class="detail-value">${escapeHtml(value)}</div>
          </div>
        </div>
      `,
    )
    .join("");

  el("requestHeaders").textContent = prettyText(record.request_headers_json);
  el("responseHeaders").textContent = prettyText(record.response_headers_json);
  el("requestBody").textContent = prettyText(record.request_body);
  el("responseBody").textContent = prettyText(record.response_body);
}

function showPageError(error) {
  el("pageAlertMessage").textContent = error instanceof Error ? error.message : String(error);
  el("pageAlert").classList.remove("d-none");
}

function hidePageError() {
  el("pageAlert").classList.add("d-none");
}

function setRefreshLoading(loading) {
  el("refreshButton").disabled = loading && state.dashboardRequest?.key === queryString(buildDashboardParams());
  el("refreshButton").setAttribute("aria-busy", String(loading));
  el("refreshSpinner").classList.toggle("d-none", !loading);
  el("refreshIcon").classList.toggle("d-none", loading);
}

const refreshStatus = document.createElement("p");
refreshStatus.className = "report-refresh-status";
refreshStatus.setAttribute("role", "status");
refreshStatus.setAttribute("aria-live", "polite");
refreshStatus.hidden = true;
el("dashboardFilter").insertAdjacentElement("afterend", refreshStatus);

function displayedScope() {
  const params = state.appliedDashboardParams;
  if (!params) return "";
  const parts = [timeWindowLabel(state.dashboardPayload.window.hours)];
  if (params.path) parts.push(`${t("fields.pathPrefix")}: ${params.path}`);
  if (params.method) parts.push(`${t("fields.method")}: ${params.method}`);
  if (params.task_type) parts.push(`${t("fields.taskType")}: ${params.task_type}`);
  if (params.api_key) parts.push(`${t("fields.apiKey")}: ${params.api_key}`);
  return parts.join(" · ");
}

function renderRefreshStatus() {
  setRefreshLoading(state.dashboardLoading);
  el("apiKeyAnalysis").setAttribute("aria-busy", String(state.dashboardLoading));
  if (!state.dashboardPayload) renderInitialReportState(state.dashboardLoading);
  const hasReport = Boolean(state.dashboardPayload);
  let message = "";
  if (state.dashboardLoading) {
    message = hasReport ? t("refresh.updating") : t("refresh.reading");
    if (state.dashboardSlow) message += ` ${t("refresh.waiting")}`;
  } else if (state.dashboardRefreshFailed) {
    message = hasReport ? t("refresh.failedExisting") : t("refresh.failedInitial");
  } else if (hasReport && queryString(buildDashboardParams()) !== queryString(state.appliedDashboardParams)) {
    message = t("refresh.filtersPending");
  }
  refreshStatus.textContent = message;
  refreshStatus.hidden = !message;
  refreshStatus.dataset.state = state.dashboardLoading ? "loading" : state.dashboardRefreshFailed ? "failed" : "pending";
  if (hasReport) {
    const { from_ts, to_ts } = state.dashboardPayload.window;
    el("reportFreshness").textContent = `${t("refresh.displayedScope", { scope: displayedScope() })}\n${timeFormat(from_ts)} — ${timeFormat(to_ts)}`;
  }
  if (state.dashboardUpdatedAt) {
    el("lastUpdated").textContent = t("status.updatedAt", {
      time: state.dashboardUpdatedAt.toLocaleTimeString(i18n.locale, { hour12: false }),
    });
  }
}

function renderInitialReportState(loading) {
  if (state.dashboardPayload) return;
  let status = loading ? t("refresh.reading") : t("refresh.failedInitial");
  if (loading && state.dashboardSlow) status += ` ${t("refresh.waiting")}`;
  const message = escapeHtml(status);
  const spinner = loading ? '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span>' : "";
  el("metricCards").innerHTML = `<div class="metrics-loading text-body-secondary">${spinner}<span>${message}</span></div>`;
  el("failurePatterns").innerHTML = `<div class="empty-state">${message}</div>`;
  el("apiKeyRanking").innerHTML = `<div class="empty-state">${message}</div>`;
  el("apiKeyRoutes").innerHTML = `<div class="empty-state">${message}</div>`;
}

async function loadDashboard(params, signal) {
  const token = ++state.dashboardRequestToken;
  let payload;
  try {
    payload = await fetchJson(`/api/dashboard?${queryString(params)}`, signal);
  } catch (error) {
    if (token !== state.dashboardRequestToken) return false;
    throw error;
  }
  if (token !== state.dashboardRequestToken) return false;
  state.dashboardPayload = payload;
  state.appliedDashboardParams = params;
  renderDashboardPayload(payload);
  return true;
}

function renderDashboardPayload(payload) {
  renderMetricCards(payload.summary);
  renderReport(payload);
  renderHourlyVolumeChart(payload.error_timeline, payload.window);
  renderErrorShare(payload.summary);
  renderTimeline(payload.error_timeline, payload.window);
  renderStatusDistribution(payload.error_status_distribution, Number(payload.summary.error_requests) || 0);
  renderMethodDistribution(payload.error_method_distribution, Number(payload.summary.error_requests) || 0);
  renderTopErrorPaths(payload.top_error_paths);
  renderDimensionList("topErrorKeys", payload.top_error_api_keys);
  renderApiKeyAnalysis(payload);
  renderDimensionList("topErrorTasks", payload.top_error_task_types);
  renderLatestErrors(payload.latest_errors);
  renderFailurePatterns(payload);
  window.LogArkFigures.render(payload, { t, locale: i18n.locale });
  el("reportExportButton").disabled = false;
  el("exportPreviewRange").textContent = timeWindowLabel(payload.window.hours);
  el("exportPreviewStats").innerHTML = [
    [t("metrics.auditTotal"), numberFormat(payload.summary.total_requests)],
    [t("metrics.non200Rate"), rateFormat(payload.summary.error_rate, 2)],
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  el("reportFreshness").textContent = `${timeFormat(payload.window.from_ts)} — ${timeFormat(payload.window.to_ts)}`;
  el("windowBadge").textContent = timeWindowLabel(payload.window.hours);
  el("windowBadge").title = t("time.rangeTitle", {
    from: timeFormat(payload.window.from_ts),
    to: timeFormat(payload.window.to_ts),
  });
  renderRefreshStatus();
}

async function loadRecords(append = false) {
  const params = buildRecordParams(append);
  const token = ++state.recordRequestToken;
  state.recordRequestController?.abort();
  const controller = new AbortController();
  state.recordRequestController = controller;
  state.recordsLoading = true;
  const spinner = el("loadMoreSpinner");
  const loadMoreButton = el("loadMoreButton");
  const searchButton = el("searchButton");
  loadMoreButton.disabled = true;
  loadMoreButton.setAttribute("aria-busy", String(append));
  searchButton.disabled = !append;
  searchButton.setAttribute("aria-busy", String(!append));
  if (append) {
    spinner.classList.remove("d-none");
  } else {
    state.nextCursorTs = null;
    state.nextCursorId = null;
  }

  try {
    const payload = await fetchJson(`/api/records?${queryString(params)}`, controller.signal);
    if (token !== state.recordRequestToken) return false;
    renderRecords(payload, append);
    state.recordsLoaded = true;
    return true;
  } catch (error) {
    if (token !== state.recordRequestToken) return false;
    throw error;
  } finally {
    if (token === state.recordRequestToken) {
      state.recordRequestController = null;
      state.recordsLoading = false;
      spinner.classList.add("d-none");
      loadMoreButton.disabled = !state.nextCursorTs;
      loadMoreButton.setAttribute("aria-busy", "false");
      searchButton.disabled = false;
      searchButton.setAttribute("aria-busy", "false");
    }
  }
}

function refreshAll() {
  const params = buildDashboardParams();
  const key = queryString(params);
  if (state.dashboardRequest?.key === key) return state.dashboardRequest.promise;
  state.dashboardRequest?.controller.abort();
  const controller = new AbortController();
  const request = { key, controller, promise: null };
  state.dashboardRequest = request;
  const token = ++state.refreshToken;
  hidePageError();
  state.dashboardLoading = true;
  state.dashboardSlow = false;
  state.dashboardRefreshFailed = false;
  setRefreshLoading(true);
  el("reportExportButton").disabled = !state.dashboardPayload;
  renderInitialReportState(true);
  renderRefreshStatus();
  const slowTimer = setTimeout(() => {
    if (token !== state.refreshToken) return;
    state.dashboardSlow = true;
    renderRefreshStatus();
  }, 4000);
  request.promise = (async () => {
    try {
      const loaded = await loadDashboard(params, controller.signal);
      if (token !== state.refreshToken || !loaded) return;
      state.dashboardUpdatedAt = new Date();
      state.recordsLoaded = false;
      ++state.recordRequestToken;
      state.recordRequestController?.abort();
      state.recordRequestController = null;
      state.recordsLoading = false;
      state.recordBaseParams = null;
      state.nextCursorTs = null;
      state.nextCursorId = null;
      el("recordsTable").innerHTML = emptyRow(8, t("states.loading"));
      state.renderedRecordCount = 0;
      el("recordCount").textContent = "—";
      el("loadMoreButton").disabled = true;
      el("loadMoreButton").setAttribute("aria-busy", "false");
      el("loadMoreSpinner").classList.add("d-none");
      el("searchButton").disabled = false;
      el("searchButton").setAttribute("aria-busy", "false");
      if (el("recordsDisclosure").open) loadRecords(false).catch(showPageError);
    } catch (error) {
      if (token === state.refreshToken && error.name !== "AbortError") {
        state.dashboardRefreshFailed = true;
        showPageError(error);
        renderInitialReportState(false);
      }
    } finally {
      clearTimeout(slowTimer);
      if (token === state.refreshToken) {
        state.dashboardRequest = null;
        state.dashboardLoading = false;
        state.dashboardSlow = false;
        setRefreshLoading(false);
        renderRefreshStatus();
      }
    }
  })();
  return request.promise;
}

async function loadDetailById(id, pattern = null) {
  if (!id) return;
  const token = ++state.detailRequestToken;
  state.detailPattern = pattern;
  state.detailModal.show();
  el("detailLoading").classList.remove("d-none");
  el("detailError").classList.add("d-none");
  el("detailContent").classList.add("d-none");
  el("detailStatus").innerHTML = "";
  el("detailSubtitle").textContent = t("detail.loadingRecord", { id });

  try {
    const record = await fetchJson(`/api/records/${encodeURIComponent(id)}`);
    if (token !== state.detailRequestToken) return;
    renderDetail(record);
    el("detailContent").classList.remove("d-none");
  } catch (error) {
    if (token !== state.detailRequestToken) return;
    el("detailSubtitle").textContent = t("detail.recordLoadFailed", { id });
    el("detailError").textContent = error.message;
    el("detailError").classList.remove("d-none");
  } finally {
    if (token === state.detailRequestToken) {
      el("detailLoading").classList.add("d-none");
    }
  }
}

function handleRecordActivation(event) {
  if (event.type === "keydown") {
    if (event.target.closest("button, a, input, select, textarea")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
  }
  const row = event.target.closest("tr[data-record-id]");
  if (!row) return;
  loadDetailById(row.dataset.recordId);
}

el("dashboardFilter").addEventListener("submit", (event) => {
  event.preventDefault();
  refreshAll();
});
el("dashboardFilter").addEventListener("input", renderRefreshStatus);

el("recordFilter").addEventListener("submit", (event) => {
  event.preventDefault();
  hidePageError();
  loadRecords(false).catch(showPageError);
});

el("loadMoreButton").addEventListener("click", () => {
  hidePageError();
  loadRecords(true).catch(showPageError);
});

el("resetDashboardButton").addEventListener("click", () => {
  el("dashboardFilter").reset();
  refreshAll();
});

el("resetRecordButton").addEventListener("click", () => {
  el("recordFilter").reset();
  hidePageError();
  loadRecords(false).catch(showPageError);
});

document.querySelector("[data-alert-close]").addEventListener("click", hidePageError);
el("latestErrors").addEventListener("click", handleRecordActivation);
el("recordsTable").addEventListener("click", handleRecordActivation);
el("latestErrors").addEventListener("keydown", handleRecordActivation);
el("recordsTable").addEventListener("keydown", handleRecordActivation);

el("localeSelect").addEventListener("change", (event) => {
  if (!i18n.setLocale(event.target.value)) return;
  i18n.apply();
  if (state.dashboardPayload) renderDashboardPayload(state.dashboardPayload);
  else renderInitialReportState(state.dashboardLoading);
  renderRefreshStatus();
  if (el("recordsDisclosure").open) loadRecords(false).catch(showPageError);
});

el("patternSort").addEventListener("change", () => {
  if (state.dashboardPayload) renderFailurePatterns(state.dashboardPayload);
});
el("apiKeyRanking").addEventListener("click", (event) => {
  const button = event.target.closest("[data-key-index]");
  const key = state.dashboardPayload?.api_key_analysis?.keys[Number(button?.dataset.keyIndex)];
  if (!button || !key) return;
  state.selectedApiKey = key.api_key;
  el("apiKeyRanking").querySelectorAll("[data-key-index]").forEach(item => {
    const selected = item === button;
    item.classList.toggle("is-selected", selected);
    item.setAttribute("aria-pressed", String(selected));
  });
  renderApiKeyRoutes(key);
});
el("apiKeyRoutes").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-api-key]");
  if (!button || !state.selectedApiKey) return;
  try {
    await navigator.clipboard.writeText(state.selectedApiKey);
    button.textContent = t("patterns.copied");
    setTimeout(() => { if (button.isConnected) button.textContent = t("keyAnalysis.copy"); }, 1800);
  } catch (_) {
    showPageError(new Error(t("patterns.copyFailed")));
  }
});
el("hours").addEventListener("change", refreshAll);
el("reportExportButton").addEventListener("click", exportReport);
el("recordsDisclosure").addEventListener("toggle", () => {
  if (el("recordsDisclosure").open && state.dashboardPayload && !state.recordsLoaded && !state.recordsLoading) loadRecords(false).catch(showPageError);
});
el("hourlyVolumeChart").addEventListener("click", (event) => {
  const button = event.target.closest("[data-chart-mode]");
  if (!button || !state.dashboardPayload) return;
  state.chartMode = button.dataset.chartMode;
  renderHourlyVolumeChart(state.dashboardPayload.error_timeline, state.dashboardPayload.window);
  el("hourlyVolumeChart").querySelector(`[data-chart-mode="${state.chartMode}"]`)?.focus();
});
el("failurePatterns").addEventListener("click", async (event) => {
  const detailButton = event.target.closest("[data-pattern-detail]");
  const copyButton = event.target.closest("[data-pattern-copy]");
  const button = detailButton || copyButton;
  if (!button || !state.dashboardPayload) return;
  const pattern = state.dashboardPayload.failure_patterns[Number(detailButton ? button.dataset.patternDetail : button.dataset.patternCopy)];
  if (!pattern) return;
  if (detailButton) { loadDetailById(pattern.representative?.id, pattern); return; }
  try {
    await navigator.clipboard.writeText(`${failureSignature(pattern)}\nrequest_id: ${pattern.representative?.request_id || ""}`);
    button.textContent = t("patterns.copied");
    setTimeout(()=>{if(button.isConnected)button.textContent=t("patterns.copy");},1800);
  } catch (_) {
    showPageError(new Error(t("patterns.copyFailed")));
  }
});
document.querySelectorAll('a[href="#recordsDisclosure"], a[href="#requestDetails"]').forEach(link=>link.addEventListener("click",()=>{el("recordsDisclosure").open=true;}));
document.querySelectorAll(".report-nav a, .report-side-nav a").forEach(link=>link.addEventListener("click",()=>{
  document.querySelectorAll(".report-nav a, .report-side-nav a").forEach(item=>{
    const active = item.getAttribute("href") === link.getAttribute("href");
    item.classList.toggle("active",active);
    if(active)item.setAttribute("aria-current","location");
    else item.removeAttribute("aria-current");
  });
}));
let chartResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(() => {
    if (state.dashboardPayload) {
      renderHourlyVolumeChart(state.dashboardPayload.error_timeline, state.dashboardPayload.window);
      window.LogArkFigures.render(state.dashboardPayload, { t, locale: i18n.locale });
    }
  }, 150);
});

if (typeof bootstrap !== "undefined" && bootstrap.Modal) {
  state.detailModal = bootstrap.Modal.getOrCreateInstance(el("detailModal"));
} else {
  const modalElement = el("detailModal");
  state.detailModal = {
    show() {
      modalElement.style.display = "block";
      modalElement.classList.add("show");
      modalElement.setAttribute("aria-hidden", "false");
    },
  };
  const fallbackClose = document.querySelector("#detailModal [data-bs-dismiss='modal']");
  fallbackClose?.addEventListener("click", () => {
    modalElement.classList.remove("show");
    modalElement.style.display = "none";
    modalElement.setAttribute("aria-hidden", "true");
  });
  const fallbackAccordionButtons = document.querySelectorAll("#detailAccordion [data-bs-toggle='collapse']");
  const fallbackAccordionPanels = document.querySelectorAll("#detailAccordion .accordion-collapse");
  fallbackAccordionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const target = document.querySelector(button.getAttribute("data-bs-target"));
      fallbackAccordionPanels.forEach((panel) => panel.classList.toggle("show", panel === target));
      fallbackAccordionButtons.forEach((item) => {
        const expanded = item === button;
        item.classList.toggle("collapsed", !expanded);
        item.setAttribute("aria-expanded", String(expanded));
      });
    });
  });
}

i18n.apply();
refreshAll();
