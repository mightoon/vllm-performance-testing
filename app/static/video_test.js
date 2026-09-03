/* ============ 视频测试（视频理解 + 文章生成） ============
   与 image_test.js 的图形测试同构，复用 app.js 全局工具函数。
   差异点：
   - 参数区第 1 位为"测试视频"（目录选择弹窗，浏览应用所在机器磁盘）
   - thread 行实时显示正在处理的视频文件名
   - 多模态消息为 video_url（vLLM 视频输入），视频池循环复用
   - 输入 token 为服务端实测（usage 优先，metrics 差分估算兜底） */

/* ============ 模型下拉与探测（视频测试参数区） ============ */
let vidModelProbe = null;   // 当前选中模型的探测结果
let vidProbeSeq = 0;

async function loadVidModelSelect() {
  const models = await fetchJSON("/api/models");
  const sel = $("vidModelSelect");
  const prev = sel.value;
  sel.innerHTML =
    '<option value="" disabled selected>选择模型配置</option>' +
    (models || [])
      .map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`)
      .join("");
  if (prev && (models || []).some((m) => m.id === prev)) sel.value = prev;
}

async function probeVidSelectedModel() {
  const modelId = $("vidModelSelect").value;
  const info = $("vidModelInfo");
  vidModelProbe = null;
  if (!modelId) { info.style.display = "none"; return; }
  const seq = ++vidProbeSeq;
  info.style.display = "flex";
  info.innerHTML = '<span>服务端参数探测中…</span>';
  const r = await fetchJSON(`/api/models/${modelId}/probe`);
  if (seq !== vidProbeSeq) return;   // 已切换模型，丢弃过期响应
  if (r && r.success) {
    vidModelProbe = r;
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

$("vidModelSelect").addEventListener("change", probeVidSelectedModel);

/* ============ 视频目录选择弹窗 ============ */
let vidDirModal = null;          // 弹窗元素
let vidDirCurrent = null;        // 当前浏览目录（null = 盘符列表）
let vidDirParent = null;         // 当前目录的上级（null = 无上级/盘符列表）
let vidDirVideos = 0;            // 当前目录视频数
let vidSelectedDir = null;       // 已确认选择的目录路径
let vidSelectedCount = 0;        // 已选目录的视频数（label 显示用；与"当前浏览目录"的 vidDirVideos 区分）
let vidDefaultDir = null;        // 默认目录（程序运行位置的 video/）完整路径

/* 目录显示文本：默认目录显示相对名（如 video），其余目录显示完整路径 */
function vidDirDisplayText(path, count) {
  const disp = vidDefaultDir && path === vidDefaultDir
    ? path.split(/[\\/]+/).filter(Boolean).pop() : path;
  return disp + (count > 0 ? `（${count} 个）` : "");
}

/* 恢复目录 label 为待运行参数（vidSelectedDir）的显示。
   报告模式会把 label 回显为历史任务的目录，回到运行模式时必须恢复。 */
function restoreVidDirLabel() {
  const label = $("videoDirLabel");
  if (vidSelectedDir) {
    label.textContent = vidDirDisplayText(vidSelectedDir, vidSelectedCount);
    label.title = vidSelectedDir;
    label.classList.add("has-dir");
  } else {
    label.textContent = "未选择目录";
    label.title = "";
    label.classList.remove("has-dir");
  }
}

function openVidDirModal() {
  vidDirModal.style.display = "flex";
  // 已选择过目录：从该目录开始浏览；否则从根（盘符列表）开始
  if (vidSelectedDir) {
    loadVidDirList(vidSelectedDir);
  } else {
    loadVidDirRoot();
  }
}

function closeVidDirModal() {
  vidDirModal.style.display = "none";
}

async function loadVidDirRoot() {
  vidDirCurrent = null;
  vidDirParent = null;
  $("vidDirPath").textContent = "请选择磁盘";
  $("vidDirPath").title = "";
  $("btnVidDirUp").disabled = true;
  $("vidDirVideosInfo").textContent = "";
  $("btnVidDirConfirm").disabled = true;
  const list = $("vidDirList");
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

async function loadVidDirList(path) {
  $("vidDirPath").textContent = "加载中…";
  $("vidDirPath").title = "";
  const list = $("vidDirList");
  list.innerHTML = '<div class="dir-empty">加载中…</div>';
  const r = await fetchJSON(`/api/fs/list?path=${encodeURIComponent(path)}`);
  if (!r || !r.success) {
    list.innerHTML = `<div class="dir-empty">加载失败：${escapeHtml((r && r.error) || "未知错误")}</div>`;
    return;
  }
  vidDirCurrent = r.path;
  vidDirParent = r.parent;
  vidDirVideos = r.videos;
  $("vidDirPath").textContent = r.path;
  $("vidDirPath").title = r.path;
  $("btnVidDirUp").disabled = false;
  $("vidDirVideosInfo").innerHTML = r.videos > 0
    ? `当前目录含 <b>${r.videos}</b> 个视频（mp4/avi/mkv/mov/webm 等）`
    : '<span class="dir-warn">当前目录没有视频文件</span>';
  // 当前目录可作为选择目标（即使 0 个视频，也允许选，后端启动时会校验）
  $("btnVidDirConfirm").disabled = false;
  if (!(r.dirs || []).length) {
    list.innerHTML = '<div class="dir-empty">无子目录</div>';
    return;
  }
  list.innerHTML = r.dirs.map((d) => {
    const cnt = d.videos < 0 ? "？" : d.videos;
    return `<div class="dir-item" data-path="${escapeHtml(d.path)}" title="${escapeHtml(d.path)}">` +
      `<span class="dir-item-icon">📁</span>` +
      `<span class="dir-item-name">${escapeHtml(d.name)}</span>` +
      `<span class="dir-item-count">${cnt} 视频</span></div>`;
  }).join("");
}

/* 目录列表点击：进入子目录；上级按钮：返回上级（盘根时回盘符列表） */
$("vidDirList").addEventListener("click", (e) => {
  const item = e.target.closest(".dir-item");
  if (item && item.dataset.path) loadVidDirList(item.dataset.path);
});

$("btnVidDirUp").addEventListener("click", () => {
  if (vidDirParent) loadVidDirList(vidDirParent);
  else loadVidDirRoot();
});

/* 确认选择：记录目录并更新参数区显示（含视频计数预览） */
$("btnVidDirConfirm").addEventListener("click", () => {
  if (!vidDirCurrent) return;
  vidSelectedDir = vidDirCurrent;
  vidSelectedCount = vidDirVideos;
  const label = $("videoDirLabel");
  label.textContent = vidDirDisplayText(vidDirCurrent, vidDirVideos);
  label.title = vidDirCurrent;
  label.classList.add("has-dir");
  closeVidDirModal();
});

/* ============ 历史侧栏与模式管理（视频测试） ============ */
let vidMode = "run";            // "run" | "report"
let vidActiveTask = null;       // 报告模式正在查看的任务名
let vidDraftTask = null;        // "新测试"草稿任务名
let vidCurrentTask = null;      // 运行模式当前（或最近）任务名
let vidStatusViewTask = null;   // 状态视图：历史任务终态
let vidStatusViewResult = null; // 状态视图缓存的 result.json
let lastVidHistoryTasks = [];
let lastVidTestStatus = null;

function genVidTaskName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `视频测试-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}`;
}

function currentVidSelectedTask() {
  if (vidMode === "report") return vidActiveTask;
  return vidCurrentTask || vidDraftTask;
}

async function loadVidHistory() {
  const r = await fetchJSON("/api/tests/video/history");
  lastVidHistoryTasks = (r && r.tasks) || [];
  renderVidHistoryList();
}

/* 历史条目小字为两行：
   第一行：状态徽章 + 并发数；第二行：输入：平均 M token，输出：K token
   （M 为服务端实测平均值，无数据时显示 —） */
function vidHistoryItemHtml(t, selected, isDraft) {
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

function renderVidHistoryList() {
  const list = $("vidHistoryList");
  const selected = currentVidSelectedTask();
  let html = "";
  if (vidDraftTask) {
    html += vidHistoryItemHtml({ name: vidDraftTask, params: {} }, selected, true);
  }
  html += lastVidHistoryTasks.map((t) => vidHistoryItemHtml(t, selected, false)).join("");
  list.innerHTML = html || '<div class="history-empty">暂无历史测试</div>';
}

function setVidPanelTitles(mode) {
  $("vidRunPanelTitle").textContent = mode === "report" ? "测试报告" : "测试状态";
}

/* 进入运行模式：恢复 thread 列表与轮询 */
function enterVidRunMode() {
  vidMode = "run";
  vidActiveTask = null;
  vidStatusViewTask = null;
  vidStatusViewResult = null;
  restoreVidDirLabel();
  setVidPanelTitles("run");
  $("btnVidGenReport").style.display = "none";
  $("btnVidBackStatus").style.display = "none";
  hideVidMonitor();
  hideVidAnalysis();
  $("vidProgressList").style.display = "";
  restartVidPolling();
  renderVidHistoryList();
}

/* ============ 报告模式监控图表与 AI 分析（视频测试） ============ */
let vidMonitorChartInstances = [];

function disposeVidMonitorCharts() {
  vidMonitorChartInstances.forEach((c) => c.dispose());
  vidMonitorChartInstances = [];
}

function hideVidMonitor() {
  disposeVidMonitorCharts();
  $("vidMonitorArea").style.display = "none";
}

let vidReportGpuStats = null;
let vidLastVllmBarRender = 0;

async function loadVidMonitorCharts(taskName, config, result) {
  disposeVidMonitorCharts();
  vidReportGpuStats = null;
  const area = $("vidMonitorArea");
  area.style.display = "block";
  $("vidMonitorCards").innerHTML = "";
  $("vidMonitorCharts").innerHTML = "";
  $("vidMonitorEmpty").style.display = "none";
  $("vidMonitorSource").textContent = "";
  updateGrafanaLinkInto($("vidGrafanaLink"), config, result);

  const r = await fetchJSON(`/api/tests/video/history/${encodeURIComponent(taskName)}/metrics`);
  if (!r || !r.success || !r.metrics || !(r.metrics.series || []).length) {
    $("vidMonitorEmpty").style.display = "block";
    return;
  }
  $("vidMonitorSource").textContent = r.source === "live" ? "（实时查询）" : "";
  const st = r.metrics.stats || {};
  if (st.gpu_fb_usage_avg != null || st.gpu_mem_copy_util_avg != null) {
    vidReportGpuStats = {
      gpu_fb_usage_avg: st.gpu_fb_usage_avg ?? null,
      gpu_mem_copy_util_avg: st.gpu_mem_copy_util_avg ?? null,
    };
    if (result && result.vllm_metrics_summary) {
      renderVllmBarInto($("vidVllmBar"), $("vidVllmBarItems"),
        $("vidVllmBarTitle"), result.vllm_metrics_summary, "report", vidReportGpuStats);
    }
  }
  renderMonitorChartsInto($("vidMonitorCards"), $("vidMonitorCharts"),
    r.metrics, (result || {}).vllm_metrics_summary, vidMonitorChartInstances);
}

window.addEventListener("resize", () => {
  vidMonitorChartInstances.forEach((c) => c.resize());
});

let vidAnalysisPollTimer = null;

function stopVidAnalysisPoll() {
  if (vidAnalysisPollTimer) { clearTimeout(vidAnalysisPollTimer); vidAnalysisPollTimer = null; }
}

function hideVidAnalysis() {
  $("vidAnalysisArea").style.display = "none";
  stopVidAnalysisPoll();
}

async function loadVidAnalysis(taskName) {
  stopVidAnalysisPoll();
  $("vidAnalysisArea").style.display = "block";
  $("vidAnalysisBody").innerHTML = '<div class="analysis-empty">分析加载中…</div>';
  $("vidAnalysisMeta").textContent = "";
  const r = await fetchJSON(`/api/tests/video/history/${encodeURIComponent(taskName)}/analysis`);
  if (r && r.analysis) {
    renderAnalysisInto($("vidAnalysisBody"), $("vidAnalysisMeta"), r.analysis);
  } else if (r && r.pending) {
    $("vidAnalysisBody").innerHTML = '<div class="analysis-empty">分析正在生成中。。。</div>';
    pollVidAnalysis(taskName);
  } else {
    $("vidAnalysisBody").innerHTML =
      '<div class="analysis-empty">暂无分析（旧任务无自动分析记录）</div>';
  }
}

function pollVidAnalysis(taskName) {
  vidAnalysisPollTimer = setTimeout(async () => {
    vidAnalysisPollTimer = null;
    const r = await fetchJSON(`/api/tests/video/history/${encodeURIComponent(taskName)}/analysis`);
    if (r && r.analysis) {
      renderAnalysisInto($("vidAnalysisBody"), $("vidAnalysisMeta"), r.analysis);
      return;
    }
    if (r && r.pending) { pollVidAnalysis(taskName); return; }
    $("vidAnalysisBody").innerHTML =
      '<div class="analysis-empty">暂无分析（旧任务无自动分析记录）</div>';
  }, 15000);
}

/* ============ 报告模式 / 状态视图（视频测试） ============ */

async function enterVidReportMode(taskName) {
  vidMode = "report";
  vidActiveTask = taskName;
  vidDraftTask = null;
  vidStatusViewTask = null;
  vidStatusViewResult = null;
  setVidPanelTitles("report");
  $("btnVidGenReport").style.display = "none";
  $("btnVidBackStatus").style.display = "";
  closeVidCaseModal();
  const r = await fetchJSON(`/api/tests/video/history/${encodeURIComponent(taskName)}`);
  if (!r || !r.success) return alert((r && r.error) || "加载历史任务失败");
  renderVidReport(r.config || {}, r.result || {});
  loadVidMonitorCharts(taskName, r.config || {}, r.result || {});
  loadVidAnalysis(taskName);
  renderVidHistoryList();
}

/* 从报告页返回该任务结束时的状态页（持久化 result 重建终态视图） */
async function enterVidStatusView(taskName) {
  vidMode = "run";
  vidActiveTask = null;
  vidDraftTask = null;
  vidCurrentTask = taskName;
  vidStatusViewTask = taskName;
  vidStatusViewResult = null;
  restoreVidDirLabel();
  setVidPanelTitles("run");
  $("btnVidBackStatus").style.display = "none";
  closeVidCaseModal();
  hideVidMonitor();
  hideVidAnalysis();
  $("vidProgressList").style.display = "";
  const r = await fetchJSON(`/api/tests/video/history/${encodeURIComponent(taskName)}`);
  if (!r || !r.success) return alert((r && r.error) || "加载历史任务失败");
  vidStatusViewResult = r.result || {};
  vidLastVllmBarRender = 0;
  renderVidStatus(vidStatusViewResult);
  renderVidHistoryList();
}

/* 报告渲染：参数区填充当时 profile；Profile 条含视频目录/数量；
   指标区含实测平均输入 token */
function renderVidReport(config, result) {
  const p = config.params || {};
  const sel = $("vidModelSelect");
  if (p.model_id && ![...sel.options].some((o) => o.value === p.model_id)) {
    const opt = document.createElement("option");
    opt.value = p.model_id;
    opt.textContent = (config.model && config.model.name) || p.model_name || p.model_id;
    sel.appendChild(opt);
  }
  sel.value = p.model_id || "";
  // 视频目录回显（仅显示，不设为当前选择——报告模式不改变待运行参数语义）
  $("videoDirLabel").textContent = p.video_dir || "未选择目录";
  $("videoDirLabel").title = p.video_dir || "";
  $("videoCount").value = p.video_count ?? "";
  $("vidArticleLength").value = p.article_length ?? "";
  $("vidConcurrency").value = p.concurrency ?? "";
  probeVidSelectedModel();

  const pr = config.model_probe || {};
  const sum = result.summary || {};
  const ptAvg = sum.prompt_tokens_avg;
  const profileRows = [
    ["模型", escapeHtml((config.model && config.model.name) || p.model_name || p.model_id || "—")],
    ["vLLM 版本", pr.version ? escapeHtml(pr.version) : "—"],
    ["最大上下文", pr.max_model_len ? fmtTokens(pr.max_model_len) + " token" : "—"],
    ["KV cache 容量", pr.kv_cache_tokens ? fmtTokens(pr.kv_cache_tokens) + " token" : "—"],
    ["视频目录", p.video_dir ? escapeHtml(p.video_dir) : "—"],
    ["目录视频数", p.video_pool_size != null
      ? `${p.video_pool_size} 个${(p.video_count * p.concurrency) > p.video_pool_size ? "（循环复用）" : ""}` : "—"],
    ["迭代次数（每Thread）", p.video_count ?? "—"],
    ["输出长度", p.article_length != null ? `${p.article_length} token` : "—"],
    ["并发度", p.concurrency ?? "—"],
    ["平均输入 token", ptAvg != null
      ? `${ptAvg.toLocaleString()} token${sum.prompt_tokens_source === "usage" ? "（实测）" : "（估算）"}` : "—"],
  ];
  $("vidProfileBarItems").innerHTML = profileRows.map(([k, v]) =>
    `<div class="detail-item"><span class="detail-k">${k}</span>` +
    `<span class="detail-v">${v}</span></div>`).join("");
  $("vidProfileBar").style.display = "block";

  $("vidRunEmpty").style.display = "none";
  $("vidRunSummary").style.display = "flex";
  $("vidSumStatus").innerHTML = `状态: <b>${STATUS_TEXT[result.status] || result.status || "未完成"}</b>`;
  $("vidSumElapsed").innerHTML = `用时: <b>${fmtElapsed(result.elapsed || 0)}</b>`;
  $("vidSumCalls").innerHTML = `总调用: <b>${sum.total_calls ?? "—"}</b>`;
  $("vidSumErrors").innerHTML = `错误: <b style="color:${sum.total_errors ? "var(--danger)" : "inherit"}">${sum.total_errors ?? "—"}</b>`;
  $("vidSumChars").innerHTML = `生成字数: <b>${(sum.total_chars ?? 0).toLocaleString()}</b>`;
  $("vidSumTokens").innerHTML = `平均输入: <b>${ptAvg != null ? ptAvg.toLocaleString() + " token" : "—"}</b>`;
  vidLastVllmBarRender = 0;
  renderVllmBarInto($("vidVllmBar"), $("vidVllmBarItems"), $("vidVllmBarTitle"),
    result.vllm_metrics_summary || result.vllm_metrics,
    result.vllm_metrics_summary ? "report" : "legacy", vidReportGpuStats);

  $("vidProgressList").style.display = "none";
  setVidRunningUI(false);
}

/* 删除历史视频测试 */
async function deleteVidHistoryTask(name) {
  if (!confirm(`确定删除「${name}」？\n该测试在 workspace 目录中的数据将一并删除，不可恢复。`)) return;
  const r = await fetchJSON(`/api/tests/video/history/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!r || !r.success) return alert((r && r.error) || "删除失败");
  if (vidActiveTask === name || vidStatusViewTask === name) {
    enterVidRunMode();
  }
  if (vidCurrentTask === name) vidCurrentTask = null;
  await loadVidHistory();
}

