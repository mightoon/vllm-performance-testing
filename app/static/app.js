/* ============ 工具函数 ============ */
const $ = (id) => document.getElementById(id);

async function fetchJSON(url, options = {}) {
  const resp = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return { success: false, error: data.error || `HTTP ${resp.status}` };
  return data;
}

const STATUS_TEXT = {
  pending: "等待中",
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  error: "错误",
  stopped: "已停止",
  idle: "空闲",
};

/* ============ Tab 切换 ============ */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $("panel-" + tab.dataset.tab).classList.add("active");
  });
});

/* ============ 模型配置弹窗 ============ */
const settingsModal = $("settingsModal");
let editingModelId = null;   // null = 添加模式
let formVerified = false;    // 是否已通过连接测试
let editSnapshot = null;     // 编辑模式初始值快照

function openSettings() {
  settingsModal.style.display = "flex";
  switchSettingsTab("models");
  loadModelList();
  loadModelSelect();
  loadPromConfig();
}
function closeSettings() {
  settingsModal.style.display = "none";
  resetForm();
}
$("btnSettings").addEventListener("click", openSettings);
$("btnCloseSettings").addEventListener("click", closeSettings);
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) closeSettings();
});

/* ---- 设置弹窗 tab 切换（大模型配置 / Prometheus） ---- */
function switchSettingsTab(which) {
  document.querySelectorAll(".settings-tab").forEach((b) =>
    b.classList.toggle("active", b.id === (which === "prom" ? "settingsTabBtnProm" : "settingsTabBtnModels")));
  $("settingsTabModels").classList.toggle("active", which !== "prom");
  $("settingsTabProm").classList.toggle("active", which === "prom");
}
$("settingsTabBtnModels").addEventListener("click", () => switchSettingsTab("models"));
$("settingsTabBtnProm").addEventListener("click", () => switchSettingsTab("prom"));

/* ---- Prometheus 配置表单 ---- */
async function loadPromConfig() {
  const r = await fetchJSON("/api/prometheus/config");
  if (r && r.success) {
    $("promUrl").value = (r.config && r.config.url) || "";
    $("promGrafanaUrl").value = (r.config && r.config.grafana_url) || "";
  }
}

$("btnPromTest").addEventListener("click", async () => {
  const url = $("promUrl").value.trim();
  const st = $("promStatus");
  if (!url) { st.textContent = "请先填写 URL"; st.style.color = "var(--danger)"; return; }
  st.textContent = "连接中…"; st.style.color = "var(--text-sub)";
  const r = await fetchJSON("/api/prometheus/test", {
    method: "POST", body: JSON.stringify({ url, grafana_url: "" }),
  });
  if (r && r.success) {
    st.textContent = "连接成功"; st.style.color = "var(--success, #16a34a)";
  } else {
    st.textContent = "连接失败: " + ((r && r.error) || "未知错误");
    st.style.color = "var(--danger)";
  }
});

$("btnPromSave").addEventListener("click", async () => {
  const url = $("promUrl").value.trim();
  const grafana = $("promGrafanaUrl").value.trim();
  const st = $("promStatus");
  if (!url) { st.textContent = "Prometheus URL 不能为空"; st.style.color = "var(--danger)"; return; }
  const r = await fetchJSON("/api/prometheus/config", {
    method: "PUT",
    body: JSON.stringify({ url, grafana_url: grafana }),
  });
  if (r && r.success) {
    st.textContent = "已保存"; st.style.color = "var(--success, #16a34a)";
  } else {
    st.textContent = "保存失败: " + ((r && r.error) || "未知错误");
    st.style.color = "var(--danger)";
  }
});

/* ---- 配置列表 ---- */
async function loadModelList() {
  const models = await fetchJSON("/api/models");
  const list = $("modelList");
  if (!models || !models.length) {
    list.innerHTML = '<div class="manage-empty">暂无配置</div>';
    return;
  }
  list.innerHTML = models
    .map(
      (m) => `
      <div class="manage-item">
        <div class="manage-item-info">
          <div class="manage-item-name">${escapeHtml(m.name)}</div>
          <div class="manage-item-detail">${escapeHtml(m.model)} · ${escapeHtml(m.url)}${m.has_api_key ? " · 🔑" : ""}</div>
        </div>
        <div class="manage-item-actions">
          <button class="btn-edit" data-edit="${m.id}">修改</button>
          <button class="btn-del" data-del="${m.id}">删除</button>
        </div>
      </div>`
    )
    .join("");
  list.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => startEditModel(btn.dataset.edit))
  );
  list.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", () => deleteModel(btn.dataset.del))
  );
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function deleteModel(id) {
  if (!confirm("确定删除该配置吗？")) return;
  await fetchJSON(`/api/models/${id}`, { method: "DELETE" });
  loadModelList();
  loadModelSelect();
}

/* ---- 表单状态机 ---- */
function currentFormValues() {
  return {
    name: $("fName").value.trim(),
    model: $("fModel").value.trim(),
    url: $("fUrl").value.trim(),
    api_key: $("fKey").value,
  };
}

function updateFormButtons() {
  const v = currentFormValues();
  const filled = v.name && v.model && v.url;
  let changed = true;
  if (editingModelId && editSnapshot) {
    changed = JSON.stringify(v) !== JSON.stringify(editSnapshot);
  }
  // 验证按钮：必填项齐全即可用；编辑模式下需有变化
  $("btnVerify").disabled = !filled || (editingModelId && !changed);
  // 保存按钮：已验证通过 且（添加模式必填齐全 / 编辑模式有变化）
  $("btnSaveModel").disabled = !formVerified || !filled || (editingModelId && !changed);
}

function resetForm() {
  editingModelId = null;
  formVerified = false;
  editSnapshot = null;
  $("editModelId").value = "";
  $("formTitle").textContent = "添加配置";
  ["fName", "fModel", "fUrl", "fKey"].forEach((id) => ($(id).value = ""));
  setVerifyStatus("", "");
  updateFormButtons();
}

function setVerifyStatus(text, cls) {
  const el = $("verifyStatus");
  el.textContent = text;
  el.className = "verify-status " + cls;
}

["fName", "fModel", "fUrl", "fKey"].forEach((id) =>
  $(id).addEventListener("input", () => {
    formVerified = false; // 修改后需重新验证
    setVerifyStatus("", "");
    updateFormButtons();
  })
);

// "返回"：关闭设置弹窗（closeSettings 内部会顺带重置表单/退出编辑模式）
$("btnResetForm").addEventListener("click", closeSettings);

/* ---- 编辑模式 ---- */
async function startEditModel(id) {
  const models = await fetchJSON("/api/models");
  const m = (models || []).find((x) => x.id === id);
  if (!m) return;
  const keyResp = await fetchJSON(`/api/models/${id}/apikey`);
  editingModelId = id;
  formVerified = false;
  $("editModelId").value = id;
  $("formTitle").textContent = "修改配置";
  $("fName").value = m.name;
  $("fModel").value = m.model;
  $("fUrl").value = m.url;
  $("fKey").value = keyResp.api_key || "";
  editSnapshot = currentFormValues();
  setVerifyStatus("", "");
  updateFormButtons();
  $("fName").focus();
}

/* ---- 测试连接 ---- */
$("btnVerify").addEventListener("click", async () => {
  const v = currentFormValues();
  if (!v.name || !v.model || !v.url) return;
  formVerified = false;
  setVerifyStatus("测试中...", "loading");
  $("btnVerify").disabled = true;
  const r = await fetchJSON("/api/verify-model", {
    method: "POST",
    body: JSON.stringify(v),
  });
  if (r.success) {
    formVerified = true;
    setVerifyStatus("✓ 连接成功", "success");
  } else {
    formVerified = false;
    setVerifyStatus("✗ " + (r.error || "连接失败"), "error");
  }
  updateFormButtons();
});

