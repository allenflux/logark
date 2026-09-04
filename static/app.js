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
  recordBaseParams: null,
  detailModal: null,
};

const el = (id) => document.getElementById(id);

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
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
    api_key: el("apiKey").value.trim(),
  };
}

function buildRecordParams(append) {
  let baseParams = state.recordBaseParams;
  if (!append || !baseParams) {
    const statusCode = validatedStatusCode();
    baseParams = {
      ...buildDashboardParams(),
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

function maskApiKey(value) {
  const key = String(value || "");
  if (!key) return "—";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
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
  const peakBadge = el("hourlyPeakBadge");
  const groups = groupHourlyTimeline(points, windowInfo);
  if (groups.length === 0) {
    peakBadge.textContent = "—";
    host.innerHTML = emptyState(t("empty.noHourlyVolume"));
    return;
  }

  const peak = groups.reduce(
    (current, group, index) =>
      !current || group.errorCount > current.group.errorCount ? { group, index } : current,
    null,
  );
  peakBadge.textContent = t("hourly.peakBadge", { value: numberFormat(peak.group.errorCount) });

  const width = 1120;
  const height = 320;
  const margin = { top: 18, right: 24, bottom: 56, left: 76 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const axis = niceCountAxis(peak.group.errorCount);
  const x = (index) => margin.left + (index / Math.max(groups.length - 1, 1)) * plotWidth;
  const y = (value) => margin.top + plotHeight - (value / axis.max) * plotHeight;
  const linePath = groups
    .map((group, index) => `${index === 0 ? "M" : "L"} ${x(index).toFixed(2)} ${y(group.errorCount).toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L ${x(groups.length - 1).toFixed(2)} ${(margin.top + plotHeight).toFixed(2)} L ${x(0).toFixed(2)} ${(margin.top + plotHeight).toFixed(2)} Z`;

  const yGrid = axis.ticks
    .map((value) => {
      const position = y(value).toFixed(2);
      return `
        <line class="hourly-grid-line" x1="${margin.left}" y1="${position}" x2="${width - margin.right}" y2="${position}"></line>
        <text class="hourly-axis-label" x="${margin.left - 12}" y="${Number(position) + 4}" text-anchor="end">${escapeHtml(numberFormat(value))}</text>
      `;
    })
    .join("");

  const xGrid = sampledIndices(groups.length)
    .map((index) => {
      const position = x(index).toFixed(2);
      const label = hourTickFormat(groups[index].fromTs);
      const anchor = index === 0 ? "start" : index === groups.length - 1 ? "end" : "middle";
      return `
        <line class="hourly-grid-line hourly-grid-line-x" x1="${position}" y1="${margin.top}" x2="${position}" y2="${margin.top + plotHeight}"></line>
        <text class="hourly-axis-label" x="${position}" y="${height - 22}" text-anchor="${anchor}">${escapeHtml(label)}</text>
      `;
    })
    .join("");

  const pointMarks = groups
    .map((group, index) => {
      const label = t("hourly.pointAria", {
        time: timelineRangeLabel(group),
        errors: numberFormat(group.errorCount),
        total: numberFormat(group.count),
        rate: rateFormat(group.errorRate, 2),
      });
      return `
        <circle class="hourly-point${index === peak.index ? " hourly-point-peak" : ""}" cx="${x(index).toFixed(2)}" cy="${y(group.errorCount).toFixed(2)}" r="${groups.length > 96 ? 2.2 : 3.2}">
          <title>${escapeHtml(label)}</title>
        </circle>
      `;
    })
    .join("");

  const chartLabel = t("hourly.chartAria", {
    count: groups.length,
    peak: numberFormat(peak.group.errorCount),
  });
  const caption = t("hourly.caption");
  const dataRows = groups
    .map(
      (group) => `
        <tr>
          <td class="ps-3 text-nowrap">${escapeHtml(timelineRangeLabel(group))}</td>
          <td class="text-end fw-semibold text-danger-emphasis">${numberFormat(group.errorCount)}</td>
          <td class="text-end">${numberFormat(group.count)}</td>
          <td class="pe-3 text-end">${rateFormat(group.errorRate, 2)}</td>
        </tr>
      `,
    )
    .join("");
  host.innerHTML = `
    <figure class="hourly-figure mb-0">
      <div class="hourly-chart-scroll" tabindex="0" aria-label="${escapeHtml(t("hourly.scrollAria"))}">
        <svg class="hourly-chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="hourlyChartTitle hourlyChartDescription">
          <title id="hourlyChartTitle">${escapeHtml(chartLabel)}</title>
          <desc id="hourlyChartDescription">${escapeHtml(caption)}</desc>
          ${yGrid}
          ${xGrid}
          <text class="hourly-axis-title" x="18" y="${margin.top + plotHeight / 2}" text-anchor="middle" transform="rotate(-90 18 ${margin.top + plotHeight / 2})">${escapeHtml(t("hourly.axisY"))}</text>
          <path class="hourly-area" d="${areaPath}"></path>
          <path class="hourly-line" d="${linePath}"></path>
          ${pointMarks}
        </svg>
      </div>
      <figcaption class="figure-note mt-3">${escapeHtml(caption)}</figcaption>
    </figure>
    <details class="hourly-data-details mt-3">
      <summary class="small fw-semibold text-body-secondary">${escapeHtml(t("hourly.dataTable"))}</summary>
      <div class="table-responsive hourly-data-table-wrap mt-2">
        <table class="table table-sm align-middle mb-0">
          <caption class="visually-hidden">${escapeHtml(t("hourly.tableAria"))}</caption>
          <thead class="table-light">
            <tr>
              <th scope="col" class="ps-3">${escapeHtml(t("columns.time"))}</th>
              <th scope="col" class="text-end">${escapeHtml(t("columns.non200"))}</th>
              <th scope="col" class="text-end">${escapeHtml(t("columns.totalRequests"))}</th>
              <th scope="col" class="pe-3 text-end">${escapeHtml(t("columns.errorRate"))}</th>
            </tr>
          </thead>
          <tbody>${dataRows}</tbody>
        </table>
      </div>
    </details>
  `;
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
  if (!Array.isArray(items) || items.length === 0) {
    host.innerHTML = emptyState(t("empty.noNon200Statuses"));
    return;
  }

  host.innerHTML = items
    .map((item) => {
      const value = Number(item.value) || 0;
      const share = totalErrors > 0 ? (value / totalErrors) * 100 : 0;
      return `
        <div class="list-group-item px-4 py-3">
          <div class="d-flex justify-content-between align-items-center gap-3 mb-2">
            <div class="d-flex align-items-center gap-2">
              ${statusBadge(item.label)}
              <span class="small text-body-secondary">HTTP ${escapeHtml(item.label)}</span>
            </div>
            <div class="text-end">
              <div class="fw-semibold">${numberFormat(value)}</div>
              <div class="mini-rate">${rateFormat(share)}</div>
            </div>
          </div>
          <div class="progress rate-progress" role="progressbar" aria-label="${escapeHtml(t("aria.statusShare", { status: item.label }))}" aria-valuenow="${clampRate(share)}" aria-valuemin="0" aria-valuemax="100">
            <div class="progress-bar bg-danger" style="width: ${clampRate(share)}%"></div>
          </div>
        </div>
      `;
    })
    .join("");
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

function renderDimensionList(targetId, items, { mask = false } = {}) {
  const host = el(targetId);
  if (!Array.isArray(items) || items.length === 0) {
    host.innerHTML = emptyState(t("empty.noNon200Data"));
    return;
  }

  host.innerHTML = items
    .map((item) => {
      const displayLabel = mask ? maskApiKey(item.label) : item.label;
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

  const meta = [
    [t("detail.recordId"), `#${record.id}`],
    ["request_id", record.request_id],
    ["uuid", record.uuid || "—"],
    ["task_id", record.task_id || "—"],
    [t("fields.taskType"), record.task_type || "—"],
    [t("fields.errorCode"), record.error_code || "—"],
    [t("columns.duration"), durationFormat(record.duration_ms)],
    [t("detail.clientIp"), record.client_ip || "—"],
    ["API Key", maskApiKey(record.api_key)],
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
  el("refreshButton").disabled = loading;
  el("refreshButton").setAttribute("aria-busy", String(loading));
  el("refreshSpinner").classList.toggle("d-none", !loading);
  el("refreshIcon").classList.toggle("d-none", loading);
}

async function loadDashboard() {
  const token = ++state.dashboardRequestToken;
  let payload;
  try {
    payload = await fetchJson(`/api/dashboard?${queryString(buildDashboardParams())}`);
  } catch (error) {
    if (token !== state.dashboardRequestToken) return false;
    throw error;
  }
  if (token !== state.dashboardRequestToken) return false;

  renderMetricCards(payload.summary);
  renderReport(payload);
  renderHourlyVolumeChart(payload.error_timeline, payload.window);
  renderErrorShare(payload.summary);
  renderTimeline(payload.error_timeline, payload.window);
  renderStatusDistribution(payload.error_status_distribution, Number(payload.summary.error_requests) || 0);
  renderMethodDistribution(payload.error_method_distribution, Number(payload.summary.error_requests) || 0);
  renderTopErrorPaths(payload.top_error_paths);
  renderDimensionList("topErrorKeys", payload.top_error_api_keys, { mask: true });
  renderDimensionList("topErrorTasks", payload.top_error_task_types);
  renderLatestErrors(payload.latest_errors);
  el("windowBadge").textContent = timeWindowLabel(payload.window.hours);
  el("windowBadge").title = t("time.rangeTitle", {
    from: timeFormat(payload.window.from_ts),
    to: timeFormat(payload.window.to_ts),
  });
  return true;
}

async function loadRecords(append = false) {
  const token = ++state.recordRequestToken;
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
    const payload = await fetchJson(`/api/records?${queryString(buildRecordParams(append))}`);
    if (token !== state.recordRequestToken) return false;
    renderRecords(payload, append);
    return true;
  } catch (error) {
    if (token !== state.recordRequestToken) return false;
    throw error;
  } finally {
    if (token === state.recordRequestToken) {
      spinner.classList.add("d-none");
      loadMoreButton.disabled = !state.nextCursorTs;
      loadMoreButton.setAttribute("aria-busy", "false");
      searchButton.disabled = false;
      searchButton.setAttribute("aria-busy", "false");
    }
  }
}

async function refreshAll() {
  const token = ++state.refreshToken;
  hidePageError();
  setRefreshLoading(true);
  try {
    const results = await Promise.all([loadDashboard(), loadRecords(false)]);
    if (token === state.refreshToken && results.every(Boolean)) {
      el("lastUpdated").textContent = t("status.updatedAt", {
        time: new Date().toLocaleTimeString(i18n.locale, { hour12: false }),
      });
    }
  } catch (error) {
    if (token === state.refreshToken) showPageError(error);
  } finally {
    if (token === state.refreshToken) setRefreshLoading(false);
  }
}

async function loadDetailById(id) {
  if (!id) return;
  const token = ++state.detailRequestToken;
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
  refreshAll();
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