/* 侧栏点击：删除/草稿/运行中/已结束 */
$("vidHistoryList").addEventListener("click", (e) => {
  const del = e.target.closest(".history-item-del");
  if (del) {
    const item = del.closest(".history-item");
    if (item) deleteVidHistoryTask(item.dataset.name);
    return;
  }
  const item = e.target.closest(".history-item");
  if (!item) return;
  if (vidMode === "run" && item.dataset.name === vidDraftTask) {
    return;   // 草稿已处于运行模式
  }
  const name = item.dataset.name;
  const task = lastVidHistoryTasks.find((t) => t.name === name);
  if (task && task.status === "running") {
    vidDraftTask = null;
    vidCurrentTask = name;
    enterVidRunMode();
    pollVidStatus();
    return;
  }
  enterVidReportMode(name);
});

/* 新测试：进入运行模式，参数区留空待填写 */
$("btnNewVideoTest").addEventListener("click", () => {
  vidDraftTask = genVidTaskName();
  vidMode = "run";
  vidActiveTask = null;
  setVidPanelTitles("run");
  vidCurrentTask = null;
  $("vidModelSelect").value = "";
  $("videoCount").value = "";
  $("vidArticleLength").value = "";
  $("vidConcurrency").value = "";
  probeVidSelectedModel();
  // 视频目录保留上次选择（视频集通常复用），仅清空数值参数；
  // 报告模式曾把 label 回显为历史目录，这里恢复为待运行目录
  restoreVidDirLabel();
  $("vidProgressList").style.display = "";
  $("vidProgressList").querySelectorAll(".case-row").forEach((r) => r.remove());
  $("vidRunSummary").style.display = "none";
  $("vidVllmBar").style.display = "none";
  $("vidProfileBar").style.display = "none";
  $("vidRunEmpty").style.display = "block";
  $("btnVidGenReport").style.display = "none";
  $("btnVidBackStatus").style.display = "none";
  vidStatusViewTask = null;
  vidStatusViewResult = null;
  hideVidMonitor();
  hideVidAnalysis();
  setVidRunningUI(false);
  restartVidPolling();
  renderVidHistoryList();
});

