/* Scientific figures from the existing dashboard aggregates. No inferred observations. */
(function (global) {
  "use strict";
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  function count(value) {
    if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }
  function rows(items, limit) {
    return (Array.isArray(items) ? items : []).map((item, index) => ({
      label: String(item?.label ?? "—"), total: count(item?.total_requests), errors: count(item?.error_requests), index,
    })).sort((a, b) => (b.errors ?? -1) - (a.errors ?? -1) || a.index - b.index).slice(0, limit)
      .map((row, index) => ({ ...row, number: index + 1,
        rate: row.total > 0 && row.errors !== null && row.errors <= row.total ? row.errors / row.total * 100 : null }));
  }
  function axis(maximum, intervals = 4) {
    if (!(maximum > 0)) return { max: 1, ticks: [0, 1] };
    const raw = maximum / intervals;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const normalized = raw / magnitude;
    const step = Math.max(1, (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude);
    const max = Math.ceil(maximum / step) * step;
    return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, index) => index * step) };
  }
  const line = (className, x1, y1, x2, y2) => `<line class="${className}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${className === "scientific-axis" ? "#334155" : "#dce2e8"}" stroke-width="1"/>`;
  const text = (className, x, y, value, anchor = "middle", extra = "") => `<text class="${className}" x="${x}" y="${y}" text-anchor="${anchor}" fill="#334155" font-size="11" ${extra}>${escape(value)}</text>`;
  const width = (host) => Math.max(300, Math.min(600, host.clientWidth || 600));
  const axisCount = (value, format) => value >= 10_000 ? value.toExponential(1).replace(".0e", "e") : format(value);
  function table(headings, values) {
    return `<div class="scientific-table-wrap"><table class="scientific-table"><thead><tr>${headings.map((heading) => `<th scope="col">${escape(heading)}</th>`).join("")}</tr></thead><tbody>${values.map((row) => `<tr>${row.map((value, index) => index === 0 ? `<th scope="row">${escape(value)}</th>` : `<td>${escape(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  function svg(id, w, h, label, caption, content) {
    return `<svg class="scientific-svg" width="${w}" height="${h}" style="width:${w}px;max-width:100%;height:auto" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="${id}Title ${id}Description"><title id="${id}Title">${escape(label)}</title><desc id="${id}Description">${escape(caption)}</desc>${content}</svg>`;
  }
  function empty(host, payload, translate) {
    const key = count(payload.summary?.error_requests) === 0 && count(payload.summary?.total_requests) > 0 ? "figures.noFailures" : "figures.empty";
    host.innerHTML = `<p class="scientific-empty">${escape(translate(key))}</p>`;
  }
  function figure(markup, caption, lookup) {
    return `<figure class="scientific-figure">${markup}<figcaption class="scientific-caption">${escape(caption)}</figcaption></figure>${lookup}`;
  }

  function scatter(host, payload, t, format, percent) {
    const data = rows(payload.top_error_paths, 10);
    if (!data.length) return empty(host, payload, t);
    const valid = data.filter((row) => row.rate !== null);
    const w = width(host), h = 320, left = 64, right = w - 22, top = 26, bottom = 260;
    const xAxis = axis(Math.max(0, ...valid.map((row) => row.total)), w < 420 ? 2 : 4);
    const x = (value) => left + value / xAxis.max * (right - left);
    const y = (value) => bottom - value / 100 * (bottom - top);
    let caption = t("figures.scatterCaption", { shown: data.length });
    if (valid.length !== data.length) caption += " " + t("figures.invalidRates", { count: data.length - valid.length });
    const plot = [];
    for (const value of [0, 25, 50, 75, 100]) {
      plot.push(line(value === 0 ? "scientific-axis" : "scientific-grid", left, y(value), right, y(value)));
      plot.push(text("scientific-tick", left - 9, y(value) + 4, value, "end", `data-tick="y" data-value="${value}"`));
    }
    for (const value of xAxis.ticks) {
      plot.push(line(value === 0 ? "scientific-axis" : "scientific-grid", x(value), top, x(value), bottom));
      plot.push(text("scientific-tick", x(value), bottom + 20, axisCount(value, format), value === 0 ? "start" : value === xAxis.max ? "end" : "middle", `data-tick="x" data-value="${value}"`));
    }
    plot.push(text("scientific-label", (left + right) / 2, h - 8, t("figures.totalRequests")));
    plot.push(text("scientific-label", 16, (top + bottom) / 2, t("figures.failureRate"), "middle", `transform="rotate(-90 16 ${(top + bottom) / 2})"`));
    const occupied = [];
    const locations = new Map();
    for (const row of valid) {
      const key = `${row.total}:${row.rate}`;
      if (!locations.has(key)) locations.set(key, []);
      locations.get(key).push(row);
    }
    for (const coincident of locations.values()) {
      const row = coincident[0];
      const identifiers = coincident.map((item) => item.number).join(",");
      const labelWidth = identifiers.length * 7 + 4;
      const px = x(row.total), py = y(row.rate);
      // Only labels move to avoid overlap; data coordinates are never jittered.
      const candidates = [[8, -8], [8, 18], [-18, -8], [-18, 18], [20, -22], [-30, 30], [8, -36], [8, 42]];
      const positions = candidates.map(([dx, dy]) => ({ x: Math.max(left + 2, Math.min(right - labelWidth, px + dx)), y: Math.max(top + 12, Math.min(bottom - 2, py + dy)), width: labelWidth }));
      const label = positions.find((point) => !occupied.some((box) => point.x < box.x + box.width + 3 && point.x + point.width + 3 > box.x && Math.abs(box.y - point.y) < 15)) || positions[0];
      occupied.push(label);
      const title = `${coincident.map((item) => `${item.number}. ${item.label}`).join("; ")} · ${t("figures.totalRequests")}: ${format(row.total)} · ${t("figures.failureRate")}: ${percent(row.rate)}`;
      plot.push(`<circle class="scientific-point" data-point="${identifiers}" data-x="${row.total}" data-y="${row.rate}" cx="${px}" cy="${py}" r="4" fill="#fff" stroke="#005ea2" stroke-width="1.5"><title>${escape(title)}</title></circle>`);
      if (Math.abs(label.y - py) > 22 || Math.abs(label.x - px) > 22) plot.push(line("scientific-grid", px, py, label.x + 5, label.y - 4));
      plot.push(`<rect x="${label.x - 1}" y="${label.y - 11}" width="${labelWidth}" height="14" fill="#fff"/>`);
      plot.push(text("scientific-point-label", label.x, label.y, identifiers, "start"));
    }
    host.innerHTML = figure(svg("endpointScatter", w, h, t("figures.scatterAria"), caption, plot.join("")), caption,
      table([t("figures.number"), t("figures.endpoint"), t("figures.totalRequests"), t("figures.failures"), t("figures.failureRate")],
        data.map((row) => [row.number, row.label, format(row.total), format(row.errors), percent(row.rate)])));
  }

  function pareto(host, payload, t, format, percent) {
    const data = rows(payload.top_error_paths, 8);
    if (!data.length) return empty(host, payload, t);
    const total = count(payload.summary?.error_requests);
    const known = data.every((row) => row.errors !== null);
    const sum = data.reduce((result, row) => result + (row.errors ?? 0), 0);
    const validDenominator = known && total > 0 && sum <= total;
    let running = 0;
    data.forEach((row) => { running += row.errors ?? 0; row.cumulative = validDenominator ? running / total * 100 : null; });
    let caption = validDenominator
      ? t("figures.paretoCaption", { shown: data.length, count: format(sum), total: format(total), share: percent(sum / total * 100) })
      : !known ? t("figures.invalidCounts")
        : total !== null && sum > total
          ? t("figures.inconsistentTotal", { count: format(sum), total: format(total) })
          : total === 0 ? t("figures.noFailures") : t("figures.missingTotal");
    const w = width(host), h = 330, right = w - 60, top = 30, bottom = 268;
    const countAxis = axis(Math.max(0, ...data.map((row) => row.errors ?? 0)), w < 420 ? 2 : 4);
    const left = Math.max(60, ...countAxis.ticks.map((value) => axisCount(value, format).length * 6 + 32));
    const countY = (value) => bottom - value / countAxis.max * (bottom - top);
    const shareY = (value) => bottom - value / 100 * (bottom - top);
    const pitch = (right - left) / data.length;
    const barWidth = pitch * 0.65;
    const cx = (index) => left + (index + 0.5) * pitch;
    const plot = [];
    for (const value of countAxis.ticks) {
      plot.push(line(value === 0 ? "scientific-axis" : "scientific-grid", left, countY(value), right, countY(value)));
      plot.push(text("scientific-tick", left - 8, countY(value) + 4, axisCount(value, format), "end", `data-tick="count" data-value="${value}"`));
    }
    plot.push(line("scientific-axis", left, top, left, bottom));
    if (validDenominator) {
      plot.push(line("scientific-axis", right, top, right, bottom));
      for (const value of [0, 25, 50, 75, 100]) plot.push(text("scientific-tick", right + 8, shareY(value) + 4, `${value}%`, "start", `data-tick="share" data-value="${value}"`));
    }
    data.forEach((row, index) => {
      if (row.errors !== null) plot.push(`<rect class="scientific-bar${index ? " scientific-muted-bar" : ""}" data-bar="${row.number}" data-count="${row.errors}" x="${cx(index) - barWidth / 2}" y="${countY(row.errors)}" width="${barWidth}" height="${bottom - countY(row.errors)}" fill="${index ? "#dce2e8" : "#005ea2"}" stroke="#475569" stroke-width="1"><title>${escape(`${row.number}. ${row.label} · ${format(row.errors)}`)}</title></rect>`);
      plot.push(text("scientific-tick", cx(index), bottom + 20, row.number));
    });
    if (validDenominator) {
      const path = data.map((row, index) => `${index ? "L" : "M"}${cx(index)},${shareY(row.cumulative)}`).join(" ");
      plot.push(`<path class="scientific-cumulative" d="${path}" fill="none" stroke="#005ea2" stroke-width="2"/>`);
      data.forEach((row, index) => plot.push(`<circle class="scientific-cumulative-point" data-cumulative="${row.cumulative}" cx="${cx(index)}" cy="${shareY(row.cumulative)}" r="3" fill="#fff" stroke="#005ea2" stroke-width="1.5"><title>${escape(`${row.number}. ${t("figures.cumulative")}: ${percent(row.cumulative)}`)}</title></circle>`));
    }
    plot.push(text("scientific-label", 14, (top + bottom) / 2, t("figures.failures"), "middle", `transform="rotate(-90 14 ${(top + bottom) / 2})"`));
    if (validDenominator) plot.push(text("scientific-label", w - 10, (top + bottom) / 2, t("figures.cumulative"), "middle", `transform="rotate(90 ${w - 10} ${(top + bottom) / 2})"`));
    plot.push(text("scientific-label", (left + right) / 2, h - 10, `${t("figures.endpoint")} · ${t("figures.number")}`));
    host.innerHTML = figure(svg("failurePareto", w, h, t("figures.paretoAria"), caption, plot.join("")), caption,
      table([t("figures.number"), t("figures.endpoint"), t("figures.failures"), t("figures.share"), t("figures.cumulative")],
        data.map((row) => [row.number, row.label, format(row.errors), percent(validDenominator ? row.errors / total * 100 : null), percent(row.cumulative)])));
  }

  function methods(host, payload, t, format, percent) {
    const data = rows(payload.error_method_distribution, 8);
    if (!data.length) return empty(host, payload, t);
    const w = width(host), left = w < 420 ? 55 : 85, right = w - 22, top = 24, pitch = 54;
    const bottom = top + data.length * pitch, h = bottom + 64;
    const x = (value) => left + value / 100 * (right - left);
    let caption = t("figures.methodCaption");
    const invalid = data.filter((row) => row.rate === null).length;
    if (invalid) caption += " " + t("figures.invalidRates", { count: invalid });
    const plot = [];
    for (const value of [0, 25, 50, 75, 100]) {
      plot.push(line(value === 0 ? "scientific-axis" : "scientific-grid", x(value), top, x(value), bottom));
      plot.push(text("scientific-tick", x(value), bottom + 20, `${value}%`, "middle", `data-tick="composition" data-value="${value}"`));
    }
    plot.push(line("scientific-axis", left, bottom, right, bottom));
    data.forEach((row, index) => {
      const y = top + index * pitch + 12;
      const label = row.label.length > 8 ? row.label.slice(0, 7) + "…" : row.label;
      plot.push(text("scientific-method-label", left - 8, y + 17, label, "end"));
      if (row.rate === null) {
        plot.push(text("scientific-tick", left + 8, y + 17, "—", "start"));
        return;
      }
      const success = row.total - row.errors;
      const successWidth = success / row.total * (right - left);
      const errorWidth = row.errors / row.total * (right - left);
      plot.push(`<rect class="scientific-muted-bar" data-method="${escape(row.label)}" data-success="${success}" x="${left}" y="${y}" width="${successWidth}" height="24" fill="#dce2e8" stroke="#475569" stroke-width="1"><title>${escape(`${row.label} · ${t("figures.success")}: ${format(success)} / ${format(row.total)}`)}</title></rect>`);
      plot.push(`<rect class="scientific-bar" data-method="${escape(row.label)}" data-failures="${row.errors}" x="${left + successWidth}" y="${y}" width="${errorWidth}" height="24" fill="#005ea2" stroke="#334155" stroke-width="1"><title>${escape(`${row.label} · ${t("figures.failures")}: ${format(row.errors)} / ${format(row.total)} (${percent(row.rate)})`)}</title></rect>`);
      if (successWidth > 44) plot.push(text("scientific-tick", left + successWidth / 2, y + 17, percent(100 - row.rate)));
      if (errorWidth > 44) plot.push(`<text class="scientific-inverse-label" x="${left + successWidth + errorWidth / 2}" y="${y + 17}" text-anchor="middle" font-size="11" fill="#fff">${escape(percent(row.rate))}</text>`);
    });
    const legend = `<div class="scientific-legend"><span><i class="scientific-legend-success" aria-hidden="true"></i>${escape(t("figures.success"))}</span><span><i class="scientific-legend-failure" aria-hidden="true"></i>${escape(t("figures.failures"))}</span></div>`;
    host.innerHTML = figure(svg("methodComposition", w, h, t("figures.methodAria"), caption, plot.join("")) + legend, caption,
      table([t("figures.method"), t("figures.totalRequests"), t("figures.success"), t("figures.failures"), t("figures.failureRate")],
        data.map((row) => [row.label, format(row.total), format(row.rate === null ? null : row.total - row.errors), format(row.errors), percent(row.rate)])));
  }

  function render(payload = {}, options = {}) {
    const t = typeof options.t === "function" ? options.t : (key) => key;
    const formatter = new Intl.NumberFormat(options.locale || "en", { maximumFractionDigits: 0 });
    const rateFormatter = new Intl.NumberFormat(options.locale || "en", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const format = (value) => value === null ? "—" : formatter.format(value);
    const percent = (value) => value === null ? "—" : rateFormatter.format(value) + "%";
    for (const [id, painter] of [["endpointScatter", scatter], ["failurePareto", pareto], ["methodComposition", methods]]) {
      const host = document.getElementById(id);
      if (host) painter(host, payload || {}, t, format, percent);
    }
  }
  global.LogArkFigures = Object.freeze({ render });
})(window);
