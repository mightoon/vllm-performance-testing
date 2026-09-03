/* ============ 图形测试（图片理解 + 文章生成） ============
   与 app.js 的文本测试同构，复用其全局工具函数（fetchJSON/escapeHtml/
   renderMarkdown/renderVllmBarInto/renderMonitorChartsInto 等）。
   差异点：
   - 参数区第 1 位为"测试图片"（目录选择弹窗，浏览应用所在机器磁盘）
   - thread 行实时显示正在处理的图片文件名
   - 输入 token 为服务端实测（usage 优先，metrics 差分估算兜底），
     历史小字与运行汇总展示平均值 */

/* ============ 模型下拉与探测（图形测试参数区） ============ */
let imgModelProbe = null;   // 当前选中模型的探测结果
let imgProbeSeq = 0;

async function loadImgModelSelect() {
  const models = await fetchJSON("/api/models");
  const sel = $("imgModelSelect");
  const prev = sel.value;
  sel.innerHTML =
    '<option value="" disabled selected>选择模型配置</option>' +
    (models || [])
      .map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`)
      .join("");
  if (prev && (models || []).some((m) => m.id === prev)) sel.value = prev;
}

async function probeImgSelectedModel() {
  const modelId = $("imgModelSelect").value;
  const info = $("imgModelInfo");
  imgModelProbe = null;
  if (!modelId) { info.style.display = "none"; return; }
  const seq = ++imgProbeSeq;
  info.style.display = "flex";
  info.innerHTML = '<span>服务端参数探测中…</span>';
  const r = await fetchJSON(`/api/models/${modelId}/probe`);
  if (seq !== imgProbeSeq) return;   // 已切换模型，丢弃过期响应
  if (r && r.success) {
    imgModelProbe = r;
    const items = [
      `vLLM 版本: <b>${r.version ? escapeHtml(r.version) : "—"}</b>`,
      `最大上下文: <b>${r.max_model_len ? fmtTokens(r.max_model_len) + " token" : "—"}</b>`,
      `KV cache 容量: <b>${r.kv_cache_tokens ? fmtTokens(r.kv_cache_tokens) + " token" : "—"}</b>`,
    ];
    info.innerHTML = items.map((s) => `<span>${s}</span>`)
      .join('<span class="info-sep">│</span>');
  } else {
    const reason = r && r.error === "配置不存在" ? "模型配置已删除" : "非 vLLM 服务或探测失败";
    info.innerHTML = `<span>服务端参数不可用（${reason}）</span>`;
  }
}

$("imgModelSelect").addEventListener("change", probeImgSelectedModel);

/* ============ 图片目录选择弹窗 ============ */
let imgDirModal = null;          // 弹窗元素
let imgDirCurrent = null;        // 当前浏览目录（null = 盘符列表）
let imgDirParent = null;         // 当前目录的上级（null = 无上级/盘符列表）
let imgDirImages = 0;            // 当前目录图片数
let imgSelectedDir = null;       // 已确认选择的目录路径
let imgSelectedCount = 0;        // 已选目录的图片数（label 显示用；与"当前浏览目录"的 imgDirImages 区分）
let imgDefaultDir = null;        // 默认目录（程序运行位置的 image/）完整路径

/* 目录显示文本：默认目录显示相对名（如 image），其余目录显示完整路径 */
function imgDirDisplayText(path, count) {
  const disp = imgDefaultDir && path === imgDefaultDir
    ? path.split(/[\\/]+/).filter(Boolean).pop() : path;
  return disp + (count > 0 ? `（${count} 张）` : "");
}

/* 恢复目录 label 为待运行参数（imgSelectedDir）的显示。
   报告模式会把 label 回显为历史任务的目录，回到运行模式时必须恢复。 */
function restoreImgDirLabel() {
  const label = $("imageDirLabel");
  if (imgSelectedDir) {
    label.textContent = imgDirDisplayText(imgSelectedDir, imgSelectedCount);
    label.title = imgSelectedDir;
    label.classList.add("has-dir");
  } else {
    label.textContent = "未选择目录";
    label.title = "";
    label.classList.remove("has-dir");
  }
}

function openImgDirModal() {
  imgDirModal.style.display = "flex";
  // 已选择过目录：从该目录开始浏览；否则从根（盘符列表）开始
  if (imgSelectedDir) {
    loadImgDirList(imgSelectedDir);
  } else {
    loadImgDirRoot();
  }
}

function closeImgDirModal() {
  imgDirModal.style.display = "none";
}

async function loadImgDirRoot() {
  imgDirCurrent = null;
  imgDirParent = null;
  $("imgDirPath").textContent = "请选择磁盘";
  $("imgDirPath").title = "";
  $("btnImgDirUp").disabled = true;
  $("imgDirImagesInfo").textContent = "";
  $("btnImgDirConfirm").disabled = true;
  const list = $("imgDirList");
  list.innerHTML = '<div class="dir-empty">加载中…</div>';
  const r = await fetchJSON("/api/fs/root");
  if (!r || !r.success) {
    list.innerHTML = `<div class="dir-empty">加载失败：${escapeHtml((r && r.error) || "未知错误")}</div>`;
    return;
  }
  list.innerHTML = (r.roots || []).map((root) =>
    `<div class="dir-item" data-path="${escapeHtml(root)}">` +
    `<span class="dir-item-icon">💽</span>` +
    `<span class="dir-item-name">${escapeHtml(root)}</span></div>`).join("");
}

async function loadImgDirList(path) {
  $("imgDirPath").textContent = "加载中…";
  $("imgDirPath").title = "";
  const list = $("imgDirList");
  list.innerHTML = '<div class="dir-empty">加载中…</div>';
  const r = await fetchJSON(`/api/fs/list?path=${encodeURIComponent(path)}`);
  if (!r || !r.success) {
    list.innerHTML = `<div class="dir-empty">加载失败：${escapeHtml((r && r.error) || "未知错误")}</div>`;
    return;
  }
  imgDirCurrent = r.path;
  imgDirParent = r.parent;
  imgDirImages = r.images;
  $("imgDirPath").textContent = r.path;
  $("imgDirPath").title = r.path;
  $("btnImgDirUp").disabled = false;
  $("imgDirImagesInfo").innerHTML = r.images > 0
    ? `当前目录含 <b>${r.images}</b> 张图片（jpg/png/webp/gif/bmp）`
    : '<span class="dir-warn">当前目录没有图片文件</span>';
  // 当前目录可作为选择目标（即使 0 张图，也允许选，后端启动时会校验）
  $("btnImgDirConfirm").disabled = false;
  if (!(r.dirs || []).length) {
    list.innerHTML = '<div class="dir-empty">无子目录</div>';
    return;
  }
  list.innerHTML = r.dirs.map((d) => {
    const cnt = d.images < 0 ? "？" : d.images;
    return `<div class="dir-item" data-path="${escapeHtml(d.path)}" title="${escapeHtml(d.path)}">` +
      `<span class="dir-item-icon">📁</span>` +
      `<span class="dir-item-name">${escapeHtml(d.name)}</span>` +
      `<span class="dir-item-count">${cnt} 图</span></div>`;
  }).join("");
}

/* 目录列表点击：进入子目录；上级按钮：返回上级（盘根时回盘符列表） */
$("imgDirList").addEventListener("click", (e) => {
  const item = e.target.closest(".dir-item");
  if (item && item.dataset.path) loadImgDirList(item.dataset.path);
});

$("btnImgDirUp").addEventListener("click", () => {
  if (imgDirParent) loadImgDirList(imgDirParent);
  else loadImgDirRoot();
});

/* 确认选择：记录目录并更新参数区显示（含图片计数预览） */
$("btnImgDirConfirm").addEventListener("click", () => {
  if (!imgDirCurrent) return;
  imgSelectedDir = imgDirCurrent;
  imgSelectedCount = imgDirImages;
  const label = $("imageDirLabel");
  label.textContent = imgDirDisplayText(imgDirCurrent, imgDirImages);
  label.title = imgDirCurrent;
  label.classList.add("has-dir");
  closeImgDirModal();
});

/* ============ 历史侧栏与模式管理（图形测试） ============ */
let imgMode = "run";            // "run" | "report"
let imgActiveTask = null;       // 报告模式正在查看的任务名
let imgDraftTask = null;        // "新测试"草稿任务名
let imgCurrentTask = null;      // 运行模式当前（或最近）任务名
let imgStatusViewTask = null;   // 状态视图：历史任务终态
let imgStatusViewResult = null; // 状态视图缓存的 result.json
let lastImgHistoryTasks = [];
let lastImgTestStatus = null;

function genImgTaskName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `图形测试-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}`;
}

function currentImgSelectedTask() {
  if (imgMode === "report") return imgActiveTask;
  return imgCurrentTask || imgDraftTask;
}

async function loadImgHistory() {
  const r = await fetchJSON("/api/tests/image/history");
  lastImgHistoryTasks = (r && r.tasks) || [];
  renderImgHistoryList();
}

/* 历史条目小字为两行：
   第一行：状态徽章 + 并发数；第二行：输入：平均 M token，输出：K token
   （M 为服务端实测平均值，无数据时显示 —） */
function imgHistoryItemHtml(t, selected, isDraft) {
  const p = t.params || {};
  const st = isDraft ? "draft"
    : t.has_result ? (t.status || "completed")
    : t.status === "running" ? "running" : "interrupted";
  const stText = HISTORY_STATUS_TEXT[st] || st;
  let line1, line2;
  if (isDraft) {
    line1 = "";
    line2 = "待填写参数";
  } else {
    const pt = t.input_tokens_avg;
    line1 = p.concurrency != null ? `${p.concurrency}并发` : "";
    line2 = `输入：平均 ${pt != null ? pt.toLocaleString() : "—"} token，` +
      `输出：${p.article_length != null ? p.article_length : "—"} token`;
  }
  return `<div class="history-item ${t.name === selected ? "active" : ""}" data-name="${escapeHtml(t.name)}">` +
    (isDraft ? "" : `<button class="history-item-del" title="删除该测试">✕</button>`) +
    `<div class="history-item-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div>` +
    `<div class="history-item-meta two-line">` +
    `<div class="history-item-line">` +
    `<span class="history-item-status ${st}">${stText}</span>` +
    (line1 ? `<span class="history-item-sub">${escapeHtml(line1)}</span>` : "") +
    `</div>` +
    `<div class="history-item-sub">${escapeHtml(line2)}</div></div></div>`;
}