/* ============ 运行控制（视频测试） ============ */
let vidPollTimer = null;
let vidCurrentInterval = 3;

$("btnRunVideo").addEventListener("click", async () => {
  const modelId = $("vidModelSelect").value;
  if (!modelId) return alert("请先选择模型配置");
  if (!vidSelectedDir) return alert("请先选择视频目录");
  const payload = {
    model_id: modelId,
    video_dir: vidSelectedDir,
    video_count: parseInt($("videoCount").value) || 5,
    article_length: parseInt($("vidArticleLength").value) || 500,
    concurrency: parseInt($("vidConcurrency").value) || 2,
  };
  const r = await fetchJSON("/api/tests/video/start", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!r.success) return alert(r.error || "启动失败");
  vidDraftTask = null;
  vidCurrentTask = r.task_name || null;
  enterVidRunMode();
  $("vidProgressList").querySelectorAll(".case-row").forEach((row) => row.remove());
  $("vidRunSummary").style.display = "none";
  $("vidVllmBar").style.display = "none";
  $("vidProfileBar").style.display = "none";
  $("vidRunEmpty").style.display = "block";
  setVidRunningUI(true);
  pollVidStatus();
  loadVidHistory();
});

$("btnStopVideo").addEventListener("click", async () => {
  await fetchJSON("/api/tests/video/stop", { method: "POST" });
  pollVidStatus();
});