/* ---- 保存 ---- */
$("btnSaveModel").addEventListener("click", async () => {
  const v = currentFormValues();
  if (!v.name || !v.model || !v.url) return;
  let r;
  if (editingModelId) {
    r = await fetchJSON(`/api/models/${editingModelId}`, {
      method: "PUT",
      body: JSON.stringify(v),
    });
  } else {
    r = await fetchJSON("/api/models", {
      method: "POST",
      body: JSON.stringify(v),
    });
  }
  if (r.success) {
    resetForm();
    loadModelList();
    loadModelSelect();
  } else {
    setVerifyStatus("✗ " + (r.error || "保存失败"), "error");
  }
});

/* ============ 模型下拉选择（文本测试参数区） ============ */
async function loadModelSelect() {
  const models = await fetchJSON("/api/models");
  const sel = $("textModelSelect");
  const prev = sel.value;
  sel.innerHTML =
    '<option value="" disabled selected>选择模型配置</option>' +
    (models || [])
      .map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`)
      .join("");
  if (prev && (models || []).some((m) => m.id === prev)) sel.value = prev;
}

/* ============ 模型服务端参数探测 ============ */
/* 输入长度档位 → 名义输入 token 数（用于估算理论并发） */
const INPUT_TOKENS = { tiny: 10, short: 100, medium: 1000, long: 8000, xlong: 16000 };
let modelProbe = null;   // 当前选中模型的探测结果 {version, max_model_len, kv_cache_tokens}
let probeSeq = 0;        // 序号：切换模型时丢弃过期响应

/* token 数缩写：≥1M(1024²) 显示 x百万，≥1K(1024) 显示 xK；
   恰为整数不带小数位，否则保留一位（8K / 128K / 256K / 3.3百万） */
function fmtTokens(n) {
  if (n >= 1048576) {
    const v = n / 1048576;
    return (Number.isInteger(v) ? v : v.toFixed(1)) + "百万";
  }
  if (n >= 1024) {
    const v = n / 1024;
    return (Number.isInteger(v) ? v : v.toFixed(1)) + "K";
  }
  return String(n);
}

/* 并发度 label：有 KV 容量数据时显示预估最大并发数（KV容量 ÷ 每请求token） */
function updateConcurrencyHint() {
  const el = $("concurrencyLabel");
  if (!el) return;
  let hint = "并行 Thread 数";
  if (modelProbe && modelProbe.kv_cache_tokens) {
    const inTok = INPUT_TOKENS[$("inputLength").value] || 10;
    const outTok = parseInt($("articleLength").value) || 500;
    const est = Math.floor(modelProbe.kv_cache_tokens / (inTok + outTok));
    hint = est >= 1 ? `预估最大 ~${est.toLocaleString()}` : "预估最大 <1";
  }
  el.textContent = `并发度（${hint}）`;
}

/* 选中模型后探测服务端参数，显示在模型行空白处 */
async function probeSelectedModel() {
  const modelId = $("textModelSelect").value;
  const info = $("modelInfo");
  modelProbe = null;
  updateConcurrencyHint();
  if (!modelId) { info.style.display = "none"; return; }
  const seq = ++probeSeq;
  info.style.display = "flex";
  info.innerHTML = '<span>服务端参数探测中…</span>';
  const r = await fetchJSON(`/api/models/${modelId}/probe`);
  if (seq !== probeSeq) return;   // 已切换到其他模型，丢弃过期响应
  if (r && r.success) {
    modelProbe = r;
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
  updateConcurrencyHint();
}

$("textModelSelect").addEventListener("change", probeSelectedModel);
$("inputLength").addEventListener("change", updateConcurrencyHint);
$("articleLength").addEventListener("input", updateConcurrencyHint);

/* ============ 历史测试侧栏与模式管理 ============
   两种模式：
   - run    运行测试模式（原有实现：轮询实时状态）
   - report 展示报告模式（点击侧栏历史任务，用持久化数据填充参数与指标） */
let textMode = "run";          // "run" | "report"
let textActiveTask = null;     // 报告模式下正在查看的任务名
let textDraftTask = null;      // "新测试"草稿任务名（尚未启动）
let textCurrentTask = null;    // 运行模式当前（或最近）任务名
let textStatusViewTask = null; // 状态视图：从报告返回查看的历史任务名（null=跟随引擎实时状态）
let statusViewResult = null;   // 状态视图缓存的 result.json（供 case 弹窗静态渲染）
let lastHistoryTasks = [];     // 最近一次拉取的历史列表
let lastTestStatus = null;     // 上次轮询到的测试状态（检测结束刷新侧栏）

function genTaskName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `文本测试-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}`;
}

function currentSelectedTask() {
  if (textMode === "report") return textActiveTask;
  return textCurrentTask || textDraftTask;
}

async function loadTextHistory() {
  const r = await fetchJSON("/api/tests/text/history");
  lastHistoryTasks = (r && r.tasks) || [];
  renderHistoryList();
}

const HISTORY_STATUS_TEXT = {
  completed: "已完成", stopped: "已停止", error: "出错",
  running: "运行中", interrupted: "未完成", draft: "草稿",
};

function historyItemHtml(t, selected, isDraft) {
  const p = t.params || {};
  const st = isDraft ? "draft"
    : t.has_result ? (t.status || "completed")
    : t.status === "running" ? "running" : "interrupted";
  const stText = HISTORY_STATUS_TEXT[st] || st;
  let sub;
  if (isDraft) {
    sub = "待填写参数";
  } else {
    // 任务名已含时间戳，副标题只展示 profile 概要
    sub = [p.concurrency != null && `${p.concurrency}并发`,
           p.noun_count != null && `${p.noun_count}名词`,
           p.article_length != null && `${p.article_length} token`]
      .filter(Boolean).join(" · ");
  }
  return `<div class="history-item ${t.name === selected ? "active" : ""}" data-name="${escapeHtml(t.name)}">` +
    (isDraft ? "" : `<button class="history-item-del" title="删除该测试">✕</button>`) +
    `<div class="history-item-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div>` +
    `<div class="history-item-meta">` +
    `<span class="history-item-status ${st}">${stText}</span>` +
    `<span class="history-item-sub">${escapeHtml(sub)}</span></div></div>`;
}

function renderHistoryList() {
  const list = $("textHistoryList");
  const selected = currentSelectedTask();
  let html = "";
  if (textDraftTask) {
    html += historyItemHtml({ name: textDraftTask, params: {} }, selected, true);
  }
  html += lastHistoryTasks.map((t) => historyItemHtml(t, selected, false)).join("");
  list.innerHTML = html || '<div class="history-empty">暂无历史测试</div>';
}

/* 面板标题随模式切换：参数区恒为“测试场景”，状态区 run=测试状态 / report=测试报告 */
function setPanelTitles(mode) {
  $("paramPanelTitle").textContent = "测试场景";
  $("runPanelTitle").textContent = mode === "report" ? "测试报告" : "测试状态";
}

/* 进入运行测试模式：恢复 thread 列表显示与轮询 */
function enterRunMode() {
  textMode = "run";
  textActiveTask = null;
  textStatusViewTask = null;   // 退出状态视图，恢复跟随引擎实时状态
  statusViewResult = null;
  setPanelTitles("run");
  $("btnGenReport").style.display = "none";   // 运行模式隐藏，终态时由 renderStatus 显示
  $("btnBackStatus").style.display = "none";  // 仅报告模式显示
  hideMonitor();   // 监控图表仅报告模式显示
  $("progressList").style.display = "";
  restartPolling();
  renderHistoryList();
}

/* ============ 报告模式监控图表（Prometheus 快照） ============ */
let monitorChartInstances = [];

function disposeMonitorCharts() {
  monitorChartInstances.forEach((c) => c.dispose());
  monitorChartInstances = [];
}

function hideMonitor() {
  disposeMonitorCharts();
  $("monitorArea").style.display = "none";
}

