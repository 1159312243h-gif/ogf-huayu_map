(function initializeDownloadCenter(root) {
  "use strict";

  const text = value => value == null ? "" : String(value);
  const safeName = value => text(value || "华域地图数据")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-").replace(/\s+/gu, " ").trim().slice(0, 100) || "华域地图数据";
  const csvCell = value => {
    // Treat source labels as text when opened in a spreadsheet. Actual numeric
    // values (including negative coordinates) remain numeric.
    const string = typeof value === "string" && /^[\s]*[=+@-]/u.test(value) ? `'${value}` : text(value);
    return /[",\r\n]/u.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
  };
  function snapshotKey(value) {
    const string = text(value); let hash = 2166136261;
    for (let index = 0; index < string.length; index++) hash = Math.imul(hash ^ string.charCodeAt(index), 16777619);
    return `${(hash >>> 0).toString(16)}-${string.length}`;
  }

  function tableArtifact({id, title, filename, columns, rows, source = "未提供", sourceTime = null, warning = ""}) {
    if (!Array.isArray(columns) || !columns.length || !Array.isArray(rows)) throw Error("表格导出数据不完整");
    const labels = columns.map(column => typeof column === "string" ? column : column.label);
    const keys = columns.map((column, index) => typeof column === "string" ? index : column.key ?? index);
    const exportedAt = new Date().toISOString();
    const values = rows.map(row => keys.map(key => Array.isArray(row) ? row[key] : row?.[key]));
    const key = snapshotKey(JSON.stringify([labels, values, source, sourceTime, warning]));
    const metadata = [source, sourceTime || "未提供", exportedAt, warning];
    const lines = [[...labels, "数据来源", "源数据时间", "导出时间", "导出说明"],
      ...values.map(row => [...row, ...metadata])]
      .map(row => row.map(csvCell).join(","));
    const blob = new Blob(["\uFEFF", lines.join("\r\n"), "\r\n"], {type: "text/csv;charset=utf-8"});
    return {id: `table:${id || safeName(title)}:${key}`, title: title || "数据表", name: `${safeName(filename || title)}.csv`,
      kind: "table", blob, source, sourceTime, exportedAt, warning};
  }

  function fileArtifact({id, title, filename, blob, kind = "image", source = "未提供", sourceTime = null, warning = ""}) {
    if (!(blob instanceof Blob)) throw Error("导出文件尚未生成");
    return {id: `${kind}:${id || safeName(filename || title)}`, title: title || "文件", name: safeName(filename || title),
      kind, blob, source, sourceTime, exportedAt: new Date().toISOString(), warning};
  }
  const imageArtifact = options => fileArtifact({...options, kind: "image"});

  function download(blob, filename) {
    const url = root.URL.createObjectURL(blob), anchor = root.document.createElement("a");
    anchor.href = url; anchor.download = filename; root.document.body.appendChild(anchor); anchor.click(); anchor.remove();
    root.setTimeout(() => root.URL.revokeObjectURL(url), 1500);
  }

  function add(artifact) {
    if (!artifact || !(artifact.blob instanceof Blob) || !artifact.id || !artifact.name) throw Error("下载文件无效");
    if (!root.dispatchEvent(new CustomEvent("huayu:download-artifact", {detail: artifact, cancelable: true}))) {
      throw Error("未加入清单：已达到数量或容量上限，请先下载或移除部分项目");
    }
    return artifact;
  }

  function textOf(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    clone.querySelectorAll("input, select, svg, i, [aria-hidden='true'], [data-export-ignore]").forEach(item => item.remove());
    return (clone.textContent || "").replace(/\s+/gu, " ").trim();
  }

  function tableSnapshot(table) {
    const headers = [...table.querySelectorAll("thead tr:last-child th, thead tr:last-child td")].map(textOf);
    const rows = [...table.querySelectorAll("tbody tr")].filter(row => !row.hidden && row.getAttribute("aria-hidden") !== "true"
      && (!root.getComputedStyle || root.getComputedStyle(row).display !== "none"))
      .map(row => [...row.querySelectorAll(":scope > th, :scope > td")].map(textOf));
    const columns = (headers.length ? headers : (rows[0] || []).map((_, index) => `列${index + 1}`));
    return {columns, rows: rows.map(row => columns.map((_, index) => row[index] || ""))};
  }

  function createActions(container, getArtifact, options = {}) {
    const actions = root.document.createElement("div"); actions.className = "data-export-actions";
    actions.setAttribute("role", "group"); actions.setAttribute("aria-label", options.label || "下载数据");
    const status = root.document.createElement("span"); status.className = "data-export-status"; status.setAttribute("role", "status");
    const run = async mode => {
      for (const button of actions.querySelectorAll("button")) button.disabled = true;
      try {
        const artifact = await getArtifact();
        if (mode === "queue") {add(artifact); status.textContent = "已加入下载清单，可前往“下载”统一保存";}
        else {download(artifact.blob, artifact.name); status.textContent = `已生成 ${artifact.name}`;}
      } catch (error) {status.textContent = error.message || "导出失败";}
      finally {for (const button of actions.querySelectorAll("button")) button.disabled = false;}
    };
    const direct = root.document.createElement("button"); direct.type = "button"; direct.className = "text-button";
    direct.textContent = options.downloadLabel || "下载 CSV"; direct.addEventListener("click", () => run("download"));
    const queue = root.document.createElement("button"); queue.type = "button"; queue.className = "text-button";
    queue.textContent = "加入下载清单"; queue.addEventListener("click", () => run("queue"));
    actions.append(direct, queue, status); container.append(actions);
    return actions;
  }

  const enhanced = new WeakSet();
  function enhanceTable(table) {
    if (enhanced.has(table) || table.closest("[data-export-ignore], [data-export-private], #download-queue")) return;
    enhanced.add(table);
    const container = root.document.createElement("div");
    container.className = "table-export-toolbar";
    table.parentNode.insertBefore(container, table);
    createActions(container, () => {
      if (table.closest("[data-export-ignore], [data-export-private]")) throw Error("此表格不提供公开导出");
      const title = textOf(table.querySelector("caption")) || table.getAttribute("aria-label") || "表格数据";
      const {columns, rows} = tableSnapshot(table);
      if (!columns.length || !rows.length) throw Error("当前表格没有可下载的数据行");
      return tableArtifact({id: table.id || title, title, filename: table.dataset.exportFilename || title, columns, rows,
        source: table.dataset.exportSource || "当前页面表格", sourceTime: table.dataset.sourceTime || null,
        warning: table.dataset.exportWarning || "仅导出当前表格实际显示的行"});
    }, {label: "下载当前表格"});
  }

  function scanTables(scope = root.document) {
    if (scope.matches?.("table")) enhanceTable(scope);
    scope.querySelectorAll?.("table").forEach(enhanceTable);
  }

  if (root.document?.documentElement && root.MutationObserver) {
    // Inspect newly inserted subtrees only; map animations must not rescan the
    // whole document or serialize any table data.
    const observer = new root.MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) scanTables(node);
    });
    observer.observe(root.document.documentElement, {childList: true, subtree: true});
    root.document.addEventListener("DOMContentLoaded", () => scanTables(), {once: true});
    scanTables();
  }

  root.HuayuDownloadCenter = Object.freeze({tableArtifact, fileArtifact, imageArtifact, snapshotKey, createActions, add, download, tableSnapshot, scanTables});
})(typeof window !== "undefined" ? window : globalThis);