$("btnVidGenReport").addEventListener("click", () => {
  if (vidCurrentTask) enterVidReportMode(vidCurrentTask);
});

$("btnVidBackStatus").addEventListener("click", () => {
  if (vidActiveTask) enterVidStatusView(vidActiveTask);
});

function setVidRunningUI(running) {
  $("btnRunVideo").disabled = running;
  $("btnStopVideo").disabled = !running;
}

/* 刷新间隔 */
$("vidRefreshInterval").addEventListener("change", () => {
  vidCurrentInterval = parseInt($("vidRefreshInterval").value) || 3;
  restartVidPolling();
});

function restartVidPolling() {
  if (vidPollTimer) clearInterval(vidPollTimer);
  vidPollTimer = setInterval(pollVidStatus, vidCurrentInterval * 1000);
}

/* ============ 状态轮询与进度条渲染（视频测试） ============ */

async function pollVidStatus() {
  const s = await fetchJSON("/api/tests/video/status");
  if (s && s.test_id) {
    if (lastVidTestStatus === "running" && s.status !== "running") {
      loadVidHistory();
    }
    lastVidTestStatus = s.status;
  }
  if (vidMode !== "run") return;
  if (vidStatusViewTask) return;
  if (vidDraftTask && !vidCurrentTask) {
    $("btnVidGenReport").style.display = "none";
    return;
  }
  if (!s || !s.test_id) {
    $("btnVidGenReport").style.display = "none";
    $("vidRunEmpty").style.display = "block";
    $("vidVllmBar").style.display = "none";
    $("vidProfileBar").style.display = "none";
    return;
  }
  if (s.task_name) vidCurrentTask = s.task_name;
  renderVidStatus(s);
}