/* 加载监控数据：快照优先 → 实时查询兜底 → 无数据占位 */
async function loadMonitorCharts(taskName, config, result) {
  disposeMonitorCharts();
  reportGpuStats = null;   // 切换任务先清空，避免残留上一任务的资源指标
  const area = $("monitorArea");
  area.style.display = "block";
  $("monitorCards").innerHTML = "";
  $("monitorCharts").innerHTML = "";
  $("monitorEmpty").style.display = "none";
  $("monitorSource").textContent = "";
  updateGrafanaLink(config, result);

  const r = await fetchJSON(`/api/tests/text/history/${encodeURIComponent(taskName)}/metrics`);
  if (!r || !r.success || !r.metrics || !(r.metrics.series || []).length) {
    $("monitorEmpty").style.display = "block";
    return;
  }
  $("monitorSource").textContent = r.source === "live" ? "（实时查询）" : "";
  // 资源指标（DCGM 显存，各卡平均）：来自快照/实时查询的预计算统计，
  // 写回指标区"资源指标"组补渲染（renderReport 首渲染时可能尚无数据）
  const st = r.metrics.stats || {};
  if (st.gpu_fb_usage_avg != null || st.gpu_mem_copy_util_avg != null) {
    reportGpuStats = {
      gpu_fb_usage_avg: st.gpu_fb_usage_avg ?? null,
      gpu_mem_copy_util_avg: st.gpu_mem_copy_util_avg ?? null,
    };
    if (result && result.vllm_metrics_summary) {
      renderVllmBar(result.vllm_metrics_summary, "report");
    }
  }
  renderMonitorCharts(r.metrics, (result || {}).vllm_metrics_summary);
}

/* Grafana 跳转链接（配置了 Grafana URL 时显示，带测试起止时间） */
async function updateGrafanaLink(config, result) {
  const link = $("grafanaLink");
  link.style.display = "none";
  try {
    const r = await fetchJSON("/api/prometheus/config");
    const base = r && r.config && r.config.grafana_url;
    if (!base) return;
    const started = (config && config.started_at) || 0;
    const elapsed = (result && result.elapsed) || 0;
    if (!started || !elapsed) return;
    const from = Math.round(started * 1000);
    const to = Math.round((started + elapsed) * 1000);
    // base 为 dashboard 地址（如 http://host:3000/d/<uid>/<slug>），拼时间范围参数
    const sep = base.includes("?") ? "&" : "?";
    link.href = base.replace(/\/+$/, "") + `${sep}from=${from}&to=${to}`;
    link.style.display = "";
  } catch (e) { /* 链接生成失败不影响图表 */ }
}

/* 渲染统计卡片 + 分组折线图 */
const MONITOR_GROUP_TITLES = {
  concurrency: "并发与排队",
  cache: "KV cache 使用率",
  latency: "首 token 延迟（TTFT）",
  throughput: "生成吞吐",
  preemption: "请求抢占（KV cache 耗尽时调度器强制腾位）",
  phase: "Prefill / Decode 阶段耗时",
  gpu: "GPU 显存（DCGM，各卡平均）",
};
const MONITOR_GROUP_ORDER = ["concurrency", "cache", "latency", "phase", "throughput", "preemption", "gpu"];

function renderMonitorCharts(metrics, summary) {
  const fmt = (v) => v == null ? "—" :
    v.toLocaleString(undefined, { maximumFractionDigits: 1 });

  // 统计卡片（后端预计算）
  const stats = metrics.stats || {};
  // TTFT 分位数卡片：优先整轮区间删失 MLE 拟合值（修正直方图宽桶
  // 线性插值误差）；无拟合数据（旧报告/拟合失败）回退 Prometheus 统计
  const fitP50 = summary && summary.ttft_p50_fit_s != null
    ? summary.ttft_p50_fit_s * 1000 : null;
  const fitP95 = summary && summary.ttft_p95_fit_s != null
    ? summary.ttft_p95_fit_s * 1000 : null;
  const cards = [
    ["平均生成吞吐", fmt(stats.gen_throughput_avg), "tok/s"],
    ["峰值生成吞吐", fmt(stats.gen_throughput_peak), "tok/s"],
    fitP50 != null
      ? ["TTFT p50（拟合）", fmt(fitP50), "ms"]
      : ["平均 TTFT p50", fmt(stats.ttft_p50_avg_ms), "ms"],
    fitP95 != null
      ? ["TTFT p95（拟合）", fmt(fitP95), "ms"]
      : ["峰值 TTFT p95", fmt(stats.ttft_p95_peak_ms), "ms"],
    ["KV cache 峰值", fmt(stats.kv_cache_peak_perc), "%"],
    // 抢占卡片：新报告显示精确累计次数（vLLM counter 差分）；
    // 旧报告/实时监控无该数据时回退显示 Prometheus 抢占速率峰值
    summary && summary.preemptions_total != null
      ? ["累计抢占次数", fmt(summary.preemptions_total), "次"]
      : ["抢占速率峰值", fmt(stats.preemptions_rate_peak), "req/s"],
  ];
  $("monitorCards").innerHTML = cards.map(([label, val, unit]) =>
    `<div class="monitor-card">
       <div class="monitor-card-val">${val}<span class="monitor-card-unit">${unit}</span></div>
       <div class="monitor-card-label">${label}</div>
     </div>`).join("");

  // 分组折线图（同 group 画同一张图）
  const groups = {};
  (metrics.series || []).forEach((s) => {
    (groups[s.group] = groups[s.group] || []).push(s);
  });
  const wrap = $("monitorCharts");
  wrap.innerHTML = "";
  const groupKeys = MONITOR_GROUP_ORDER.filter((g) => groups[g])
    .concat(Object.keys(groups).filter((g) => !MONITOR_GROUP_ORDER.includes(g)));

  // 第一步：先构建全部卡片 DOM（auto-fit 网格需所有卡片就位后才能确定列宽），
  // 暂不 init 图表，避免首图按整行宽度初始化导致溢出重叠
  const pending = [];
  groupKeys.forEach((g) => {
    const seriesList = groups[g];
    const card = document.createElement("div");
    card.className = "monitor-chart-card";
    const title = document.createElement("div");
    title.className = "monitor-chart-title";
    title.textContent = MONITOR_GROUP_TITLES[g] || g;
    const chartEl = document.createElement("div");
    chartEl.className = "monitor-chart";
    card.appendChild(title);
    card.appendChild(chartEl);
    wrap.appendChild(card);

    // 数据变换：时间戳 s → ms（ECharts time 轴用毫秒）；
    // cache 组 0-1 → 百分比；latency 组 s → ms
    const transform = (s) => {
      let data = (s.data || []).map(([t, v]) => [t * 1000, v]);
      if (s.group === "cache") data = data.map(([t, v]) => [t, +(v * 100).toFixed(2)]);
      if (s.group === "latency") data = data.map(([t, v]) => [t, +(v * 1000).toFixed(1)]);
      return data;
    };
    const unit = seriesList[0].unit === "%" ? "%" :
      (g === "latency" ? "ms" : seriesList[0].unit);

    // phase 组双 Y 轴：Prefill 耗时远小于 Decode，共用一根轴时 Prefill 曲线
    // 会贴着 x 轴看不出走势 → Prefill 走左轴、Decode 走右轴，各自独立刻度。
    // 轴与曲线颜色绑定（蓝=Prefill，绿=Decode），p50 浅色 / p95 深色
    const isPrefill = (s) => /^prefill/i.test(s.legend);
    const dualAxis = g === "phase" &&
      seriesList.some(isPrefill) && seriesList.some((s) => !isPrefill(s));
    const phaseColor = (s) => {
      const deep = /p95/i.test(s.legend);
      return isPrefill(s) ? (deep ? "#2563eb" : "#93c5fd")
                          : (deep ? "#16a34a" : "#86efac");
    };

    // 单轴公共配置（非双轴组沿用）
    const axisCommon = {
      type: "value",
      nameGap: 10,
      scale: g !== "cache",
      max: g === "cache" ? 100 : undefined,
      axisLabel: {
        formatter: (v) => v >= 10000 ? (v / 1000) + "k" : v,
      },
    };
    let yAxis;
    if (dualAxis) {
      yAxis = [
        { ...axisCommon, name: `Prefill (${unit})`, position: "left",
          nameTextStyle: { color: "#2563eb", fontSize: 11 },
          axisLabel: { ...axisCommon.axisLabel, color: "#2563eb" } },
        { ...axisCommon, name: `Decode (${unit})`, position: "right",
          nameTextStyle: { color: "#16a34a", fontSize: 11 },
          axisLabel: { ...axisCommon.axisLabel, color: "#16a34a" },
          splitLine: { show: false } },   // 只保留左轴网格线，避免两套横线交叉
      ];
    } else {
      yAxis = { ...axisCommon, name: unit,
        nameTextStyle: { color: "#94a3b8", fontSize: 11 } };
    }

    pending.push({
      el: chartEl,
      option: {
        animation: false,
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "none" },   // 仅保留浮动信息窗，不画十字指示线与轴刻度
          valueFormatter: (v) => v == null ? "—" : `${(+v).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`,
        },
        legend: seriesList.length > 1 ? { bottom: 0, icon: "rect", itemWidth: 14, itemHeight: 4 } : undefined,
        // 底部留白统一 56px：有图例时时间轴上移避开图例，无图例时同高对齐；
        // 双轴时右侧需给右轴刻度留位
        grid: { left: 56, right: dualAxis ? 56 : 24, top: 32, bottom: 56 },
        xAxis: {
          type: "time",
          axisLabel: { hideOverlap: true, formatter: "{HH}:{mm}:{ss}" },
        },
        yAxis,
        series: seriesList.map((s) => ({
          name: s.legend,
          type: "line",
          showSymbol: false,
          data: transform(s),
          lineStyle: { width: 1.6 },
          emphasis: { focus: "series" },
          ...(dualAxis ? { yAxisIndex: isPrefill(s) ? 0 : 1, color: phaseColor(s) } : {}),
        })),
      },
    });
  });

  // 第二步：布局稳定后再初始化图表（canvas 尺寸与卡片一致）
  requestAnimationFrame(() => {
    pending.forEach(({ el, option }) => {
      if (!el.isConnected) return;  // DOM 已被重建（快速切换任务）则跳过
      const chart = echarts.init(el);
      monitorChartInstances.push(chart);
      chart.setOption(option);
      chart.resize();
    });
  });
}