function renderImgHistoryList() {
  const list = $("imgHistoryList");
  const selected = currentImgSelectedTask();
  let html = "";
  if (imgDraftTask) {
    html += imgHistoryItemHtml({ name: imgDraftTask, params: {} }, selected, true);
  }
  html += lastImgHistoryTasks.map((t) => imgHistoryItemHtml(t, selected, false)).join("");
  list.innerHTML = html || '<div class="history-empty">暂无历史测试</div>';
}

function setImgPanelTitles(mode) {
  $("imgRunPanelTitle").textContent = mode === "report" ? "测试报告" : "测试状态";
}

/* 进入运行模式：恢复 thread 列表与轮询 */
function enterImgRunMode() {
  imgMode = "run";
  imgActiveTask = null;
  imgStatusViewTask = null;
  imgStatusViewResult = null;
  restoreImgDirLabel();
  setImgPanelTitles("run");
  $("btnImgGenReport").style.display = "none";
  $("btnImgBackStatus").style.display = "none";
  hideImgMonitor();
  hideImgAnalysis();
  $("imgProgressList").style.display = "";
  restartImgPolling();
  renderImgHistoryList();
}

/* ============ 报告模式监控图表与 AI 分析（图形测试） ============ */
let imgMonitorChartInstances = [];

function disposeImgMonitorCharts() {
  imgMonitorChartInstances.forEach((c) => c.dispose());
  imgMonitorChartInstances = [];
}