function renderVidStatus(s) {
  setVidRunningUI(s.status === "running");
  $("vidProfileBar").style.display = "none";
  $("btnVidGenReport").style.display = (s.status !== "running" && vidCurrentTask) ? "" : "none";

  const now = Date.now();
  const minMs = Math.max(vidCurrentInterval, 15) * 1000;
  if (now - vidLastVllmBarRender >= minMs) {
    vidLastVllmBarRender = now;
    renderVllmBarInto($("vidVllmBar"), $("vidVllmBarItems"), $("vidVllmBarTitle"),
      s.vllm_metrics, "live", null);
  }

  const sum = s.summary || {};
  $("vidRunSummary").style.display = "flex";
  $("vidSumStatus").innerHTML = `状态: <b>${STATUS_TEXT[s.status] || s.status}</b>`;
  $("vidSumElapsed").innerHTML = `已用时: <b>${fmtElapsed(s.elapsed)}</b>`;
  $("vidSumCalls").innerHTML = `总调用: <b>${sum.total_calls ?? 0}</b>`;
  $("vidSumErrors").innerHTML = `错误: <b style="color:${sum.total_errors ? "var(--danger)" : "inherit"}">${sum.total_errors ?? 0}</b>`;
  $("vidSumChars").innerHTML = `生成字数: <b>${(sum.total_chars ?? 0).toLocaleString()}</b>`;
  const pt = sum.prompt_tokens_avg;
  $("vidSumTokens").innerHTML = `平均输入: <b>${pt != null
    ? pt.toLocaleString() + " token" + (sum.prompt_tokens_source === "usage" ? "（实测）" : "（估算）")
    : "—"}</b>`;

  const list = $("vidProgressList");
  $("vidRunEmpty").style.display = "none";
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
            <span class="case-noun case-video"></span>
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
    // 当前正在处理的视频文件名
    row.querySelector(".case-video").textContent =
      c.status === "running" && c.current_video ? `当前视频: ${c.current_video}` : "";
    const total = c.total_loops || s.params.video_count || 1;
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

/* ============ 视频测试 Case 详情弹窗 ============ */

let vidCaseModalCaseId = null;
let vidCaseEventSource = null;   // SSE 实时流
let vidCaseModalTimer = null;    // SSE 降级轮询
let vidQaExpanded = false;
let vidStreamingPartial = {};    // idx -> 流式文本
let vidLastE2eRender = 0;
let vidQaOutlineActive = null;
let vidQaJumping = false;

// 点击状态徽章打开详情弹窗（事件委托）
$("vidProgressList").addEventListener("click", (e) => {
  const badge = e.target.closest(".case-status");
  if (!badge) return;
  const row = badge.closest(".case-row");
  const id = row && parseInt(row.dataset.caseId, 10);
  if (id) openVidCaseModal(id);
});

function openVidCaseModal(caseId) {
  vidCaseModalCaseId = caseId;
  $("vidCaseModal").style.display = "flex";
  vidLastE2eRender = 0;
  vidQaOutlineActive = null;
  toggleVidQaList(true);
  if (vidStatusViewTask) {
    // 状态视图（历史任务终态）：用缓存 result 静态渲染
    const c = ((vidStatusViewResult && vidStatusViewResult.cases) || [])
      .find((x) => x.case_id === caseId);
    if (c) renderVidCaseDetail({ case: c });
    return;
  }
  refreshVidCaseDetail();
}

function closeVidCaseModal() {
  $("vidCaseModal").style.display = "none";
  stopVidCaseStream();
  vidCaseModalCaseId = null;
}

function toggleVidQaList(force) {
  vidQaExpanded = force !== undefined ? force : !vidQaExpanded;
  $("vidCaseQaWrap").style.display = vidQaExpanded ? "flex" : "none";
  $("btnVidMoreDetail").textContent = vidQaExpanded ? "收起细节 ▾" : "更多细节 ▸";
}

async function refreshVidCaseDetail() {
  if (!vidCaseModalCaseId) return;
  const r = await fetchJSON(`/api/tests/video/case/${vidCaseModalCaseId}`);
  if (!r || !r.success) {
    closeVidCaseModal();
    return;
  }
  renderVidCaseDetail(r);
  const running = r.test_status === "running" &&
    !["completed", "error", "stopped"].includes(r.case.status);
  if (running && !vidCaseEventSource && !vidCaseModalTimer) startVidCaseStream();
}

function startVidCaseStream() {
  stopVidCaseStream();
  if (!vidCaseModalCaseId || typeof EventSource === "undefined") {
    vidCaseModalTimer = setInterval(refreshVidCaseDetail, 1500);
    return;
  }
  const es = new EventSource(`/api/tests/video/case/${vidCaseModalCaseId}/stream`);
  vidCaseEventSource = es;

  es.addEventListener("snapshot", (e) => {
    const r = JSON.parse(e.data);
    renderVidCaseDetail(r);
    vidStreamingPartial = {};
    (r.case.qa_history || []).forEach((qa, i) => {
      if (qa.status === "generating") vidStreamingPartial[i] = qa.partial || "";
    });
  });
  es.addEventListener("delta", (e) => {
    const d = JSON.parse(e.data);
    applyVidDelta(d.i, d.text);
  });
  es.addEventListener("stats", (e) => {
    const r = JSON.parse(e.data);
    renderVidRunStats(r.case);
    renderVidE2eMetrics(r.case);
  });
  es.addEventListener("end", () => {
    stopVidCaseStream();
    vidLastE2eRender = 0;
    refreshVidCaseDetail();
  });
  es.onerror = () => {
    stopVidCaseStream();
    vidCaseModalTimer = setInterval(refreshVidCaseDetail, 1500);
  };
}

function stopVidCaseStream() {
  if (vidCaseEventSource) {
    vidCaseEventSource.close();
    vidCaseEventSource = null;
  }
  if (vidCaseModalTimer) {
    clearInterval(vidCaseModalTimer);
    vidCaseModalTimer = null;
  }
}

function applyVidDelta(idx, text) {
  vidStreamingPartial[idx] = (vidStreamingPartial[idx] || "") + text;
  const list = $("vidCaseQaList");
  const el = list.querySelector(`.qa-answer.streaming[data-idx="${idx}"]`);
  if (!el) return;
  const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
  el.innerHTML = renderMarkdown(vidStreamingPartial[idx]) +
    '<span class="qa-cursor">▌</span>';
  if (stick) list.scrollTop = list.scrollHeight;
}

function renderVidCaseDetail(r) {
  renderVidRunStats(r.case);
  renderVidE2eMetrics(r.case);
  renderVidQaList(r.case);
}

function renderVidRunStats(c) {
  $("vidCaseDetailTitle").textContent = `Thread ${c.case_id} 详情`;
  const badge = $("vidCaseDetailBadge");
  badge.textContent = STATUS_TEXT[c.status] || c.status;
  badge.className = "case-status " + c.status;

  const stats = [
    ["状态", STATUS_TEXT[c.status] || c.status],
    ["用时", fmtElapsed(c.elapsed)],
    ["生成字数", (c.chars_generated || 0).toLocaleString()],
    ["错误", `${c.errors} 次`],
    ["进度", `${c.completed_loops}/${c.total_loops} 迭代`],
    ["当前视频", c.current_video || "—"],
    ["平均输入 token", c.prompt_tokens_avg != null
      ? `${c.prompt_tokens_avg.toLocaleString()} token` : "—"],
  ];
  $("vidCaseRunStats").innerHTML = stats.map(([k, v]) =>
    `<div class="detail-item"><span class="detail-k">${k}</span>` +
    `<span class="detail-v">${escapeHtml(String(v))}</span></div>`).join("");
}

function renderVidE2eMetrics(c) {
  const now = Date.now();
  if (now - vidLastE2eRender < 10000) return;
  vidLastE2eRender = now;

  const el = $("vidCaseE2eMetrics");
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

/* qa 列表渲染（视频版：大纲 label 与 meta 均显示视频文件名） */
function renderVidQaList(c) {
  const list = $("vidCaseQaList");
  const qas = c.qa_history || [];
  const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;

  if (!qas.length) {
    $("vidCaseQaOutline").innerHTML = "";
    list.innerHTML = '<div class="qa-empty">暂无调用记录</div>';
    return;
  }
  list.innerHTML = qas.map((qa, idx) => vidQaItemHtml(qa, idx, c)).join("");
  renderVidQaOutline(qas);
  if (vidQaOutlineActive != null) {
    const el = list.querySelector(`.qa-item[data-idx="${vidQaOutlineActive}"]`);
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

function renderVidQaOutline(qas) {
  const outline = $("vidCaseQaOutline");
  const follow = vidQaOutlineActive == null;
  const active = (vidQaOutlineActive != null && vidQaOutlineActive < qas.length)
    ? vidQaOutlineActive : qas.length - 1;
  outline.innerHTML = qas.map((qa, idx) => {
    const label = qa.video || (qa.question || "").slice(0, 14);
    return `<div class="qa-outline-item ${idx === active ? "active" : ""} ${qa.status}" data-idx="${idx}">` +
      `<span class="qa-outline-num">#${idx + 1}</span>` +
      `<span class="qa-outline-label" title="${escapeHtml(qa.video || "")}">${escapeHtml(label)}</span>` +
      (qa.status === "generating" ? '<span class="qa-outline-dot"></span>' : "") +
      `</div>`;
  }).join("");
  if (follow) {
    outline.scrollTop = outline.scrollHeight;
  } else {
    const el = outline.querySelector(`.qa-outline-item[data-idx="${vidQaOutlineActive}"]`);
    if (el) {
      const oRect = outline.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      if (eRect.top < oRect.top) outline.scrollTop -= oRect.top - eRect.top;
      else if (eRect.bottom > oRect.bottom) outline.scrollTop += eRect.bottom - oRect.bottom;
    }
  }
}

function jumpToVidQa(idx) {
  vidQaOutlineActive = idx;
  const list = $("vidCaseQaList");
  const target = list.querySelector(`.qa-item[data-idx="${idx}"]`);
  if (!target) return;
  vidQaJumping = true;
  const lRect = list.getBoundingClientRect();
  const tRect = target.getBoundingClientRect();
  list.scrollTop += tRect.top - lRect.top - 8;
  setTimeout(() => { vidQaJumping = false; }, 100);
  list.querySelectorAll(".qa-jump").forEach(el => el.classList.remove("qa-jump"));
  target.classList.add("qa-jump");
  $("vidCaseQaOutline").querySelectorAll(".qa-outline-item").forEach(el =>
    el.classList.toggle("active", parseInt(el.dataset.idx, 10) === idx));
}

$("vidCaseQaOutline").addEventListener("click", (e) => {
  const item = e.target.closest(".qa-outline-item");
  if (item) jumpToVidQa(parseInt(item.dataset.idx, 10));
});

$("vidCaseQaList").addEventListener("scroll", () => {
  if (vidQaJumping || vidQaOutlineActive == null) return;
  const list = $("vidCaseQaList");
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 40) {
    vidQaOutlineActive = null;
    const items = $("vidCaseQaOutline").querySelectorAll(".qa-outline-item");
    items.forEach(el => el.classList.toggle("active", el === items[items.length - 1]));
  }
});

/* 单条调用记录：视频文件名 + prompt + 实测输入 token + 流式文章 */
function vidQaItemHtml(qa, idx, c) {
  const meta = [escapeHtml(qa.phase)];
  if (qa.loop) meta.push(`第 ${qa.loop}/${c.total_loops} 迭代`);
  if (qa.video) meta.push(`视频「${escapeHtml(qa.video)}」`);
  if (qa.prompt_tokens != null) meta.push(`输入 ${qa.prompt_tokens.toLocaleString()} token`);
  if (qa.duration) meta.push(`${qa.duration}s`);
  if (qa.ttft != null) meta.push(`TTFT ${qa.ttft}s`);

  let answerHtml;
  if (qa.status === "generating") {
    const partial = qa.partial || "";
    const body = partial
      ? renderMarkdown(partial) + '<span class="qa-cursor">▌</span>'
      : '<span class="qa-waiting">已发送视频与指令，等待 LLM 回复</span><span class="qa-cursor">▌</span>';
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

/* ============ 初始化（视频测试） ============ */
(async function initVideoTest() {
  vidDirModal = $("videoDirModal");
  $("btnPickVideoDir").addEventListener("click", openVidDirModal);
  $("btnCloseVidDir").addEventListener("click", closeVidDirModal);
  vidDirModal.addEventListener("click", (e) => {
    if (e.target === vidDirModal) closeVidDirModal();
  });
  $("btnCloseVidCase").addEventListener("click", closeVidCaseModal);
  $("vidCaseModal").addEventListener("click", (e) => {
    if (e.target === $("vidCaseModal")) closeVidCaseModal();
  });
  $("btnVidMoreDetail").addEventListener("click", () => toggleVidQaList());

  await loadVidModelSelect();
  await loadVidHistory();
  // 默认加载程序运行位置的 video 目录（用户尚未选择过目录时）
  const d = await fetchJSON("/api/fs/defaults");
  if (d && d.video_dir) vidDefaultDir = d.video_dir.path;
  if (d && d.video_dir && !vidSelectedDir) {
    vidSelectedDir = d.video_dir.path;
    vidDirVideos = d.video_dir.count;
    vidSelectedCount = d.video_dir.count;
    restoreVidDirLabel();
  }
  // 页面加载时若视频测试在运行，恢复显示并选中侧栏对应任务
  const s = await fetchJSON("/api/tests/video/status");
  if (s && s.test_id && s.status !== "idle") {
    vidCurrentTask = s.task_name || null;
    lastVidTestStatus = s.status;
    renderVidStatus(s);
    renderVidHistoryList();
  }
  if ($("vidModelSelect").value) probeVidSelectedModel();
  restartVidPolling();
})();