window.addEventListener("resize", () => {
  monitorChartInstances.forEach((c) => c.resize());
});

/* 进入展示报告模式：停止轮询，用持久化数据填充参数与指标 */
async function enterReportMode(taskName) {
  textMode = "report";
  textActiveTask = taskName;
  textDraftTask = null;
  textStatusViewTask = null;   // 离开状态视图
  statusViewResult = null;
  setPanelTitles("report");
  $("btnGenReport").style.display = "none";   // 已在报告页，无需该入口
  $("btnBackStatus").style.display = "";      // 报告页提供"返回测试状态"入口
  // 不停止轮询：报告模式下 pollStatus 仅跟踪后台测试是否结束（刷新侧栏状态），不触碰报告显示
  closeCaseModal();
  const r = await fetchJSON(`/api/tests/text/history/${encodeURIComponent(taskName)}`);
  if (!r || !r.success) return alert((r && r.error) || "加载历史任务失败");
  renderReport(r.config || {}, r.result || {});
  loadMonitorCharts(taskName, r.config || {}, r.result || {});
  renderHistoryList();
}

/* 从报告页返回该任务"测试结束时的状态页"：用持久化 result 重建终态视图。
   与 enterRunMode 的区别：显示的是历史任务的终态而非引擎实时状态，
   pollStatus 不覆盖显示、case 弹窗用缓存数据静态渲染（不请求引擎）。 */
async function enterStatusView(taskName) {
  textMode = "run";
  textActiveTask = null;
  textDraftTask = null;
  textCurrentTask = taskName;   // 侧栏高亮与"生成报告"入口对齐该任务
  textStatusViewTask = taskName;
  statusViewResult = null;
  setPanelTitles("run");
  $("btnBackStatus").style.display = "none";   // 已在状态页
  closeCaseModal();
  hideMonitor();   // 监控图表仅报告模式显示
  $("progressList").style.display = "";
  const r = await fetchJSON(`/api/tests/text/history/${encodeURIComponent(taskName)}`);
  if (!r || !r.success) return alert((r && r.error) || "加载历史任务失败");
  statusViewResult = r.result || {};
  lastVllmBarRender = 0;        // 绕过 15s 节流，首次进入立即渲染 vLLM 指标条
  renderStatus(statusViewResult);
  renderHistoryList();
}

/* 报告渲染：参数 panel 填充当时 profile；指标区填充当时数值；隐藏 thread 列表 */
function renderReport(config, result) {
  const p = config.params || {};
  // 模型下拉：若该模型配置已被删除，插入占位项以便显示与复用
  const sel = $("textModelSelect");
  if (p.model_id && ![...sel.options].some((o) => o.value === p.model_id)) {
    const opt = document.createElement("option");
    opt.value = p.model_id;
    opt.textContent = (config.model && config.model.name) || p.model_name || p.model_id;
    sel.appendChild(opt);
  }
  sel.value = p.model_id || "";
  // 旧任务无 input_length 字段时回退「极短」（与旧行为一致）
  $("inputLength").value = p.input_length || "tiny";
  $("nounCount").value = p.noun_count ?? "";
  $("articleLength").value = p.article_length ?? "";
  $("concurrency").value = p.concurrency ?? "";
  // 历史模型同样触发服务端参数探测（探测条反映该模型当前的服务端状态；
  // 放在参数填充之后，确保并发度预估使用历史输入/输出长度）
  probeSelectedModel();

  // Profile 区域：启动时刻的参数与服务端参数快照（config 持久化，不随
  // 实时探测变化；旧任务无 model_probe 字段时对应项显示 "—"）
  const pr = config.model_probe || {};
  const lenLabels = { tiny: "极短（~10 token）", short: "短（~100 token）",
    medium: "中（~1k token）", long: "长（~8k token）", xlong: "超长（~16k token）" };
  const profileRows = [
    ["模型", escapeHtml((config.model && config.model.name) || p.model_name || p.model_id || "—")],
    ["vLLM 版本", pr.version ? escapeHtml(pr.version) : "—"],
    ["最大上下文", pr.max_model_len ? fmtTokens(pr.max_model_len) + " token" : "—"],
    ["KV cache 容量", pr.kv_cache_tokens ? fmtTokens(pr.kv_cache_tokens) + " token" : "—"],
    ["迭代次数", p.noun_count ?? "—"],
    ["输入长度", lenLabels[p.input_length] || p.input_length || "—"],
    ["输出长度", p.article_length != null ? `${p.article_length} token` : "—"],
    ["并发度", p.concurrency ?? "—"],
  ];
  $("profileBarItems").innerHTML = profileRows.map(([k, v]) =>
    `<div class="detail-item"><span class="detail-k">${k}</span>` +
    `<span class="detail-v">${v}</span></div>`).join("");
  $("profileBar").style.display = "block";

  // 指标区：汇总 + vLLM 指标条
  const sum = result.summary || {};
  $("runEmpty").style.display = "none";
  $("runSummary").style.display = "flex";
  $("sumStatus").innerHTML = `状态: <b>${STATUS_TEXT[result.status] || result.status || "未完成"}</b>`;
  $("sumElapsed").innerHTML = `用时: <b>${fmtElapsed(result.elapsed || 0)}</b>`;
  $("sumCalls").innerHTML = `总调用: <b>${sum.total_calls ?? "—"}</b>`;
  $("sumErrors").innerHTML = `错误: <b style="color:${sum.total_errors ? "var(--danger)" : "inherit"}">${sum.total_errors ?? "—"}</b>`;
  $("sumChars").innerHTML = `生成字数: <b>${(sum.total_chars ?? 0).toLocaleString()}</b>`;
  lastVllmBarRender = 0;   // 报告模式不受节流限制，立即渲染
  // 优先展示整轮统计；旧版报告（无统计数据）回退到最后一次快照
  renderVllmBar(result.vllm_metrics_summary || result.vllm_metrics,
                result.vllm_metrics_summary ? "report" : "legacy");

  // 报告模式：移除 thread 进度条区域
  $("progressList").style.display = "none";

  // 按钮保留：可按相同 profile 再次运行
  setRunningUI(false);
}