function hideImgMonitor() {
  disposeImgMonitorCharts();
  $("imgMonitorArea").style.display = "none";
}

let imgReportGpuStats = null;
let imgLastVllmBarRender = 0;

async function loadImgMonitorCharts(taskName, config, result) {
  disposeImgMonitorCharts();
  imgReportGpuStats = null;
  const area = $("imgMonitorArea");
  area.style.display = "block";
  $("imgMonitorCards").innerHTML = "";
  $("imgMonitorCharts").innerHTML = "";
  $("imgMonitorEmpty").style.display = "none";
  $("imgMonitorSource").textContent = "";
  updateGrafanaLinkInto($("imgGrafanaLink"), config, result);

  const r = await fetchJSON(`/api/tests/image/history/${encodeURIComponent(taskName)}/metrics`);
  if (!r || !r.success || !r.metrics || !(r.metrics.series || []).length) {
    $("imgMonitorEmpty").style.display = "block";
    return;
  }
  $("imgMonitorSource").textContent = r.source === "live" ? "（实时查询）" : "";
  const st = r.metrics.stats || {};
  if (st.gpu_fb_usage_avg != null || st.gpu_mem_copy_util_avg != null) {
    imgReportGpuStats = {
      gpu_fb_usage_avg: st.gpu_fb_usage_avg ?? null,
      gpu_mem_copy_util_avg: st.gpu_mem_copy_util_avg ?? null,
    };
    if (result && result.vllm_metrics_summary) {
      renderVllmBarInto($("imgVllmBar"), $("imgVllmBarItems"),
        $("imgVllmBarTitle"), result.vllm_metrics_summary, "report", imgReportGpuStats);
    }
  }
  renderMonitorChartsInto($("imgMonitorCards"), $("imgMonitorCharts"),
    r.metrics, (result || {}).vllm_metrics_summary, imgMonitorChartInstances);
}

window.addEventListener("resize", () => {
  imgMonitorChartInstances.forEach((c) => c.resize());
});

let imgAnalysisPollTimer = null;

function stopImgAnalysisPoll() {
  if (imgAnalysisPollTimer) { clearTimeout(imgAnalysisPollTimer); imgAnalysisPollTimer = null; }
}

function hideImgAnalysis() {
  $("imgAnalysisArea").style.display = "none";
  stopImgAnalysisPoll();
}

async function loadImgAnalysis(taskName) {
  stopImgAnalysisPoll();
  $("imgAnalysisArea").style.display = "block";
  $("imgAnalysisBody").innerHTML = '<div class="analysis-empty">分析加载中…</div>';
  $("imgAnalysisMeta").textContent = "";
  const r = await fetchJSON(`/api/tests/image/history/${encodeURIComponent(taskName)}/analysis`);
  if (r && r.analysis) {
    renderAnalysisInto($("imgAnalysisBody"), $("imgAnalysisMeta"), r.analysis);
  } else if (r && r.pending) {
    $("imgAnalysisBody").innerHTML = '<div class="analysis-empty">分析正在生成中。。。</div>';
    pollImgAnalysis(taskName);
  } else {
    $("imgAnalysisBody").innerHTML =
      '<div class="analysis-empty">暂无分析（旧任务无自动分析记录）</div>';
  }
}

function pollImgAnalysis(taskName) {
  imgAnalysisPollTimer = setTimeout(async () => {
    imgAnalysisPollTimer = null;
    const r = await fetchJSON(`/api/tests/image/history/${encodeURIComponent(taskName)}/analysis`);
    if (r && r.analysis) {
      renderAnalysisInto($("imgAnalysisBody"), $("imgAnalysisMeta"), r.analysis);
      return;
    }
    if (r && r.pending) { pollImgAnalysis(taskName); return; }
    $("imgAnalysisBody").innerHTML =
      '<div class="analysis-empty">暂无分析（旧任务无自动分析记录）</div>';
  }, 15000);
}

/* ============ 报告模式 / 状态视图（图形测试） ============ */

async function enterImgReportMode(taskName) {
  imgMode = "report";
  imgActiveTask = taskName;
  imgDraftTask = null;
  imgStatusViewTask = null;
  imgStatusViewResult = null;
  setImgPanelTitles("report");
  $("btnImgGenReport").style.display = "none";
  $("btnImgBackStatus").style.display = "";
  closeImgCaseModal();
  const r = await fetchJSON(`/api/tests/image/history/${encodeURIComponent(taskName)}`);
  if (!r || !r.success) return alert((r && r.error) || "加载历史任务失败");
  renderImgReport(r.config || {}, r.result || {});
  loadImgMonitorCharts(taskName, r.config || {}, r.result || {});
  loadImgAnalysis(taskName);
  renderImgHistoryList();
}