/* 删除历史测试：后端删除 workspace/<任务名>/ 目录（含结果与监控快照） */
async function deleteHistoryTask(name) {
  if (!confirm(`确定删除「${name}」？\n该测试在 workspace 目录中的数据将一并删除，不可恢复。`)) return;
  const r = await fetchJSON(`/api/tests/text/history/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!r || !r.success) return alert((r && r.error) || "删除失败");
  // 删除的是当前正在查看的任务：退出报告/状态视图，回到运行模式
  if (textActiveTask === name || textStatusViewTask === name) {
    enterRunMode();
  }
  if (textCurrentTask === name) textCurrentTask = null;
  await loadTextHistory();   // 重新拉取列表刷新侧栏
}

/* 侧栏点击：删除按钮→删除任务；草稿项→运行模式；运行中任务→回到实时监控；已结束任务→报告模式 */
$("textHistoryList").addEventListener("click", (e) => {
  // 删除按钮优先处理，且不触发条目的"查看"行为
  const del = e.target.closest(".history-item-del");
  if (del) {
    const item = del.closest(".history-item");
    if (item) deleteHistoryTask(item.dataset.name);
    return;
  }
  const item = e.target.closest(".history-item");
  if (!item) return;
  if (textMode === "run" && item.dataset.name === textDraftTask) {
    return;   // 草稿已处于运行模式
  }
  const name = item.dataset.name;
  const task = lastHistoryTasks.find((t) => t.name === name);
  if (task && task.status === "running") {
    // 正在运行的任务：回到运行模式恢复实时刷新（放弃未启动的草稿，表单参数保留）
    textDraftTask = null;
    textCurrentTask = name;   // 先行对齐侧栏高亮，pollStatus 随后以权威数据校正
    enterRunMode();
    pollStatus();   // 立即刷新一次，不等首个轮询周期
    return;
  }
  enterReportMode(name);
});

/* 新测试：进入运行模式，侧栏生成草稿任务，参数区留空待填写 */
$("btnNewTextTest").addEventListener("click", () => {
  textDraftTask = genTaskName();
  textMode = "run";
  textActiveTask = null;
  setPanelTitles("run");
  textCurrentTask = null;   // 清除最近任务，避免轮询回显旧结果、侧栏高亮旧任务
  // 参数区留空
  $("textModelSelect").value = "";
  $("inputLength").value = "tiny";
  $("nounCount").value = "";
  $("articleLength").value = "";
  $("concurrency").value = "";
  probeSelectedModel();   // 模型已清空：隐藏探测条并复位并发度 label
  // 运行模式空状态：清空上次测试的 thread 进度行（注意 runEmpty 是 progressList 子元素，不能 innerHTML=""）
  $("progressList").style.display = "";
  $("progressList").querySelectorAll(".case-row").forEach((r) => r.remove());
  $("runSummary").style.display = "none";
  $("vllmBar").style.display = "none";
  $("profileBar").style.display = "none";
  $("runEmpty").style.display = "block";
  $("btnGenReport").style.display = "none";   // 草稿模式隐藏"生成报告"入口
  $("btnBackStatus").style.display = "none";  // 草稿模式隐藏"返回状态"入口
  textStatusViewTask = null;                  // 退出状态视图，恢复轮询渲染
  statusViewResult = null;
  hideMonitor();   // 监控图表仅报告模式显示
  setRunningUI(false);
  restartPolling();
  renderHistoryList();
});

/* ============ 文本测试运行控制 ============ */
let pollTimer = null;
let currentInterval = 3;

$("btnRunText").addEventListener("click", async () => {
  const modelId = $("textModelSelect").value;
  if (!modelId) return alert("请先选择模型配置");
  const payload = {
    model_id: modelId,
    input_length: $("inputLength").value || "tiny",
    noun_count: parseInt($("nounCount").value) || 5,
    article_length: parseInt($("articleLength").value) || 500,
    concurrency: parseInt($("concurrency").value) || 2,
  };
  const r = await fetchJSON("/api/tests/text/start", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!r.success) return alert(r.error || "启动失败");
  // 草稿落地为真实任务（后端生成权威任务名），转入运行测试模式
  textDraftTask = null;
  textCurrentTask = r.task_name || null;
  enterRunMode();
  // 清掉上一任务残留的进度行与汇总（并发数变小时尤为明显），首次轮询返回前显示空态
  $("progressList").querySelectorAll(".case-row").forEach((row) => row.remove());
  $("runSummary").style.display = "none";
  $("vllmBar").style.display = "none";
  $("profileBar").style.display = "none";
  $("runEmpty").style.display = "block";
  setRunningUI(true);
  pollStatus(); // 立即刷新一次
  loadTextHistory(); // 侧栏顶部出现新任务
});

$("btnStopText").addEventListener("click", async () => {
  await fetchJSON("/api/tests/text/stop", { method: "POST" });
  pollStatus();
});

/* 一键生成报告：当前任务已结束，直接转入其报告页 */
$("btnGenReport").addEventListener("click", () => {
  if (textCurrentTask) enterReportMode(textCurrentTask);
});

/* 从报告页返回该任务测试结束时的状态页 */
$("btnBackStatus").addEventListener("click", () => {
  if (textActiveTask) enterStatusView(textActiveTask);
});

function setRunningUI(running) {
  $("btnRunText").disabled = running;
  $("btnStopText").disabled = !running;
}

/* ============ 刷新间隔控制 ============ */
$("refreshInterval").addEventListener("change", () => {
  const v = $("refreshInterval").value;
  if (v === "custom") {
    $("customInterval").style.display = "inline-block";
    currentInterval = parseInt($("customInterval").value) || 3;
  } else {
    $("customInterval").style.display = "none";
    currentInterval = parseInt(v);
  }
  restartPolling();
});

$("customInterval").addEventListener("input", () => {
  const v = parseInt($("customInterval").value);
  if (v >= 1 && v <= 3600) {
    currentInterval = v;
    restartPolling();
  }
});

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollStatus, currentInterval * 1000);
}

/* ============ 状态轮询与进度条渲染 ============ */
let lastVllmBarRender = 0;   // vLLM 指标条上次渲染时刻（节流，不低于 15s 一次）

async function pollStatus() {
  const s = await fetchJSON("/api/tests/text/status");
  if (s && s.test_id) {
    // 测试刚结束（running → 终态）：result.json 已写入，刷新侧栏状态
    // （报告模式同样需要：让侧栏"运行中"标记及时更新）
    if (lastTestStatus === "running" && s.status !== "running") {
      loadTextHistory();
    }
    lastTestStatus = s.status;
  }
  if (textMode !== "run") return;   // 报告模式：仅跟踪后台测试状态，不覆盖报告显示
  if (textStatusViewTask) return;   // 状态视图：显示历史任务终态，不被引擎实时状态覆盖
  // 草稿模式（已点"新测试"但尚未启动）：运行状态区保持清空，不回显上次测试结果
  if (textDraftTask && !textCurrentTask) {
    $("btnGenReport").style.display = "none";
    return;
  }
  if (!s || !s.test_id) {
    $("btnGenReport").style.display = "none";
    $("runEmpty").style.display = "block";
    $("vllmBar").style.display = "none";
    $("profileBar").style.display = "none";
    return;
  }
  if (s.task_name) textCurrentTask = s.task_name;
  renderStatus(s);
}

function renderStatus(s) {
  setRunningUI(s.status === "running");
  $("profileBar").style.display = "none";   // Profile 仅报告模式显示
  // 测试到达终态：标题旁显示"生成报告"入口，一键转报告页
  $("btnGenReport").style.display = (s.status !== "running" && textCurrentTask) ? "" : "none";

  // vLLM 指标条：随状态轮询刷新，但频率不低于 15s（数据由 status 接口顺带返回，无额外请求）
  const now = Date.now();
  const minMs = Math.max(currentInterval, 15) * 1000;
  if (now - lastVllmBarRender >= minMs) {
    lastVllmBarRender = now;
    renderVllmBar(s.vllm_metrics);
  }

  // 汇总信息
  const sum = s.summary;
  $("runSummary").style.display = "flex";
  $("sumStatus").innerHTML = `状态: <b>${STATUS_TEXT[s.status] || s.status}</b>`;
  $("sumElapsed").innerHTML = `已用时: <b>${fmtElapsed(s.elapsed)}</b>`;
  $("sumCalls").innerHTML = `总调用: <b>${sum.total_calls}</b>`;
  $("sumErrors").innerHTML = `错误: <b style="color:${sum.total_errors ? "var(--danger)" : "inherit"}">${sum.total_errors}</b>`;
  $("sumChars").innerHTML = `生成字数: <b>${sum.total_chars.toLocaleString()}</b>`;

  // 进度条列表
  const list = $("progressList");
  $("runEmpty").style.display = "none";
  const rows = list.querySelectorAll(".case-row");
  // 本次 case 数比上次少时，移除残留旧行（如上次 10 并发、本次 2 并发）
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
            <span class="case-noun"></span>
          </div>
          <div class="case-row-right"></div>
        </div>
        <div class="progress-track">
          <div class="progress-fill"><div class="progress-text"></div></div>
        </div>`;
      list.appendChild(row);
    }
    row.dataset.caseId = c.case_id;
    // 状态徽章
    const badge = row.querySelector(".case-status");
    badge.textContent = STATUS_TEXT[c.status] || c.status;
    badge.className = "case-status " + c.status;
    // 当前名词
    row.querySelector(".case-noun").textContent =
      c.status === "running" && c.current_noun ? `当前名词: ${c.current_noun}` : "";
    // 进度填充
    const total = c.total_loops || s.params.noun_count || 1;
    const pct = Math.round((c.completed_loops / total) * 100);
    const fill = row.querySelector(".progress-fill");
    fill.style.width = pct + "%";
    fill.className = "progress-fill " + (c.status === "error" ? "error" : c.status === "completed" ? "completed" : c.status === "stopped" ? "stopped" : "");
    row.querySelector(".progress-text").textContent =
      `迭代 ${c.completed_loops}/${total}（${pct}%）`;
    // 右侧统计：错误数可悬浮查看明细
    row.querySelector(".case-row-right").innerHTML =
      `调用 ${c.calls_done} 次` +
      (c.errors
        ? ` · <span class="err-count">错误 ${c.errors}${buildErrorTooltip(c)}</span>`
        : "");
  });
}

/* ==================== Case 详情弹窗 ==================== */

let caseModalCaseId = null;
let caseEventSource = null;   // SSE 实时流（运行中的 case）
let caseModalTimer = null;    // SSE 不可用时的降级轮询
let qaExpanded = false;
let streamingPartial = {};    // idx -> 已收到的流式文本（增量追加，避免整段重绘）
let lastE2eRender = 0;        // 端到端指标上次渲染时刻（固定 10s 节流）
let qaOutlineActive = null;   // 大纲中用户选中的问题 idx（null = 跟随最新）
let qaJumping = false;        // 大纲定位引发的程序滚动，不触发"回到底部即恢复跟随"

// 点击状态标签打开详情弹窗（事件委托：行是动态创建的）
$("progressList").addEventListener("click", (e) => {
  const badge = e.target.closest(".case-status");
  if (!badge) return;
  const row = badge.closest(".case-row");
  const id = row && parseInt(row.dataset.caseId, 10);
  if (id) openCaseModal(id);
});

function openCaseModal(caseId) {
  caseModalCaseId = caseId;
  $("caseModal").style.display = "flex";
  lastE2eRender = 0;           // 打开弹窗立即渲染一次端到端指标
  qaOutlineActive = null;      // 大纲恢复"跟随最新"模式
  toggleQaList(true);          // 打开即展开细节（运行中流式 / 已完成全量）
  if (textStatusViewTask) {
    // 状态视图（历史任务终态）：用缓存 result 静态渲染，不请求引擎实时数据
    const c = ((statusViewResult && statusViewResult.cases) || [])
      .find((x) => x.case_id === caseId);
    if (c) renderCaseDetail({ case: c });
    return;
  }
  refreshCaseDetail();
}

function closeCaseModal() {
  $("caseModal").style.display = "none";
  stopCaseStream();
  caseModalCaseId = null;
}

$("btnCloseCase").addEventListener("click", closeCaseModal);
$("caseModal").addEventListener("click", (e) => {
  if (e.target === $("caseModal")) closeCaseModal();   // 点遮罩关闭
});

function toggleQaList(force) {
  qaExpanded = force !== undefined ? force : !qaExpanded;
  $("caseQaWrap").style.display = qaExpanded ? "flex" : "none";
  $("btnMoreDetail").textContent = qaExpanded ? "收起细节 ▾" : "更多细节 ▸";
}
$("btnMoreDetail").addEventListener("click", () => toggleQaList());

async function refreshCaseDetail() {
  if (!caseModalCaseId) return;
  const r = await fetchJSON(`/api/tests/text/case/${caseModalCaseId}`);
  if (!r || !r.success) {
    closeCaseModal();
    return;
  }
  renderCaseDetail(r);
  // 测试仍在运行且该 case 未结束：建立实时流（SSE 推送增量）
  const running = r.test_status === "running" &&
    !["completed", "error", "stopped"].includes(r.case.status);
  if (running && !caseEventSource && !caseModalTimer) startCaseStream();
}

/* ---- 实时流：SSE 推送（快照/文本增量/指标），失败自动降级轮询 ---- */
function startCaseStream() {
  stopCaseStream();
  if (!caseModalCaseId || typeof EventSource === "undefined") {
    caseModalTimer = setInterval(refreshCaseDetail, 1500);
    return;
  }
  const es = new EventSource(`/api/tests/text/case/${caseModalCaseId}/stream`);
  caseEventSource = es;

  // 快照：qa 结构变化（新问答开始/结束）时整表重建
  es.addEventListener("snapshot", (e) => {
    const r = JSON.parse(e.data);
    renderCaseDetail(r);
    streamingPartial = {};
    (r.case.qa_history || []).forEach((qa, i) => {
      if (qa.status === "generating") streamingPartial[i] = qa.partial || "";
    });
  });
  // 增量：正在生成的回答，仅追加文本，不重绘整表 → 平滑流式效果
  es.addEventListener("delta", (e) => {
    const d = JSON.parse(e.data);
    applyDelta(d.i, d.text);
  });
  // 指标：每 5s 刷新运行数据；端到端性能指标内部按 10s 节流
  es.addEventListener("stats", (e) => {
    const r = JSON.parse(e.data);
    renderRunStats(r.case);
    renderE2eMetrics(r.case);
  });
  // 结束：拉取最终完整状态后停止（重置节流，保证最终指标立即渲染）
  es.addEventListener("end", () => {
    stopCaseStream();
    lastE2eRender = 0;
    refreshCaseDetail();
  });
  // 连接异常（服务重启等）：降级为轮询兜底
  es.onerror = () => {
    stopCaseStream();
    caseModalTimer = setInterval(refreshCaseDetail, 1500);
  };
}

function stopCaseStream() {
  if (caseEventSource) {
    caseEventSource.close();
    caseEventSource = null;
  }
  if (caseModalTimer) {
    clearInterval(caseModalTimer);
    caseModalTimer = null;
  }
}