/* 从报告页返回该任务结束时的状态页（持久化 result 重建终态视图） */
async function enterImgStatusView(taskName) {
  imgMode = "run";
  imgActiveTask = null;
  imgDraftTask = null;
  imgCurrentTask = taskName;
  imgStatusViewTask = taskName;
  imgStatusViewResult = null;
  restoreImgDirLabel();
  setImgPanelTitles("run");
  $("btnImgBackStatus").style.display = "none";
  closeImgCaseModal();
  hideImgMonitor();
  hideImgAnalysis();
  $("imgProgressList").style.display = "";
  const r = await fetchJSON(`/api/tests/image/history/${encodeURIComponent(taskName)}`);
  if (!r || !r.success) return alert((r && r.error) || "加载历史任务失败");
  imgStatusViewResult = r.result || {};
  imgLastVllmBarRender = 0;
  renderImgStatus(imgStatusViewResult);
  renderImgHistoryList();
}

/* 报告渲染：参数区填充当时 profile；Profile 条含图片目录/数量；
   指标区含实测平均输入 token */
function renderImgReport(config, result) {
  const p = config.params || {};
  const sel = $("imgModelSelect");
  if (p.model_id && ![...sel.options].some((o) => o.value === p.model_id)) {
    const opt = document.createElement("option");
    opt.value = p.model_id;
    opt.textContent = (config.model && config.model.name) || p.model_name || p.model_id;
    sel.appendChild(opt);
  }
  sel.value = p.model_id || "";
  // 图片目录回显（仅显示，不设为当前选择——报告模式不改变待运行参数语义）
  $("imageDirLabel").textContent = p.image_dir || "未选择目录";
  $("imageDirLabel").title = p.image_dir || "";
  $("imageCount").value = p.image_count ?? "";
  $("imgArticleLength").value = p.article_length ?? "";
  $("imgConcurrency").value = p.concurrency ?? "";
  probeImgSelectedModel();

  const pr = config.model_probe || {};
  const sum = result.summary || {};
  const ptAvg = sum.prompt_tokens_avg;
  const profileRows = [
    ["模型", escapeHtml((config.model && config.model.name) || p.model_name || p.model_id || "—")],
    ["vLLM 版本", pr.version ? escapeHtml(pr.version) : "—"],
    ["最大上下文", pr.max_model_len ? fmtTokens(pr.max_model_len) + " token" : "—"],
    ["KV cache 容量", pr.kv_cache_tokens ? fmtTokens(pr.kv_cache_tokens) + " token" : "—"],
    ["图片目录", p.image_dir ? escapeHtml(p.image_dir) : "—"],
    ["目录图片数", p.image_pool_size != null
      ? `${p.image_pool_size} 张${(p.image_count * p.concurrency) > p.image_pool_size ? "（循环复用）" : ""}` : "—"],
    ["迭代次数（每Thread）", p.image_count ?? "—"],
    ["输出长度", p.article_length != null ? `${p.article_length} token` : "—"],
    ["并发度", p.concurrency ?? "—"],
    ["平均输入 token", ptAvg != null
      ? `${ptAvg.toLocaleString()} token${sum.prompt_tokens_source === "usage" ? "（实测）" : "（估算）"}` : "—"],
  ];
  $("imgProfileBarItems").innerHTML = profileRows.map(([k, v]) =>
    `<div class="detail-item"><span class="detail-k">${k}</span>` +
    `<span class="detail-v">${v}</span></div>`).join("");
  $("imgProfileBar").style.display = "block";

  $("imgRunEmpty").style.display = "none";
  $("imgRunSummary").style.display = "flex";
  $("imgSumStatus").innerHTML = `状态: <b>${STATUS_TEXT[result.status] || result.status || "未完成"}</b>`;
  $("imgSumElapsed").innerHTML = `用时: <b>${fmtElapsed(result.elapsed || 0)}</b>`;
  $("imgSumCalls").innerHTML = `总调用: <b>${sum.total_calls ?? "—"}</b>`;
  $("imgSumErrors").innerHTML = `错误: <b style="color:${sum.total_errors ? "var(--danger)" : "inherit"}">${sum.total_errors ?? "—"}</b>`;
  $("imgSumChars").innerHTML = `生成字数: <b>${(sum.total_chars ?? 0).toLocaleString()}</b>`;
  $("imgSumTokens").innerHTML = `平均输入: <b>${ptAvg != null ? ptAvg.toLocaleString() + " token" : "—"}</b>`;
  imgLastVllmBarRender = 0;
  renderVllmBarInto($("imgVllmBar"), $("imgVllmBarItems"), $("imgVllmBarTitle"),
    result.vllm_metrics_summary || result.vllm_metrics,
    result.vllm_metrics_summary ? "report" : "legacy", imgReportGpuStats);

  $("imgProgressList").style.display = "none";
  setImgRunningUI(false);
}