/* 将文本增量追加到正在生成的回答上（只重渲染该条，不重绘列表） */
function applyDelta(idx, text) {
  streamingPartial[idx] = (streamingPartial[idx] || "") + text;
  const list = $("caseQaList");
  const el = list.querySelector(`.qa-answer.streaming[data-idx="${idx}"]`);
  if (!el) return;   // 该条不在当前 DOM 中（等下一次快照重建）
  const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
  el.innerHTML = renderMarkdown(streamingPartial[idx]) +
    '<span class="qa-cursor">▌</span>';
  if (stick) list.scrollTop = list.scrollHeight;
}

function renderCaseDetail(r) {
  renderRunStats(r.case);
  renderE2eMetrics(r.case);
  renderQaList(r.case);
}

function renderRunStats(c) {
  $("caseDetailTitle").textContent = `Thread ${c.case_id} 详情`;
  const badge = $("caseDetailBadge");
  badge.textContent = STATUS_TEXT[c.status] || c.status;
  badge.className = "case-status " + c.status;

  // ---- 运行数据 ----
  const stats = [
    ["状态", STATUS_TEXT[c.status] || c.status],
    ["用时", fmtElapsed(c.elapsed)],
    ["生成字数", c.chars_generated.toLocaleString()],
    ["错误", `${c.errors} 次`],
    ["进度", `${c.completed_loops}/${c.total_loops} 迭代`],
    ["当前名词", c.current_noun || "—"],
  ];
  $("caseRunStats").innerHTML = stats.map(([k, v]) =>
    `<div class="detail-item"><span class="detail-k">${k}</span>` +
    `<span class="detail-v">${escapeHtml(String(v))}</span></div>`).join("");
}

/* 端到端性能指标（客户端测量：TTFT/TPOT/吞吐），固定 10s 节流刷新 */
function renderE2eMetrics(c) {
  const now = Date.now();
  if (now - lastE2eRender < 10000) return;
  lastE2eRender = now;

  const el = $("caseE2eMetrics");
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

/* vLLM 服务端指标方块（测试状态区域内，全局指标不区分 case；样式与弹窗指标方块一致）
   mode="live"：运行模式，展示实时快照（平铺）；
   mode="report"：报告模式，按 业务/技术/资源/统计 四组展示整轮统计；
   mode="legacy"：旧版报告（无统计数据），回退到最后一次快照（平铺）
   资源组（DCGM 显存）数据来自 Prometheus 快照/实时查询，经
   loadMonitorCharts 写入 reportGpuStats 后补渲染 */
let reportGpuStats = null;   // {gpu_fb_usage_avg, gpu_mem_copy_util_avg}，各卡平均

function vllmGridHtml(rows) {
  return '<div class="detail-grid vllm-grid">' + rows.map(([k, v]) =>
    `<div class="detail-item"><span class="detail-k">${k}</span>` +
    `<span class="detail-v">${v}</span></div>`).join("") + "</div>";
}

function renderVllmBar(m, mode = "live") {
  const bar = $("vllmBar");
  const el = $("vllmBarItems");
  bar.style.display = "block";
  $("vllmBarTitle").textContent =
    mode === "live" ? "vLLM 指标（快照）" : "服务端指标";
  if (!m) {
    el.innerHTML = '<div class="detail-item"><span class="detail-v">' +
      (mode === "live" ? "指标采集中…" : "暂无指标数据") + '</span></div>';
    return;
  }
  if (m.error) {
    el.innerHTML = '<div class="detail-item"><span class="detail-v">' +
      `采集失败: ${escapeHtml(m.error)}</span></div>`;
    return;
  }
  const pct = (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
  const pctRaw = (v) => (v == null ? "—" : v.toFixed(1) + "%");   // 原始已是百分比
  const num = (v) => (v == null ? "—" :
    v.toLocaleString(undefined, { maximumFractionDigits: 2 }));
  if (mode === "report") {
    // 整轮统计四组：业务（时延/并发）→ 技术（引擎/缓存）→ 资源（GPU 显存）
    // → 统计（token 累计）。请求类取峰值，吞吐/缓存占用取均值；TTFT/TPOT/
    // E2E/命中率为终值差分（请求等权），tokens/抢占为累计值
    const g = reportGpuStats || {};
    const groups = [
      ["业务指标 · 时延与并发", [
        ["平均首 token 延迟", m.ttft_avg_s == null ? "—" : `${m.ttft_avg_s} s`],
        ["平均逐 token 延迟", m.tpot_avg_s == null ? "—" : `${m.tpot_avg_s} s/tok`],
        ["端到端延迟", m.e2e_avg_s == null ? "—" : `${m.e2e_avg_s} s`],
        ["运行中请求峰值", num(m.running_requests_max)],
        ["排队请求峰值", num(m.waiting_requests_max)],
      ]],
      ["技术指标 · 吞吐与引擎", [
        ["平均生成吞吐", m.gen_throughput_toks_avg == null ? "—" : `${num(m.gen_throughput_toks_avg)} tok/s`],
        ["平均 Prefill 耗时", m.prefill_avg_s == null ? "—" : `${m.prefill_avg_s} s`],
        ["平均 Decode 耗时", m.decode_avg_s == null ? "—" : `${m.decode_avg_s} s`],
        ["平均 KV 缓存占用", pct(m.gpu_cache_usage_avg)],
        ["平均前缀缓存命中", pct(m.prefix_cache_hit_rate_avg)],
        ["累计抢占次数", num(m.preemptions_total)],
      ]],
      ["资源指标 · GPU 显存（各卡平均）", [
        ["显存使用率", pctRaw(g.gpu_fb_usage_avg)],
        ["显存控制器使用率", pctRaw(g.gpu_mem_copy_util_avg)],
      ]],
      ["统计指标 · Token 累计", [
        ["累计输入 tokens", num(m.prompt_tokens_total)],
        ["累计生成 tokens", num(m.generation_tokens_total)],
      ]],
    ];
    el.innerHTML = groups.map(([title, rows]) =>
      `<div class="vllm-group-title">${title}</div>` + vllmGridHtml(rows)).join("");
    return;
  }
  const rows = [
    ["运行中请求", num(m.running_requests)],
    ["排队请求", num(m.waiting_requests)],
    ["生成吞吐", m.gen_throughput_toks == null ? "—" : `${num(m.gen_throughput_toks)} tok/s`],
    ["KV 缓存占用", pct(m.gpu_cache_usage)],
    ["前缀缓存命中", pct(m.prefix_cache_hit_rate)],
    ["平均首 token 延迟", m.ttft_avg_s == null ? "—" : `${m.ttft_avg_s} s`],
    ["平均逐 token 延迟", m.tpot_avg_s == null ? "—" : `${m.tpot_avg_s} s/tok`],
    ["平均 Prefill 耗时", m.prefill_avg_s == null ? "—" : `${m.prefill_avg_s} s`],
    ["平均 Decode 耗时", m.decode_avg_s == null ? "—" : `${m.decode_avg_s} s`],
    ["端到端延迟", m.e2e_avg_s == null ? "—" : `${m.e2e_avg_s} s`],
    ["累计输入 tokens", num(m.prompt_tokens_total)],
    ["累计生成 tokens", num(m.generation_tokens_total)],
    ["累计抢占次数", num(m.preemptions_total)],
  ];
  el.innerHTML = vllmGridHtml(rows);
}


function renderQaList(c) {
  const list = $("caseQaList");
  const qas = c.qa_history || [];
  // 流式重绘时保持贴底滚动（用户主动上滚则不干扰）
  const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;

  if (!qas.length) {
    $("caseQaOutline").innerHTML = "";
    list.innerHTML = '<div class="qa-empty">暂无问答记录</div>';
    return;
  }
  list.innerHTML = qas.map((qa, idx) => qaItemHtml(qa, idx, c)).join("");
  renderQaOutline(qas);
  if (qaOutlineActive != null) {
    // 用户已选中某问题：重绘后恢复高亮与滚动位置（不被流式拽走）
    const el = list.querySelector(`.qa-item[data-idx="${qaOutlineActive}"]`);
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

/* 左侧问题大纲：每条问答一行（#序号 + 名词摘要 + 生成中脉冲点）。
   未选中时跟随最新（贴底），选中后保持选中项可见 */
function renderQaOutline(qas) {
  const outline = $("caseQaOutline");
  const follow = qaOutlineActive == null;
  const active = (qaOutlineActive != null && qaOutlineActive < qas.length)
    ? qaOutlineActive : qas.length - 1;
  outline.innerHTML = qas.map((qa, idx) => {
    const label = qa.noun || (qa.question || "").slice(0, 14);
    return `<div class="qa-outline-item ${idx === active ? "active" : ""} ${qa.status}" data-idx="${idx}">` +
      `<span class="qa-outline-num">#${idx + 1}</span>` +
      `<span class="qa-outline-label" title="${escapeHtml(qa.question || "")}">${escapeHtml(label)}</span>` +
      (qa.status === "generating" ? '<span class="qa-outline-dot"></span>' : "") +
      `</div>`;
  }).join("");
  if (follow) {
    outline.scrollTop = outline.scrollHeight;   // 跟随：最新问题保持可见
  } else {
    const el = outline.querySelector(`.qa-outline-item[data-idx="${qaOutlineActive}"]`);
    if (el) {   // 选中：保持选中项在大纲可视区内
      const oRect = outline.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      if (eRect.top < oRect.top) outline.scrollTop -= oRect.top - eRect.top;
      else if (eRect.bottom > oRect.bottom) outline.scrollTop += eRect.bottom - oRect.bottom;
    }
  }
}

/* 点击大纲项：右侧列表滚动定位到对应问答并高亮 */
function jumpToQa(idx) {
  qaOutlineActive = idx;
  const list = $("caseQaList");
  const target = list.querySelector(`.qa-item[data-idx="${idx}"]`);
  if (!target) return;
  qaJumping = true;   // 程序滚动期间不触发"回到底部恢复跟随"
  const lRect = list.getBoundingClientRect();
  const tRect = target.getBoundingClientRect();
  list.scrollTop += tRect.top - lRect.top - 8;
  setTimeout(() => { qaJumping = false; }, 100);
  list.querySelectorAll(".qa-jump").forEach(el => el.classList.remove("qa-jump"));
  target.classList.add("qa-jump");
  $("caseQaOutline").querySelectorAll(".qa-outline-item").forEach(el =>
    el.classList.toggle("active", parseInt(el.dataset.idx, 10) === idx));
}

/* 大纲点击（事件委托：大纲项随快照频繁重建） */
$("caseQaOutline").addEventListener("click", (e) => {
  const item = e.target.closest(".qa-outline-item");
  if (item) jumpToQa(parseInt(item.dataset.idx, 10));
});

/* 用户手动滚回列表底部：恢复"跟随最新"模式（与聊天应用习惯一致） */
$("caseQaList").addEventListener("scroll", () => {
  if (qaJumping || qaOutlineActive == null) return;
  const list = $("caseQaList");
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 40) {
    qaOutlineActive = null;
    const items = $("caseQaOutline").querySelectorAll(".qa-outline-item");
    items.forEach(el => el.classList.toggle("active", el === items[items.length - 1]));
  }
});

/* Q 文本中的截断存储标记（……[中间 N 字已省略，仅存储首尾部分]……）
   红色加粗显示，避免被误读为 prompt 原文 */
function highlightOmitted(text) {
  return escapeHtml(text).replace(
    /……\[中间 \d+ 字已省略，仅存储首尾部分\]……/g,
    (m) => `<span class="qa-omitted">${m}</span>`);
}

function qaItemHtml(qa, idx, c) {
  const meta = [escapeHtml(qa.phase)];
  if (qa.loop) meta.push(`第 ${qa.loop}/${c.total_loops} 迭代`);
  if (qa.noun) meta.push(`「${escapeHtml(qa.noun)}」`);
  // 真实输入规模：question 为截断存储（仅首尾），展示完整 prompt 字数。
  // 新任务读 prompt_chars；旧任务回退解析截断标记（首300+尾200+省略N字）；
  // 无标记则 question 即全文
  let inChars = qa.prompt_chars || 0;
  if (!inChars) {
    const m = (qa.question || "").match(/中间 (\d+) 字已省略/);
    if (m) inChars = 500 + parseInt(m[1], 10);
  }
  if (!inChars) inChars = (qa.question || "").length;
  if (inChars) meta.push(`输入 ${inChars.toLocaleString()} 字（≈${fmtTokens(Math.round(inChars / 1.7))} token）`);
  if (qa.duration) meta.push(`${qa.duration}s`);
  if (qa.ttft != null) meta.push(`TTFT ${qa.ttft}s`);

  let answerHtml;
  if (qa.status === "generating") {
    // 流式中：有 partial 显示增长文本，否则显示"正在提问/等待回复"
    const partial = qa.partial || "";
    const body = partial
      ? renderMarkdown(partial) + '<span class="qa-cursor">▌</span>'
      : '<span class="qa-waiting">已发送问题，等待 LLM 回复</span><span class="qa-cursor">▌</span>';
    answerHtml = `<div class="qa-answer streaming md" data-idx="${idx}">${body}</div>`;
  } else if (qa.status === "error") {
    answerHtml = `<div class="qa-answer qa-err">✗ ${escapeHtml(qa.error || "调用失败")}</div>`;
  } else {
    answerHtml = `<div class="qa-answer md">${renderMarkdown(qa.answer || "（空回复）")}</div>`;
  }
  return `<div class="qa-item ${qa.status}" data-idx="${idx}">
    <div class="qa-meta">#${idx + 1} · ${meta.join(" · ")}</div>
    <div class="qa-question">Q: ${highlightOmitted(qa.question)}</div>
    ${answerHtml}
  </div>`;
}

/* Markdown 渲染：先整体转义 HTML 再交给 marked 解析（安全），marked 缺失时降级纯文本 */
function renderMarkdown(text) {
  if (!text) return "";
  if (typeof marked !== "undefined" && marked.parse) {
    try { return marked.parse(escapeHtml(text)); } catch (e) { /* 降级 */ }
  }
  return escapeHtml(text).replace(/\n/g, "<br>");
}

/* 构建错误明细悬浮框（嵌在 .err-count 内，CSS 控制悬浮显示） */
function buildErrorTooltip(c) {
  const recs = c.error_records || [];
  const total = c.total_loops || 0;
  const items = recs.map((r) => {
    const t = new Date((r.ts || 0) * 1000).toLocaleTimeString("zh-CN", { hour12: false });
    let where = r.phase || "";
    if (r.phase === "生成文章" && r.loop) {
      where += ` · 第 ${r.loop}${total ? "/" + total : ""} 轮`;
    }
    if (r.noun) where += ` · 名词「${escapeHtml(r.noun)}」`;
    if (r.duration) where += ` · 耗时 ${r.duration}s`;
    return `<div class="err-item">
      <div class="err-meta"><span class="err-time">${t}</span> ${where}</div>
      <div class="err-detail">${escapeHtml(r.error || "")}</div>
    </div>`;
  }).join("");
  return `<span class="err-tooltip"><span class="err-title">共 ${c.errors} 次错误明细</span>${items}</span>`;
}

function fmtElapsed(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}时${m}分${s}秒` : m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

/* ============ 初始化 ============ */
(async function init() {
  await loadModelSelect();
  await loadTextHistory();
  // 页面加载时若测试在运行，恢复显示并选中侧栏对应任务
  const s = await fetchJSON("/api/tests/text/status");
  if (s && s.test_id && s.status !== "idle") {
    textCurrentTask = s.task_name || null;
    lastTestStatus = s.status;
    renderStatus(s);
    renderHistoryList();
  }
  if ($("textModelSelect").value) probeSelectedModel();
  restartPolling();
})();