/* 删除历史图形测试 */
async function deleteImgHistoryTask(name) {
  if (!confirm(`确定删除「${name}」？\n该测试在 workspace 目录中的数据将一并删除，不可恢复。`)) return;
  const r = await fetchJSON(`/api/tests/image/history/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!r || !r.success) return alert((r && r.error) || "删除失败");
  if (imgActiveTask === name || imgStatusViewTask === name) {
    enterImgRunMode();
  }
  if (imgCurrentTask === name) imgCurrentTask = null;
  await loadImgHistory();
}

/* 侧栏点击：删除/草稿/运行中/已结束 */
$("imgHistoryList").addEventListener("click", (e) => {
  const del = e.target.closest(".history-item-del");
  if (del) {
    const item = del.closest(".history-item");
    if (item) deleteImgHistoryTask(item.dataset.name);
    return;
  }
  const item = e.target.closest(".history-item");
  if (!item) return;
  if (imgMode === "run" && item.dataset.name === imgDraftTask) {
    return;   // 草稿已处于运行模式
  }
  const name = item.dataset.name;
  const task = lastImgHistoryTasks.find((t) => t.name === name);
  if (task && task.status === "running") {
    imgDraftTask = null;
    imgCurrentTask = name;
    enterImgRunMode();
    pollImgStatus();
    return;
  }
  enterImgReportMode(name);
});

/* 新测试：进入运行模式，参数区留空待填写 */
$("btnNewImageTest").addEventListener("click", () => {
  imgDraftTask = genImgTaskName();
  imgMode = "run";
  imgActiveTask = null;
  setImgPanelTitles("run");
  imgCurrentTask = null;
  $("imgModelSelect").value = "";
  $("imageCount").value = "";
  $("imgArticleLength").value = "";
  $("imgConcurrency").value = "";
  probeImgSelectedModel();
  // 图片目录保留上次选择（图片集通常复用），仅清空数值参数；
  // 报告模式曾把 label 回显为历史目录，这里恢复为待运行目录
  restoreImgDirLabel();
  $("imgProgressList").style.display = "";
  $("imgProgressList").querySelectorAll(".case-row").forEach((r) => r.remove());
  $("imgRunSummary").style.display = "none";
  $("imgVllmBar").style.display = "none";
  $("imgProfileBar").style.display = "none";
  $("imgRunEmpty").style.display = "block";
  $("btnImgGenReport").style.display = "none";
  $("btnImgBackStatus").style.display = "none";
  imgStatusViewTask = null;
  imgStatusViewResult = null;
  hideImgMonitor();
  hideImgAnalysis();
  setImgRunningUI(false);
  restartImgPolling();
  renderImgHistoryList();
});

/* ============ 运行控制（图形测试） ============ */
let imgPollTimer = null;
let imgCurrentInterval = 3;

$("btnRunImage").addEventListener("click", async () => {
  const modelId = $("imgModelSelect").value;
  if (!modelId) return alert("请先选择模型配置");
  if (!imgSelectedDir) return alert("请先选择图片目录");
  const payload = {
    model_id: modelId,
    image_dir: imgSelectedDir,
    image_count: parseInt($("imageCount").value) || 5,
    article_length: parseInt($("imgArticleLength").value) || 500,
    concurrency: parseInt($("imgConcurrency").value) || 2,
  };
  const r = await fetchJSON("/api/tests/image/start", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!r.success) return alert(r.error || "启动失败");
  imgDraftTask = null;
  imgCurrentTask = r.task_name || null;
  enterImgRunMode();
  $("imgProgressList").querySelectorAll(".case-row").forEach((row) => row.remove());
  $("imgRunSummary").style.display = "none";
  $("imgVllmBar").style.display = "none";
  $("imgProfileBar").style.display = "none";
  $("imgRunEmpty").style.display = "block";
  setImgRunningUI(true);
  pollImgStatus();
  loadImgHistory();
});

$("btnStopImage").addEventListener("click", async () => {
  await fetchJSON("/api/tests/image/stop", { method: "POST" });
  pollImgStatus();
});

$("btnImgGenReport").addEventListener("click", () => {
  if (imgCurrentTask) enterImgReportMode(imgCurrentTask);
});

$("btnImgBackStatus").addEventListener("click", () => {
  if (imgActiveTask) enterImgStatusView(imgActiveTask);
});

function setImgRunningUI(running) {
  $("btnRunImage").disabled = running;
  $("btnStopImage").disabled = !running;
}

/* 刷新间隔 */
$("imgRefreshInterval").addEventListener("change", () => {
  imgCurrentInterval = parseInt($("imgRefreshInterval").value) || 3;
  restartImgPolling();
});

function restartImgPolling() {
  if (imgPollTimer) clearInterval(imgPollTimer);
  imgPollTimer = setInterval(pollImgStatus, imgCurrentInterval * 1000);
}

/* ============ 状态轮询与进度条渲染（图形测试） ============ */

async function pollImgStatus() {
  const s = await fetchJSON("/api/tests/image/status");
  if (s && s.test_id) {
    if (lastImgTestStatus === "running" && s.status !== "running") {
      loadImgHistory();
    }
    lastImgTestStatus = s.status;
  }
  if (imgMode !== "run") return;
  if (imgStatusViewTask) return;
  if (imgDraftTask && !imgCurrentTask) {
    $("btnImgGenReport").style.display = "none";
    return;
  }
  if (!s || !s.test_id) {
    $("btnImgGenReport").style.display = "none";
    $("imgRunEmpty").style.display = "block";
    $("imgVllmBar").style.display = "none";
    $("imgProfileBar").style.display = "none";
    return;
  }
  if (s.task_name) imgCurrentTask = s.task_name;
  renderImgStatus(s);
}

function renderImgStatus(s) {
  setImgRunningUI(s.status === "running");
  $("imgProfileBar").style.display = "none";
  $("btnImgGenReport").style.display = (s.status !== "running" && imgCurrentTask) ? "" : "none";

  const now = Date.now();
  const minMs = Math.max(imgCurrentInterval, 15) * 1000;
  if (now - imgLastVllmBarRender >= minMs) {
    imgLastVllmBarRender = now;
    renderVllmBarInto($("imgVllmBar"), $("imgVllmBarItems"), $("imgVllmBarTitle"),
      s.vllm_metrics, "live", null);
  }

  const sum = s.summary || {};
  $("imgRunSummary").style.display = "flex";
  $("imgSumStatus").innerHTML = `状态: <b>${STATUS_TEXT[s.status] || s.status}</b>`;
  $("imgSumElapsed").innerHTML = `已用时: <b>${fmtElapsed(s.elapsed)}</b>`;
  $("imgSumCalls").innerHTML = `总调用: <b>${sum.total_calls ?? 0}</b>`;
  $("imgSumErrors").innerHTML = `错误: <b style="color:${sum.total_errors ? "var(--danger)" : "inherit"}">${sum.total_errors ?? 0}</b>`;
  $("imgSumChars").innerHTML = `生成字数: <b>${(sum.total_chars ?? 0).toLocaleString()}</b>`;
  const pt = sum.prompt_tokens_avg;
  $("imgSumTokens").innerHTML = `平均输入: <b>${pt != null
    ? pt.toLocaleString() + " token" + (sum.prompt_tokens_source === "usage" ? "（实测）" : "（估算）")
    : "—"}</b>`;

  const list = $("imgProgressList");
  $("imgRunEmpty").style.display = "none";
  const rows = list.querySelectorAll(".case-row");
  rows.forEach((row, i) => { if (i >= s.cases.length) row.remove(); });
  s.cases.forEach((c, i) => {
    let row = rows[i];
    if (!row) {
      row = document.createElement("div");
      row.className = "case-row";
      row.innerHTML = `
        <div class="case-row-header">
          <div class="case-row-left">
            <span class="case-id">Thread ${c.case_id}</span>
            <span class="case-status" title="点击查看详情"></span>
            <span class="case-noun case-image"></span>
          </div>
          <div class="case-row-right"></div>
        </div>
        <div class="progress-track">
          <div class="progress-fill"><div class="progress-text"></div></div>
        </div>`;
      list.appendChild(row);
    }
    row.dataset.caseId = c.case_id;
    const badge = row.querySelector(".case-status");
    badge.textContent = STATUS_TEXT[c.status] || c.status;
    badge.className = "case-status " + c.status;
    // 当前正在处理的图片文件名
    row.querySelector(".case-image").textContent =
      c.status === "running" && c.current_image ? `当前图片: ${c.current_image}` : "";
    const total = c.total_loops || s.params.image_count || 1;
    const pct = Math.round((c.completed_loops / total) * 100);
    const fill = row.querySelector(".progress-fill");
    fill.style.width = pct + "%";
    fill.className = "progress-fill " + (c.status === "error" ? "error" : c.status === "completed" ? "completed" : c.status === "stopped" ? "stopped" : "");
    row.querySelector(".progress-text").textContent =
      `迭代 ${c.completed_loops}/${total}（${pct}%）`;
    row.querySelector(".case-row-right").innerHTML =
      `调用 ${c.calls_done} 次` +
      (c.errors
        ? ` · <span class="err-count">错误 ${c.errors}${buildErrorTooltip(c)}</span>`
        : "");
  });
}

/* ============ 图形测试 Case 详情弹窗 ============ */

let imgCaseModalCaseId = null;
let imgCaseEventSource = null;   // SSE 实时流
let imgCaseModalTimer = null;    // SSE 降级轮询
let imgQaExpanded = false;
let imgStreamingPartial = {};    // idx -> 流式文本
let imgLastE2eRender = 0;
let imgQaOutlineActive = null;
let imgQaJumping = false;

// 点击状态徽章打开详情弹窗（事件委托）
$("imgProgressList").addEventListener("click", (e) => {
  const badge = e.target.closest(".case-status");
  if (!badge) return;
  const row = badge.closest(".case-row");
  const id = row && parseInt(row.dataset.caseId, 10);
  if (id) openImgCaseModal(id);
});

function openImgCaseModal(caseId) {
  imgCaseModalCaseId = caseId;
  $("imgCaseModal").style.display = "flex";
  imgLastE2eRender = 0;
  imgQaOutlineActive = null;
  toggleImgQaList(true);
  if (imgStatusViewTask) {
    // 状态视图（历史任务终态）：用缓存 result 静态渲染
    const c = ((imgStatusViewResult && imgStatusViewResult.cases) || [])
      .find((x) => x.case_id === caseId);
    if (c) renderImgCaseDetail({ case: c });
    return;
  }
  refreshImgCaseDetail();
}

function closeImgCaseModal() {
  $("imgCaseModal").style.display = "none";
  stopImgCaseStream();
  imgCaseModalCaseId = null;
}

function toggleImgQaList(force) {
  imgQaExpanded = force !== undefined ? force : !imgQaExpanded;
  $("imgCaseQaWrap").style.display = imgQaExpanded ? "flex" : "none";
  $("btnImgMoreDetail").textContent = imgQaExpanded ? "收起细节 ▾" : "更多细节 ▸";
}

async function refreshImgCaseDetail() {
  if (!imgCaseModalCaseId) return;
  const r = await fetchJSON(`/api/tests/image/case/${imgCaseModalCaseId}`);
  if (!r || !r.success) {
    closeImgCaseModal();
    return;
  }
  renderImgCaseDetail(r);
  const running = r.test_status === "running" &&
    !["completed", "error", "stopped"].includes(r.case.status);
  if (running && !imgCaseEventSource && !imgCaseModalTimer) startImgCaseStream();
}

function startImgCaseStream() {
  stopImgCaseStream();
  if (!imgCaseModalCaseId || typeof EventSource === "undefined") {
    imgCaseModalTimer = setInterval(refreshImgCaseDetail, 1500);
    return;
  }
  const es = new EventSource(`/api/tests/image/case/${imgCaseModalCaseId}/stream`);
  imgCaseEventSource = es;

  es.addEventListener("snapshot", (e) => {
    const r = JSON.parse(e.data);
    renderImgCaseDetail(r);
    imgStreamingPartial = {};
    (r.case.qa_history || []).forEach((qa, i) => {
      if (qa.status === "generating") imgStreamingPartial[i] = qa.partial || "";
    });
  });
  es.addEventListener("delta", (e) => {
    const d = JSON.parse(e.data);
    applyImgDelta(d.i, d.text);
  });
  es.addEventListener("stats", (e) => {
    const r = JSON.parse(e.data);
    renderImgRunStats(r.case);
    renderImgE2eMetrics(r.case);
  });
  es.addEventListener("end", () => {
    stopImgCaseStream();
    imgLastE2eRender = 0;
    refreshImgCaseDetail();
  });
  es.onerror = () => {
    stopImgCaseStream();
    imgCaseModalTimer = setInterval(refreshImgCaseDetail, 1500);
  };
}

function stopImgCaseStream() {
  if (imgCaseEventSource) {
    imgCaseEventSource.close();
    imgCaseEventSource = null;
  }
  if (imgCaseModalTimer) {
    clearInterval(imgCaseModalTimer);
    imgCaseModalTimer = null;
  }
}

function applyImgDelta(idx, text) {
  imgStreamingPartial[idx] = (imgStreamingPartial[idx] || "") + text;
  const list = $("imgCaseQaList");
  const el = list.querySelector(`.qa-answer.streaming[data-idx="${idx}"]`);
  if (!el) return;
  const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
  el.innerHTML = renderMarkdown(imgStreamingPartial[idx]) +
    '<span class="qa-cursor">▌</span>';
  if (stick) list.scrollTop = list.scrollHeight;
}

function renderImgCaseDetail(r) {
  renderImgRunStats(r.case);
  renderImgE2eMetrics(r.case);
  renderImgQaList(r.case);
}

function renderImgRunStats(c) {
  $("imgCaseDetailTitle").textContent = `Thread ${c.case_id} 详情`;
  const badge = $("imgCaseDetailBadge");
  badge.textContent = STATUS_TEXT[c.status] || c.status;
  badge.className = "case-status " + c.status;

  const stats = [
    ["状态", STATUS_TEXT[c.status] || c.status],
    ["用时", fmtElapsed(c.elapsed)],
    ["生成字数", (c.chars_generated || 0).toLocaleString()],
    ["错误", `${c.errors} 次`],
    ["进度", `${c.completed_loops}/${c.total_loops} 迭代`],
    ["当前图片", c.current_image || "—"],
    ["平均输入 token", c.prompt_tokens_avg != null
      ? `${c.prompt_tokens_avg.toLocaleString()} token` : "—"],
  ];
  $("imgCaseRunStats").innerHTML = stats.map(([k, v]) =>
    `<div class="detail-item"><span class="detail-k">${k}</span>` +
    `<span class="detail-v">${escapeHtml(String(v))}</span></div>`).join("");
}

function renderImgE2eMetrics(c) {
  const now = Date.now();
  if (now - imgLastE2eRender < 10000) return;
  imgLastE2eRender = now;

  const el = $("imgCaseE2eMetrics");
  const e = c.e2e;
  if (!e || !e.samples) {
    el.innerHTML = '<div class="detail-item"><span class="detail-v">' +
      '暂无数据（文章生成开始后自动测量）</span></div>';
    return;
  }
  const rows = [
    ["TTFT 平均", e.ttft_avg_s == null ? "—" : `${e.ttft_avg_s} s`],
    ["TTFT 最大", e.ttft_max_s == null ? "—" : `${e.ttft_max_s} s`],
    ["TPOT 逐字间隔", e.tpot_avg_s == null ? "—" : `${e.tpot_avg_s} s/字`],
    ["生成吞吐", e.throughput_cps == null ? "—" : `${e.throughput_cps} 字/s`],
    ["统计样本", `${e.samples} 次流式调用`],
  ];
  el.innerHTML = rows.map(([k, v]) =>
    `<div class="detail-item"><span class="detail-k">${k}</span>` +
    `<span class="detail-v">${escapeHtml(String(v))}</span></div>`).join("");
}

/* qa 列表渲染（图形版：大纲 label 与 meta 均显示图片文件名） */
function renderImgQaList(c) {
  const list = $("imgCaseQaList");
  const qas = c.qa_history || [];
  const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;

  if (!qas.length) {
    $("imgCaseQaOutline").innerHTML = "";
    list.innerHTML = '<div class="qa-empty">暂无调用记录</div>';
    return;
  }
  list.innerHTML = qas.map((qa, idx) => imgQaItemHtml(qa, idx, c)).join("");
  renderImgQaOutline(qas);
  if (imgQaOutlineActive != null) {
    const el = list.querySelector(`.qa-item[data-idx="${imgQaOutlineActive}"]`);
    if (el) {
      el.classList.add("qa-jump");
      const lRect = list.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      list.scrollTop += eRect.top - lRect.top - 8;
    }
  } else if (stick) {
    list.scrollTop = list.scrollHeight;
  }
}

function renderImgQaOutline(qas) {
  const outline = $("imgCaseQaOutline");
  const follow = imgQaOutlineActive == null;
  const active = (imgQaOutlineActive != null && imgQaOutlineActive < qas.length)
    ? imgQaOutlineActive : qas.length - 1;
  outline.innerHTML = qas.map((qa, idx) => {
    const label = qa.image || (qa.question || "").slice(0, 14);
    return `<div class="qa-outline-item ${idx === active ? "active" : ""} ${qa.status}" data-idx="${idx}">` +
      `<span class="qa-outline-num">#${idx + 1}</span>` +
      `<span class="qa-outline-label" title="${escapeHtml(qa.image || "")}">${escapeHtml(label)}</span>` +
      (qa.status === "generating" ? '<span class="qa-outline-dot"></span>' : "") +
      `</div>`;
  }).join("");
  if (follow) {
    outline.scrollTop = outline.scrollHeight;
  } else {
    const el = outline.querySelector(`.qa-outline-item[data-idx="${imgQaOutlineActive}"]`);
    if (el) {
      const oRect = outline.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      if (eRect.top < oRect.top) outline.scrollTop -= oRect.top - eRect.top;
      else if (eRect.bottom > oRect.bottom) outline.scrollTop += eRect.bottom - oRect.bottom;
    }
  }
}

function jumpToImgQa(idx) {
  imgQaOutlineActive = idx;
  const list = $("imgCaseQaList");
  const target = list.querySelector(`.qa-item[data-idx="${idx}"]`);
  if (!target) return;
  imgQaJumping = true;
  const lRect = list.getBoundingClientRect();
  const tRect = target.getBoundingClientRect();
  list.scrollTop += tRect.top - lRect.top - 8;
  setTimeout(() => { imgQaJumping = false; }, 100);
  list.querySelectorAll(".qa-jump").forEach(el => el.classList.remove("qa-jump"));
  target.classList.add("qa-jump");
  $("imgCaseQaOutline").querySelectorAll(".qa-outline-item").forEach(el =>
    el.classList.toggle("active", parseInt(el.dataset.idx, 10) === idx));
}

$("imgCaseQaOutline").addEventListener("click", (e) => {
  const item = e.target.closest(".qa-outline-item");
  if (item) jumpToImgQa(parseInt(item.dataset.idx, 10));
});

$("imgCaseQaList").addEventListener("scroll", () => {
  if (imgQaJumping || imgQaOutlineActive == null) return;
  const list = $("imgCaseQaList");
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 40) {
    imgQaOutlineActive = null;
    const items = $("imgCaseQaOutline").querySelectorAll(".qa-outline-item");
    items.forEach(el => el.classList.toggle("active", el === items[items.length - 1]));
  }
});

/* 单条调用记录：图片文件名 + prompt + 实测输入 token + 流式文章 */
function imgQaItemHtml(qa, idx, c) {
  const meta = [escapeHtml(qa.phase)];
  if (qa.loop) meta.push(`第 ${qa.loop}/${c.total_loops} 迭代`);
  if (qa.image) meta.push(`图片「${escapeHtml(qa.image)}」`);
  if (qa.prompt_tokens != null) meta.push(`输入 ${qa.prompt_tokens.toLocaleString()} token`);
  if (qa.duration) meta.push(`${qa.duration}s`);
  if (qa.ttft != null) meta.push(`TTFT ${qa.ttft}s`);

  let answerHtml;
  if (qa.status === "generating") {
    const partial = qa.partial || "";
    const body = partial
      ? renderMarkdown(partial) + '<span class="qa-cursor">▌</span>'
      : '<span class="qa-waiting">已发送图片与指令，等待 LLM 回复</span><span class="qa-cursor">▌</span>';
    answerHtml = `<div class="qa-answer streaming md" data-idx="${idx}">${body}</div>`;
  } else if (qa.status === "error") {
    answerHtml = `<div class="qa-answer qa-err">✗ ${escapeHtml(qa.error || "调用失败")}</div>`;
  } else {
    answerHtml = `<div class="qa-answer md">${renderMarkdown(qa.answer || "（空回复）")}</div>`;
  }
  return `<div class="qa-item ${qa.status}" data-idx="${idx}">
    <div class="qa-meta">#${idx + 1} · ${meta.join(" · ")}</div>
    <div class="qa-question">Q: ${escapeHtml(qa.question || "")}</div>
    ${answerHtml}
  </div>`;
}

/* ============ 初始化（图形测试） ============ */
(async function initImageTest() {
  imgDirModal = $("imageDirModal");
  $("btnPickImageDir").addEventListener("click", openImgDirModal);
  $("btnCloseImgDir").addEventListener("click", closeImgDirModal);
  imgDirModal.addEventListener("click", (e) => {
    if (e.target === imgDirModal) closeImgDirModal();
  });
  $("btnCloseImgCase").addEventListener("click", closeImgCaseModal);
  $("imgCaseModal").addEventListener("click", (e) => {
    if (e.target === $("imgCaseModal")) closeImgCaseModal();
  });
  $("btnImgMoreDetail").addEventListener("click", () => toggleImgQaList());

  await loadImgModelSelect();
  await loadImgHistory();
  // 默认加载程序运行位置的 image 目录（用户尚未选择过目录时）
  const d = await fetchJSON("/api/fs/defaults");
  if (d && d.image_dir) imgDefaultDir = d.image_dir.path;
  if (d && d.image_dir && !imgSelectedDir) {
    imgSelectedDir = d.image_dir.path;
    imgDirImages = d.image_dir.count;
    imgSelectedCount = d.image_dir.count;
    restoreImgDirLabel();
  }
  // 页面加载时若图形测试在运行，恢复显示并选中侧栏对应任务
  const s = await fetchJSON("/api/tests/image/status");
  if (s && s.test_id && s.status !== "idle") {
    imgCurrentTask = s.task_name || null;
    lastImgTestStatus = s.status;
    renderImgStatus(s);
    renderImgHistoryList();
  }
  if ($("imgModelSelect").value) probeImgSelectedModel();
  restartImgPolling();
})();

