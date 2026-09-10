// ==UserScript==
// @name         Patreon Subscription File Archiver
// @name:zh-CN   Patreon 订阅文件归档器
// @namespace    https://github.com/CodeTianZun
// @version      1.1.0
// @description  Resumably archive accessible Patreon files with dated names, monthly-first copies, persistent checkpoints, and network recovery.
// @description:zh-CN  可断点续传地归档有权访问的 Patreon 文件，按日期命名，保存每月首个副本，并支持持久化进度与断网恢复。
// @author       CodeTianZun
// @license      MIT
// @homepageURL  https://github.com/CodeTianZun/patreonSubscriptionArchiver
// @supportURL   https://github.com/CodeTianZun/patreonSubscriptionArchiver/issues
// @downloadURL  https://raw.githubusercontent.com/CodeTianZun/patreonSubscriptionArchiver/main/patreon-subscription-archiver.user.js
// @updateURL    https://raw.githubusercontent.com/CodeTianZun/patreonSubscriptionArchiver/main/patreon-subscription-archiver.user.js
// @match        https://www.patreon.com/*
// @icon         https://www.patreon.com/favicon.ico
// @run-at       document-idle
// @noframes
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        unsafeWindow
// @connect      patreon.com
// @connect      www.patreon.com
// @connect      patreonusercontent.com
// @connect      *.patreonusercontent.com
// @connect      cloudfront.net
// @connect      *.cloudfront.net
// @connect      *
// ==/UserScript==

/*
 * 文件功能概括：在 Patreon 创作者帖子页扫描当前账号可访问的附件、音频和图片，
 * 按发布日期归档到本机，额外复制每月首个文件，并提供持久化断点、网络恢复、去重、停止和清单导出功能。
 */

(function () {
  'use strict';

  const SCRIPT_ID = 'patreon-subscription-archiver';
  const SETTINGS_KEY = `${SCRIPT_ID}:settings:v1`;
  const HISTORY_PREFIX = `${SCRIPT_ID}:history:v1:`;
  const CHECKPOINT_PREFIX = `${SCRIPT_ID}:checkpoint:v2:`;
  const DEFAULT_SETTINGS = Object.freeze({
    campaignId: '',
    folderName: 'Patreon-Archive',
    includeAttachments: true,
    includeAudio: true,
    includeImages: false,
    monthlyFirstCopy: true,
    retryDownloaded: false,
    useLocalTimezone: true,
    concurrency: 2,
    intervalMs: 650,
    downloadRetries: 4,
    stallTimeoutSeconds: 90,
  });
  const POSTS_INCLUDE = [
    'campaign',
    'attachments_media',
    'audio',
    'images',
    'media',
    'user',
  ].join(',');
  const state = {
    host: null,
    shadow: null,
    elements: {},
    items: [],
    reportRows: [],
    campaignId: '',
    creatorKey: '',
    creatorLabel: '',
    formTargetKey: '',
    pageCount: 0,
    isScanning: false,
    isDownloading: false,
    stopRequested: false,
    flatDownloadNames: false,
    activeFetchController: null,
    activeDownloads: new Set(),
    checkpoint: null,
    networkRecoveryPromise: null,
    lastProgressUiAt: 0,
    logLines: [],
  };

  /** 启动脚本、挂载界面并注册油猴菜单。 */
  function main() {
    mountPanel();
    registerMenus();
    refreshTargetSummary();
  }

  /** 从当前地址解析创作者标识或单篇帖子标识。 */
  function parsePageTarget(urlString = location.href) {
    const url = new URL(urlString);
    const parts = url.pathname.split('/').filter(Boolean);
    let vanity = '';
    let postId = '';

    if ((parts[0] === 'c' || parts[0] === 'cw') && parts[1]) {
      vanity = decodeURIComponent(parts[1]);
    } else if (parts[0] === 'user' && url.searchParams.get('u')) {
      vanity = `user-${url.searchParams.get('u')}`;
    } else if (parts[0] === 'posts' && parts[1]) {
      postId = parts[1].match(/(\d+)(?:[/?#]|$)/)?.[1] || '';
    } else if (parts[0] && parts[1] === 'posts') {
      vanity = decodeURIComponent(parts[0]);
    }

    return {
      vanity,
      postId,
      pageUrl: url.href,
      isCreatorPage: Boolean(vanity),
    };
  }

  /** 在页面右下角创建隔离样式的归档控制面板。 */
  function mountPanel() {
    if (document.getElementById(SCRIPT_ID)) return;

    const host = document.createElement('div');
    host.id = SCRIPT_ID;
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `${panelStyles()}${panelMarkup()}`;
    state.host = host;
    state.shadow = shadow;
    cacheElements();
    bindEvents();
    writeSettingsToForm(loadSettings());
  }

  /** 返回面板所需的完整样式。 */
  function panelStyles() {
    return `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .psa-launcher {
          position: fixed; right: 22px; bottom: 22px; z-index: 2147483646;
          border: 0; border-radius: 999px; padding: 11px 16px;
          color: #fff; background: #ff424d; box-shadow: 0 8px 28px rgba(0,0,0,.25);
          font: 600 14px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          cursor: pointer;
        }
        .psa-panel {
          position: fixed; right: 22px; bottom: 76px; z-index: 2147483647;
          width: min(430px, calc(100vw - 24px)); max-height: min(760px, calc(100vh - 100px));
          overflow: auto; color: #242424; background: #fff; border: 1px solid #dedede;
          border-radius: 16px; box-shadow: 0 18px 60px rgba(0,0,0,.28);
          font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .psa-panel[hidden] { display: none; }
        .psa-head { display: flex; align-items: center; justify-content: space-between; padding: 15px 16px 12px; border-bottom: 1px solid #eee; }
        .psa-head strong { font-size: 16px; }
        .psa-close { border: 0; background: transparent; font-size: 22px; line-height: 1; cursor: pointer; color: #666; }
        .psa-body { padding: 14px 16px 16px; }
        .psa-target { margin: 0 0 12px; padding: 9px 11px; border-radius: 9px; background: #f6f6f6; word-break: break-word; }
        .psa-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .psa-field { display: grid; gap: 5px; margin-bottom: 10px; }
        .psa-field > span { color: #555; font-size: 12px; }
        input[type="text"], input[type="number"], select {
          width: 100%; min-height: 34px; border: 1px solid #cfcfcf; border-radius: 8px;
          padding: 6px 9px; color: #222; background: #fff; font: inherit;
        }
        .psa-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 12px; margin: 3px 0 13px; }
        .psa-checks label { display: flex; align-items: center; gap: 7px; }
        .psa-note { margin: 6px 0 12px; color: #686868; font-size: 12px; }
        .psa-actions { display: flex; flex-wrap: wrap; gap: 8px; }
        .psa-actions button {
          min-height: 35px; border: 1px solid #cfcfcf; border-radius: 9px; padding: 6px 11px;
          color: #222; background: #fff; font: 600 13px/1.2 inherit; cursor: pointer;
        }
        .psa-actions button.primary { border-color: #ff424d; color: #fff; background: #ff424d; }
        .psa-actions button.danger { color: #a82028; }
        .psa-actions button:disabled { cursor: not-allowed; opacity: .45; }
        .psa-status { margin: 13px 0 7px; font-weight: 650; }
        progress { width: 100%; height: 10px; accent-color: #ff424d; }
        .psa-log {
          height: 150px; margin: 9px 0 0; overflow: auto; border: 1px solid #e2e2e2;
          border-radius: 9px; padding: 9px; color: #444; background: #fafafa;
          font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap;
        }
        details { margin: 10px 0 12px; }
        summary { color: #555; cursor: pointer; }
        @media (prefers-color-scheme: dark) {
          .psa-panel { color: #eee; background: #222; border-color: #444; }
          .psa-head { border-color: #3d3d3d; }
          .psa-target, .psa-log { color: #ddd; background: #2c2c2c; border-color: #484848; }
          .psa-field > span, .psa-note, summary { color: #bbb; }
          input[type="text"], input[type="number"], select, .psa-actions button { color: #eee; background: #292929; border-color: #555; }
          .psa-actions button.primary { background: #ff424d; border-color: #ff424d; }
          .psa-close { color: #bbb; }
        }
      </style>`;
  }

  /** 返回面板的静态 HTML 结构。 */
  function panelMarkup() {
    return `
      <button class="psa-launcher" id="launcher" type="button">📦 Patreon 归档</button>
      <section class="psa-panel" id="panel" aria-label="Patreon 订阅文件归档器" hidden>
        <header class="psa-head">
          <strong>Patreon 订阅文件归档器</strong>
          <button class="psa-close" id="close" type="button" aria-label="关闭">×</button>
        </header>
        <div class="psa-body">
          <p class="psa-target" id="target">正在识别当前页面…</p>
          <label class="psa-field">
            <span>Campaign ID（通常自动识别；失败时再手填）</span>
            <input id="campaignId" type="text" inputmode="numeric" placeholder="自动识别">
          </label>
          <label class="psa-field">
            <span>下载根目录名</span>
            <input id="folderName" type="text" maxlength="32">
          </label>
          <div class="psa-checks">
            <label><input id="includeAttachments" type="checkbox">帖子附件</label>
            <label><input id="includeAudio" type="checkbox">帖子音频</label>
            <label><input id="includeImages" type="checkbox">帖子图片</label>
            <label><input id="monthlyFirstCopy" type="checkbox">每月首个额外副本</label>
            <label><input id="retryDownloaded" type="checkbox">重新下载成功项</label>
            <label><input id="useLocalTimezone" type="checkbox">按本地时区归月</label>
          </div>
          <details>
            <summary>速度与兼容设置</summary>
            <div class="psa-grid">
              <label class="psa-field">
                <span>并发下载数</span>
                <select id="concurrency">
                  <option value="1">1（最稳）</option>
                  <option value="2">2（推荐）</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                </select>
              </label>
              <label class="psa-field">
                <span>启动间隔（毫秒）</span>
                <input id="intervalMs" type="number" min="250" max="10000" step="50">
              </label>
              <label class="psa-field">
                <span>断线自动重试次数</span>
                <select id="downloadRetries">
                  <option value="0">0</option>
                  <option value="2">2</option>
                  <option value="4">4（推荐）</option>
                  <option value="6">6</option>
                </select>
              </label>
              <label class="psa-field">
                <span>无进度超时（秒）</span>
                <select id="stallTimeoutSeconds">
                  <option value="45">45</option>
                  <option value="90">90（推荐）</option>
                  <option value="180">180</option>
                  <option value="300">300</option>
                </select>
              </label>
            </div>
          </details>
          <p class="psa-note">每个成功文件都会立即写入本地记录；重新扫描后可从未完成项继续。下载使用当前浏览器登录态，不读取或导出 Cookie。</p>
          <div class="psa-actions">
            <button class="primary" id="scan" type="button">1. 扫描全部帖子</button>
            <button class="primary" id="download" type="button" disabled>2. 开始下载</button>
            <button class="danger" id="stop" type="button" disabled>停止</button>
            <button id="exportJson" type="button" disabled>导出 JSON</button>
            <button id="exportCsv" type="button" disabled>导出 CSV</button>
          </div>
          <div class="psa-status" id="status">等待扫描</div>
          <progress id="progress" value="0" max="1"></progress>
          <pre class="psa-log" id="log" aria-live="polite"></pre>
        </div>
      </section>`;
  }

  /** 缓存面板中的交互元素引用。 */
  function cacheElements() {
    const ids = [
      'launcher', 'panel', 'close', 'target', 'campaignId', 'folderName',
      'includeAttachments', 'includeAudio', 'includeImages', 'monthlyFirstCopy',
      'retryDownloaded', 'useLocalTimezone', 'concurrency', 'intervalMs',
      'downloadRetries', 'stallTimeoutSeconds',
      'scan', 'download', 'stop', 'exportJson', 'exportCsv', 'status', 'progress', 'log',
    ];
    for (const id of ids) state.elements[id] = state.shadow.getElementById(id);
  }

  /** 为面板按钮绑定固定交互逻辑。 */
  function bindEvents() {
    state.elements.launcher.addEventListener('click', togglePanel);
    state.elements.close.addEventListener('click', hidePanel);
    state.elements.scan.addEventListener('click', handleScan);
    state.elements.download.addEventListener('click', handleDownload);
    state.elements.stop.addEventListener('click', stopCurrentWork);
    state.elements.exportJson.addEventListener('click', exportJsonReport);
    state.elements.exportCsv.addEventListener('click', exportCsvReport);
    window.addEventListener('beforeunload', handleBeforeUnload);
  }

  /** 注册油猴扩展菜单中的显示和清理命令。 */
  function registerMenus() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('显示 Patreon 归档面板', showPanel);
    GM_registerMenuCommand('清除此创作者的下载记录', clearCurrentHistory);
  }

  /** 显示或隐藏归档面板。 */
  function togglePanel() {
    state.elements.panel.hidden ? showPanel() : hidePanel();
  }

  /** 显示归档面板并刷新页面目标。 */
  function showPanel() {
    state.elements.panel.hidden = false;
    refreshTargetSummary();
  }

  /** 隐藏归档面板。 */
  function hidePanel() {
    state.elements.panel.hidden = true;
  }

  /** 更新当前页面可扫描目标的文字提示。 */
  function refreshTargetSummary() {
    const target = parsePageTarget();
    const targetKey = target.vanity || target.postId || location.pathname;
    if (state.formTargetKey && state.formTargetKey !== targetKey && !state.isScanning && !state.isDownloading) {
      state.elements.campaignId.value = '';
      state.items = [];
      state.reportRows = [];
      updateButtons();
    }
    state.formTargetKey = targetKey;
    const text = target.isCreatorPage
      ? `当前创作者：${target.vanity}`
      : target.postId
        ? `当前是单篇帖子 #${target.postId}；批量归档请打开该创作者的“帖子”页面。`
        : '请先打开任意 Patreon 创作者的“帖子 / Posts”页面。';
    state.elements.target.textContent = text;
  }

  /** 从油猴存储读取并规范化用户设置。 */
  function loadSettings() {
    const saved = GM_getValue(SETTINGS_KEY, {});
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...(saved || {}), campaignId: '' });
  }

  /** 将设置值限制到脚本支持的安全范围。 */
  function normalizeSettings(settings) {
    return {
      campaignId: String(settings.campaignId || '').trim(),
      folderName: sanitizeSegment(settings.folderName || DEFAULT_SETTINGS.folderName, 32),
      includeAttachments: Boolean(settings.includeAttachments),
      includeAudio: Boolean(settings.includeAudio),
      includeImages: Boolean(settings.includeImages),
      monthlyFirstCopy: Boolean(settings.monthlyFirstCopy),
      retryDownloaded: Boolean(settings.retryDownloaded),
      useLocalTimezone: Boolean(settings.useLocalTimezone),
      concurrency: clampNumber(settings.concurrency, 1, 4, DEFAULT_SETTINGS.concurrency),
      intervalMs: clampNumber(settings.intervalMs, 250, 10000, DEFAULT_SETTINGS.intervalMs),
      downloadRetries: clampNumber(settings.downloadRetries, 0, 8, DEFAULT_SETTINGS.downloadRetries),
      stallTimeoutSeconds: clampNumber(settings.stallTimeoutSeconds, 30, 600, DEFAULT_SETTINGS.stallTimeoutSeconds),
    };
  }

  /** 把设置对象显示到表单控件。 */
  function writeSettingsToForm(settings) {
    for (const key of ['campaignId', 'folderName', 'concurrency', 'intervalMs', 'downloadRetries', 'stallTimeoutSeconds']) {
      state.elements[key].value = settings[key];
    }
    for (const key of ['includeAttachments', 'includeAudio', 'includeImages', 'monthlyFirstCopy', 'retryDownloaded', 'useLocalTimezone']) {
      state.elements[key].checked = settings[key];
    }
  }

  /** 从表单读取、保存并返回当前设置。 */
  function readSettingsFromForm() {
    const settings = normalizeSettings({
      campaignId: state.elements.campaignId.value,
      folderName: state.elements.folderName.value,
      includeAttachments: state.elements.includeAttachments.checked,
      includeAudio: state.elements.includeAudio.checked,
      includeImages: state.elements.includeImages.checked,
      monthlyFirstCopy: state.elements.monthlyFirstCopy.checked,
      retryDownloaded: state.elements.retryDownloaded.checked,
      useLocalTimezone: state.elements.useLocalTimezone.checked,
      concurrency: state.elements.concurrency.value,
      intervalMs: state.elements.intervalMs.value,
      downloadRetries: state.elements.downloadRetries.value,
      stallTimeoutSeconds: state.elements.stallTimeoutSeconds.value,
    });
    GM_setValue(SETTINGS_KEY, { ...settings, campaignId: '' });
    writeSettingsToForm(settings);
    return settings;
  }

  /** 把数值约束到给定范围并提供无效值回退。 */
  function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
  }

  /** 执行完整扫描并生成待下载清单。 */
  async function handleScan() {
    if (state.isScanning || state.isDownloading) return;
    refreshTargetSummary();
    const target = parsePageTarget();
    const settings = readSettingsFromForm();

    if (!target.isCreatorPage) {
      setStatus('请先打开创作者的“帖子 / Posts”页面。');
      showPanel();
      return;
    }
    if (!settings.includeAttachments && !settings.includeAudio && !settings.includeImages) {
      setStatus('请至少选择一种要下载的文件类型。');
      return;
    }

    resetScanState();
    state.isScanning = true;
    updateButtons();
    setStatus('正在识别创作者…');
    appendLog(`目标页面：${target.pageUrl}`);

    try {
      const campaign = await resolveCampaign(target, settings.campaignId);
      state.campaignId = campaign.id;
      state.creatorLabel = campaign.label || target.vanity;
      state.creatorKey = `campaign-${campaign.id}`;
      state.elements.campaignId.value = campaign.id;
      appendLog(`Campaign ID：${campaign.id}`);
      setStatus('正在扫描全部帖子分页…');

      const scanResult = await crawlAllPosts(campaign.id, settings);
      state.items = finalizeItems(scanResult.items, settings);
      state.pageCount = scanResult.pageCount;
      state.reportRows = buildReportRows(state.items, settings);
      const monthlyCount = state.items.filter((item) => item.isMonthlyFirst).length;
      const resume = refreshResumeUi(settings);

      setStatus(`扫描完成：${scanResult.postCount} 篇帖子，${state.items.length} 个文件，${monthlyCount} 个月首文件；已记录 ${resume.recorded} 项，待下载 ${resume.pending} 项。`);
      setProgress(1, 1);
      appendLog(`共读取 ${scanResult.pageCount} 页；可下载文件 ${state.items.length} 个。`);
      appendLog(`断点记录：已成功 ${resume.recorded}/${resume.total} 项，本次将从剩余 ${resume.pending} 项继续。`);
      if (resume.interrupted > 0) appendLog(`检测到上次中断时有 ${resume.interrupted} 个进行中任务，因状态不确定会安全重试。`);
      if (state.items.length === 0) appendLog('没有找到所选类型的可下载文件；请确认订阅权限或改选文件类型。');
    } catch (error) {
      handleError('扫描失败', error);
    } finally {
      state.isScanning = false;
      updateButtons();
    }
  }

  /** 清除上一次扫描结果并重置进度显示。 */
  function resetScanState() {
    state.stopRequested = false;
    state.items = [];
    state.reportRows = [];
    state.campaignId = '';
    state.creatorKey = '';
    state.creatorLabel = '';
    state.pageCount = 0;
    state.checkpoint = null;
    state.networkRecoveryPromise = null;
    state.logLines = [];
    state.elements.log.textContent = '';
    setProgress(0, 1);
  }

  /** 综合手填值、页面数据与会员关系识别 Campaign ID。 */
  async function resolveCampaign(target, manualCampaignId) {
    if (/^\d+$/.test(manualCampaignId)) {
      return { id: manualCampaignId, label: target.vanity };
    }

    const directId = findCampaignIdInCurrentPage(target.vanity);
    if (directId) return { id: directId, label: target.vanity };

    try {
      const pageResponse = await fetchWithTimeout(target.pageUrl, { credentials: 'include', cache: 'no-store' });
      if (pageResponse.ok) {
        const pageHtml = await pageResponse.text();
        const htmlId = findCampaignIdInHtml(pageHtml);
        if (htmlId) return { id: htmlId, label: target.vanity };
      } else {
        appendLog(`创作者页面请求返回 HTTP ${pageResponse.status}，正在尝试会员关系数据。`);
      }
    } catch (error) {
      appendLog(`创作者页面请求失败，正在尝试会员关系数据：${error.message}`);
    }
    if (state.stopRequested) throw new Error('操作已停止');

    const membership = await findCampaignFromMemberships(target.vanity);
    if (membership) return membership;

    throw new Error('无法自动识别 Campaign ID。请在面板中手填数字 ID 后重试。');
  }

  /** 从当前页面的启动数据中读取 Campaign ID。 */
  function findCampaignIdInCurrentPage(vanity) {
    const nextData = document.querySelector('script#__NEXT_DATA__')?.textContent;
    if (nextData) {
      try {
        const parsed = JSON.parse(nextData);
        const bootstrapCampaign = parsed?.props?.pageProps?.bootstrapEnvelope?.pageBootstrap?.campaign?.data;
        if (campaignMatchesVanity(bootstrapCampaign, vanity)) return String(bootstrapCampaign.id);
        const nestedId = findCampaignInObject(parsed, vanity);
        if (nestedId) return nestedId;
      } catch (error) {
        appendLog(`页面启动数据解析失败，将尝试其他方式：${error.message}`);
      }
    }

    try {
      const directCampaign = unsafeWindow?.patreon?.pageBootstrap?.campaign?.data;
      if (campaignMatchesVanity(directCampaign, vanity)) return String(directCampaign.id);
      return findCampaignInObject(unsafeWindow?.patreon, vanity);
    } catch (error) {
      return '';
    }
  }

  /** 判断 campaign 资源是否带有 ID 且与当前创作者标识一致。 */
  function campaignMatchesVanity(campaign, vanity) {
    if (!campaign?.id) return false;
    if (!vanity) return true;
    const attributes = campaign.attributes || {};
    const target = vanity.toLowerCase();
    const candidateVanity = String(attributes.vanity || '').toLowerCase();
    const candidateUrl = String(attributes.url || attributes.url_for_current_user || '').toLowerCase();
    return candidateVanity === target || candidateUrl.includes(`/${target}`);
  }

  /** 在对象树中查找与目标创作者匹配的 campaign 资源。 */
  function findCampaignInObject(root, vanity) {
    if (!root || typeof root !== 'object') return '';
    const stack = [root];
    const seen = new WeakSet();
    let visited = 0;

    while (stack.length && visited < 50000) {
      const value = stack.pop();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      visited += 1;

      const attr = value.attributes || {};
      const candidateVanity = String(attr.vanity || '').toLowerCase();
      const candidateUrl = String(attr.url || attr.url_for_current_user || '').toLowerCase();
      const vanityMatches = !vanity || candidateVanity === vanity.toLowerCase() || candidateUrl.includes(`/${vanity.toLowerCase()}`);
      if (value.type === 'campaign' && value.id && vanityMatches) return String(value.id);

      for (const child of Object.values(value)) {
        if (child && typeof child === 'object') stack.push(child);
      }
    }
    return '';
  }

  /** 从页面 HTML 的多种 Patreon 启动格式中提取 Campaign ID。 */
  function findCampaignIdInHtml(html) {
    const patterns = [
      /pageBootstrap\\?"\s*:\s*\{[\s\S]{0,8000}?campaign\\?"\s*:\s*\{[\s\S]{0,3000}?\\?"id\\?"\s*:\s*\\?"(\d+)/i,
      /https:\\?\/\\?\/www\.patreon\.com\\?\/api\\?\/campaigns\\?\/(\d+)/i,
      /https:\/\/www\.patreon\.com\/api\/campaigns\/(\d+)/i,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return match[1];
    }
    return '';
  }

  /** 从当前账号的活跃会员关系中匹配创作者 campaign。 */
  async function findCampaignFromMemberships(vanity) {
    const url = new URL('/api/current_user', location.origin);
    url.searchParams.set('include', 'active_memberships.campaign');
    url.searchParams.set('fields[campaign]', 'name,url,vanity,url_for_current_user');
    url.searchParams.set('fields[member]', 'is_free_member,is_free_trial');
    url.searchParams.set('json-api-version', '1.0');
    url.searchParams.set('json-api-use-default-includes', 'false');
    const json = await fetchJsonWithRetry(url.href);
    const campaigns = (json.included || []).filter((entry) => entry?.type === 'campaign');
    const target = vanity.toLowerCase();
    const matched = campaigns.find((entry) => {
      const attributes = entry.attributes || {};
      const candidateVanity = String(attributes.vanity || '').toLowerCase();
      const candidateUrl = String(attributes.url || attributes.url_for_current_user || '').toLowerCase();
      return candidateVanity === target || candidateUrl.includes(`/${target}`);
    });
    return matched ? { id: String(matched.id), label: matched.attributes?.name || vanity } : null;
  }

  /** 遍历 Patreon 帖子 API 的全部游标分页并收集文件。 */
  async function crawlAllPosts(campaignId, settings) {
    let nextUrl = buildPostsApiUrl(campaignId);
    let pageCount = 0;
    let postCount = 0;
    const items = [];
    const visitedUrls = new Set();

    while (nextUrl) {
      if (state.stopRequested) throw new Error('扫描已停止');
      if (visitedUrls.has(nextUrl)) throw new Error('分页游标重复，已停止以避免死循环。');
      if (pageCount >= 10000) throw new Error('分页数量异常（超过 10000 页），已停止。');
      visitedUrls.add(nextUrl);
      pageCount += 1;
      setStatus(`正在扫描第 ${pageCount} 页…`);

      const json = await fetchJsonWithRetry(nextUrl);
      const pageItems = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];
      const posts = pageItems.filter((entry) => entry?.type === 'post');
      postCount += posts.length;
      items.push(...extractFilesFromPage(posts, json.included || [], settings));
      appendLog(`第 ${pageCount} 页：${posts.length} 篇帖子，累计 ${items.length} 个文件。`);
      nextUrl = getNextPageUrl(json, nextUrl);
      if (nextUrl) await sleep(700);
    }

    return { items, pageCount, postCount };
  }

  /** 构造包含附件媒体关系的 Patreon 帖子列表 API 地址。 */
  function buildPostsApiUrl(campaignId) {
    const url = new URL('/api/posts', location.origin);
    url.searchParams.set('include', POSTS_INCLUDE);
    url.searchParams.set('sort', '-published_at');
    url.searchParams.set('filter[contains_exclusive_posts]', 'true');
    url.searchParams.set('filter[is_draft]', 'false');
    url.searchParams.set('filter[campaign_id]', campaignId);
    url.searchParams.set('page[count]', '50');
    url.searchParams.set('json-api-version', '1.0');
    return url.href;
  }

  /** 按 Patreon JSON:API 分页字段生成下一页地址。 */
  function getNextPageUrl(json, currentUrl) {
    const cursor = json?.meta?.pagination?.cursors?.next;
    const linkedNext = typeof json?.links?.next === 'string' ? json.links.next : '';
    if (!cursor && !linkedNext) return '';

    const next = new URL(linkedNext || currentUrl, location.origin);
    if (cursor) next.searchParams.set('page[cursor]', cursor);
    return next.href;
  }

  /** 带退避重试地读取同源 JSON API，并识别登录或限流错误。 */
  async function fetchJsonWithRetry(url, attempt = 0) {
    if (state.stopRequested) throw new Error('操作已停止');
    const response = await fetchWithTimeout(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/vnd.api+json, application/json' },
    });

    if (response.ok) {
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('json')) throw new Error('API 未返回 JSON；登录可能已失效或遇到验证页面。');
      return response.json();
    }

    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const errorJson = response.status === 429 ? await readJsonSafely(response) : null;
      const retryAfter = Number(response.headers.get('retry-after') || errorJson?.errors?.[0]?.retry_after_seconds);
      if (Number.isFinite(retryAfter) && retryAfter > 30) {
        throw new Error(`Patreon 要求等待约 ${retryAfter} 秒后再试，请稍后重新扫描。`);
      }
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30000)
        : 1200 * (2 ** attempt);
      appendLog(`API 返回 HTTP ${response.status}，${Math.ceil(waitMs / 1000)} 秒后重试…`);
      await sleep(waitMs);
      if (state.stopRequested) throw new Error('操作已停止');
      return fetchJsonWithRetry(url, attempt + 1);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(`API 返回 HTTP ${response.status}。请确认已登录且当前订阅有权查看这些帖子。`);
    }
    throw new Error(`API 请求失败：HTTP ${response.status}`);
  }

  /** 为页面与 API 请求增加超时控制，并允许“停止”按钮立即中断。 */
  async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    state.activeFetchController = controller;
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(state.stopRequested ? '操作已停止' : `请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
      if (state.activeFetchController === controller) state.activeFetchController = null;
    }
  }

  /** 尝试读取错误响应 JSON，并在非 JSON 响应时返回空值。 */
  async function readJsonSafely(response) {
    try {
      return await response.json();
    } catch (error) {
      return null;
    }
  }

  /** 从一页帖子及 included 资源中提取用户选择的文件。 */
  function extractFilesFromPage(posts, included, settings) {
    const includedMap = new Map();
    for (const entry of included) {
      if (entry?.type && entry?.id) includedMap.set(`${entry.type}:${entry.id}`, entry);
    }

    const results = [];
    for (const post of posts) {
      const attributes = post.attributes || {};
      if (attributes.current_user_can_view === false) continue;
      const base = {
        postId: String(post.id),
        postTitle: String(attributes.title || `post-${post.id}`),
        postUrl: String(attributes.url || `${location.origin}/posts/${post.id}`),
        publishedAt: String(attributes.published_at || attributes.created_at || ''),
      };

      if (settings.includeAttachments) {
        results.push(...extractRelationshipMedia(post, ['attachments_media', 'attachments'], 'attachment', includedMap, base));
        results.push(...extractAttachmentMediaFallback(post, includedMap, base));
        results.push(...extractInlineAttachmentLinks(attributes.content, base));
      }
      if (settings.includeAudio) {
        results.push(...extractRelationshipMedia(post, ['audio'], 'audio', includedMap, base));
      }
      if (settings.includeImages) {
        results.push(...extractRelationshipMedia(post, ['images'], 'image', includedMap, base));
      }
    }
    return results;
  }

  /** 从帖子关系中解析指定类型的 media 资源。 */
  function extractRelationshipMedia(post, relationshipNames, kind, includedMap, base) {
    const output = [];
    for (const relationshipName of relationshipNames) {
      const relationData = post?.relationships?.[relationshipName]?.data;
      const refs = Array.isArray(relationData) ? relationData : relationData ? [relationData] : [];
      for (let index = 0; index < refs.length; index += 1) {
        const ref = refs[index];
        const media = includedMap.get(`${ref.type}:${ref.id}`)
          || includedMap.get(`media:${ref.id}`);
        if (!media) continue;
        const parsed = parseMediaResource(media, kind, base, index);
        if (parsed) output.push(parsed);
      }
    }
    return output;
  }

  /** 从通用 media 关系中补充识别 owner_relationship 为 attachment 的附件。 */
  function extractAttachmentMediaFallback(post, includedMap, base) {
    const relationData = post?.relationships?.media?.data;
    const refs = Array.isArray(relationData) ? relationData : relationData ? [relationData] : [];
    const output = [];
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      const media = includedMap.get(`${ref.type}:${ref.id}`) || includedMap.get(`media:${ref.id}`);
      const ownerRelationship = String(media?.attributes?.owner_relationship || '').toLowerCase();
      if (ownerRelationship !== 'attachment') continue;
      const parsed = parseMediaResource(media, 'attachment', base, index);
      if (parsed) output.push(parsed);
    }
    return output;
  }

  /** 把单个 Patreon media 资源转换为统一下载项。 */
  function parseMediaResource(media, kind, base, index) {
    const attributes = media.attributes || {};
    const imageUrls = attributes.image_urls || {};
    const display = attributes.display || {};
    let url = attributes.download_url || '';

    if (kind === 'audio') {
      url = url || imageUrls.original || imageUrls.default || display.url || '';
    } else if (kind === 'image') {
      url = url || imageUrls.original || imageUrls.default || imageUrls.default_large || display.url || '';
    }
    if (!url) return null;

    const mimeType = String(attributes.mimetype || '');
    const fallbackExtension = extensionFromMime(mimeType) || extensionFromUrl(url) || 'bin';
    const originalName = attributes.file_name || `${kind}-${media.id}.${fallbackExtension}`;
    return {
      ...base,
      id: String(media.id),
      stableKey: `${kind}:${media.id}`,
      kind,
      index,
      originalName: String(originalName),
      mimeType,
      url: String(url),
      isMonthlyFirst: false,
      monthKey: '',
    };
  }

  /** 从帖子正文中补充解析 /file 链接形式的附件。 */
  function extractInlineAttachmentLinks(html, base) {
    if (!html || typeof html !== 'string') return [];
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const output = [];
    const seen = new Set();
    const links = doc.querySelectorAll('a[href]');

    for (let index = 0; index < links.length; index += 1) {
      const link = links[index];
      const url = new URL(link.getAttribute('href'), location.origin);
      if (!/(^|\.)patreon\.com$/i.test(url.hostname) || url.pathname !== '/file') continue;
      const mediaId = url.searchParams.get('m') || stableHash(url.href);
      if (seen.has(mediaId)) continue;
      seen.add(mediaId);
      const label = link.textContent.trim() || `attachment-${mediaId}`;
      output.push({
        ...base,
        id: mediaId,
        stableKey: `attachment:${mediaId}`,
        kind: 'attachment',
        index,
        originalName: label,
        mimeType: '',
        url: url.href,
        isMonthlyFirst: false,
        monthKey: '',
      });
    }
    return output;
  }

  /** 对下载项去重、排序并标记每个自然月的首个文件。 */
  function finalizeItems(items, settings) {
    const unique = new Map();
    for (const item of items) {
      const key = item.stableKey || `${item.kind}:${item.url}`;
      const existing = unique.get(key);
      if (!existing || dateValue(item.publishedAt) < dateValue(existing.publishedAt)) unique.set(key, item);
    }

    const sorted = [...unique.values()].sort((left, right) => {
      const dateDiff = dateValue(left.publishedAt) - dateValue(right.publishedAt);
      if (dateDiff !== 0) return dateDiff;
      const postDiff = Number(left.postId) - Number(right.postId);
      if (Number.isFinite(postDiff) && postDiff !== 0) return postDiff;
      return left.index - right.index;
    });

    const firstByMonth = new Set();
    for (const item of sorted) {
      item.monthKey = formatDateParts(item.publishedAt, settings.useLocalTimezone).month;
      if (settings.monthlyFirstCopy && item.monthKey !== '0000-00' && !firstByMonth.has(item.monthKey)) {
        firstByMonth.add(item.monthKey);
        item.isMonthlyFirst = true;
      }
    }
    return sorted;
  }

  /** 将日期字符串转换为可排序时间戳，并把无效日期置后。 */
  function dateValue(value) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  }

  /** 根据本地或 UTC 规则生成文件名所需的日期与月份。 */
  function formatDateParts(value, useLocalTimezone) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return { date: '0000-00-00', month: '0000-00' };
    const year = useLocalTimezone ? date.getFullYear() : date.getUTCFullYear();
    const month = (useLocalTimezone ? date.getMonth() : date.getUTCMonth()) + 1;
    const day = useLocalTimezone ? date.getDate() : date.getUTCDate();
    const dateText = `${year}-${pad2(month)}-${pad2(day)}`;
    return { date: dateText, month: `${year}-${pad2(month)}` };
  }

  /** 把数字补齐为两位日期片段。 */
  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  /** 从 MIME 类型推导常用扩展名。 */
  function extensionFromMime(mimeType) {
    const known = {
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/x-m4a': 'm4a',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'application/pdf': 'pdf',
      'application/zip': 'zip',
      'application/x-7z-compressed': '7z',
      'application/x-rar-compressed': 'rar',
    };
    return known[String(mimeType).toLowerCase()] || '';
  }

  /** 从 URL 路径安全提取扩展名。 */
  function extensionFromUrl(urlString) {
    try {
      const pathname = new URL(urlString, location.origin).pathname;
      const match = pathname.match(/\.([a-z0-9]{1,10})$/i);
      return match?.[1]?.toLowerCase() || '';
    } catch (error) {
      return '';
    }
  }

  /** 执行主副本和月首副本的并发下载队列。 */
  async function handleDownload() {
    if (state.isScanning || state.isDownloading || state.items.length === 0) return;
    const settings = readSettingsFromForm();
    const history = loadHistory(state.creatorKey);
    const jobs = buildDownloadJobs(state.items, settings, history);
    state.stopRequested = false;
    state.isDownloading = true;
    updateButtons();
    setProgress(0, Math.max(jobs.length, 1));

    if (jobs.length === 0) {
      setStatus('没有新的下载项；如需重下，请勾选“重新下载成功项”。');
      state.isDownloading = false;
      updateButtons();
      return;
    }

    beginDownloadCheckpoint(jobs);
    appendLog(`开始 ${jobs.length} 个下载任务；每个成功项都会立即保存断点记录。`);
    appendLog(`并发 ${settings.concurrency}，启动间隔 ${settings.intervalMs}ms，断线最多重试 ${settings.downloadRetries} 次。`);
    const runtime = { nextIndex: 0, completed: 0, succeeded: 0, failed: 0, retries: 0, nextStartAt: 0 };
    const workers = [];
    for (let index = 0; index < settings.concurrency; index += 1) {
      workers.push(runDownloadWorker(jobs, settings, history, runtime));
    }

    try {
      await Promise.all(workers);
      saveHistory(state.creatorKey, history);
      state.reportRows = buildReportRows(state.items, settings, history);
      const stoppedText = state.stopRequested ? '，已由用户停止' : '';
      setStatus(`下载结束：成功 ${runtime.succeeded}，失败 ${runtime.failed}，重试 ${runtime.retries}${stoppedText}。`);
      appendLog(`下载结束：成功 ${runtime.succeeded}，失败 ${runtime.failed}，重试 ${runtime.retries}。`);
      notifyCompletion(runtime);
    } catch (error) {
      handleError('下载过程异常', error);
    } finally {
      const checkpointStatus = state.stopRequested
        ? 'stopped'
        : runtime.failed > 0
          ? 'complete_with_errors'
          : 'complete';
      finishDownloadCheckpoint(checkpointStatus);
      state.isDownloading = false;
      state.activeDownloads.clear();
      refreshResumeUi(settings, history);
      updateButtons();
    }
  }

  /** 根据扫描结果、月首标记与历史记录构造下载任务。 */
  function buildDownloadJobs(items, settings, history) {
    const jobs = [];
    for (const item of items) {
      const mainKey = `main:${item.stableKey}`;
      if (settings.retryDownloaded || !history[mainKey]) {
        jobs.push({ item, copyType: 'main', historyKey: mainKey });
      }
      if (settings.monthlyFirstCopy && item.isMonthlyFirst) {
        const monthlyKey = `monthly:${item.monthKey}:${item.stableKey}`;
        if (settings.retryDownloaded || !history[monthlyKey]) {
          jobs.push({ item, copyType: 'monthly', historyKey: monthlyKey });
        }
      }
    }
    return jobs;
  }

  /** 汇总永久记录和上次中断状态，并更新继续下载按钮。 */
  function refreshResumeUi(settings, history = null) {
    const storedHistory = history || loadHistory(state.creatorKey);
    const allJobs = buildDownloadJobs(state.items, { ...settings, retryDownloaded: true }, {});
    const pendingJobs = buildDownloadJobs(state.items, { ...settings, retryDownloaded: false }, storedHistory);
    const checkpoint = loadCheckpoint(state.creatorKey);
    const interrupted = checkpoint && ['running', 'interrupted'].includes(checkpoint.status)
      ? Object.keys(checkpoint.inFlight || {}).length
      : 0;
    const total = allJobs.length;
    const pending = pendingJobs.length;
    const recorded = Math.max(0, total - pending);
    const queued = settings.retryDownloaded ? total : pending;

    state.elements.download.textContent = queued === 0
      ? '2. 已全部记录'
      : recorded > 0 && !settings.retryDownloaded
        ? `2. 继续下载（剩 ${queued}）`
        : `2. 开始下载（${queued}）`;
    return { total, pending, recorded, queued, interrupted };
  }

  /** 持续领取任务、限速下载并更新共享进度。 */
  async function runDownloadWorker(jobs, settings, history, runtime) {
    while (!state.stopRequested) {
      const jobIndex = runtime.nextIndex;
      runtime.nextIndex += 1;
      if (jobIndex >= jobs.length) return;
      const job = jobs[jobIndex];
      await waitForDownloadSlot(runtime, settings.intervalMs);
      if (state.stopRequested) return;

      const path = buildDownloadPath(job.item, job.copyType, settings);
      updateDownloadCheckpoint('job-started', job, { path });
      try {
        await downloadWithRecovery(job.item.url, path, settings, runtime, job);
        history[job.historyKey] = {
          downloadedAt: new Date().toISOString(),
          filename: path,
          postId: job.item.postId,
        };
        const historySaved = saveHistory(state.creatorKey, history);
        runtime.succeeded += 1;
        updateDownloadCheckpoint('job-succeeded', job, { path });
        appendLog(`✓ ${historySaved ? '[已记录]' : '[记录失败]'} ${job.copyType === 'monthly' ? '[月首] ' : ''}${path}`);
      } catch (error) {
        if (!state.stopRequested) {
          runtime.failed += 1;
          updateDownloadCheckpoint('job-failed', job, { path, error: error.message || String(error) });
          appendLog(`✗ ${path}：${error.message || error}`);
        } else {
          updateDownloadCheckpoint('job-interrupted', job, { path });
        }
      } finally {
        runtime.completed += 1;
        setProgress(runtime.completed, jobs.length);
        setStatus(`下载中：${runtime.completed}/${jobs.length}，成功 ${runtime.succeeded}，失败 ${runtime.failed}`);
      }
    }
  }

  /** 在并发工作线程间统一控制下载启动间隔。 */
  async function waitForDownloadSlot(runtime, intervalMs) {
    const now = Date.now();
    const waitMs = Math.max(0, runtime.nextStartAt - now);
    runtime.nextStartAt = Math.max(now, runtime.nextStartAt) + intervalMs;
    if (waitMs > 0) await sleep(waitMs);
  }

  /** 生成带创作者、月份、日期、帖子与媒体标识的相对下载路径。 */
  function buildDownloadPath(item, copyType, settings) {
    const parts = formatDateParts(item.publishedAt, settings.useLocalTimezone);
    const root = sanitizeSegment(settings.folderName, 32);
    const creator = sanitizeSegment(state.creatorLabel || state.creatorKey || 'creator', 30);
    const title = sanitizeSegment(item.postTitle, 32);
    const original = sanitizeFilename(item.originalName, 50);
    const kind = sanitizeSegment(item.kind, 12);
    const mediaId = sanitizeSegment(item.id, 18);
    const filename = `${parts.date}__${item.postId}__${title}__${kind}-${mediaId}__${original}`;

    if (copyType === 'monthly') {
      return `${root}/${creator}/_Monthly-First/${parts.month}/${parts.month}__FIRST__${filename}`;
    }
    return `${root}/${creator}/${parts.month}/${filename}`;
  }

  /** 在断线或代理切换后等待网络恢复，并按退避策略重试单个下载。 */
  async function downloadWithRecovery(url, path, settings, runtime, job) {
    const maxAttempts = settings.downloadRetries + 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (state.stopRequested) throw createCodedError('下载已停止', 'stopped');
      updateDownloadCheckpoint('job-attempt', job, { path, attempt });
      try {
        await downloadWithPathFallback(url, path, settings.stallTimeoutSeconds * 1000);
        return;
      } catch (error) {
        lastError = error;
        const terminalCodes = ['not_enabled', 'not_permitted', 'not_whitelisted', 'not_supported'];
        if (state.stopRequested || terminalCodes.includes(error.code) || attempt >= maxAttempts) throw error;

        runtime.retries += 1;
        const waitMs = Math.min(30000, 3000 * (2 ** (attempt - 1)));
        appendLog(`↻ 下载中断：${error.message || error}；等待代理/网络恢复后进行第 ${attempt + 1}/${maxAttempts} 次尝试。`);
        setStatus(`网络中断，正在等待恢复并重试（${attempt + 1}/${maxAttempts}）…`);
        updateDownloadCheckpoint('job-retrying', job, { path, attempt, error: error.message || String(error) });
        const recovered = await waitForNetworkRecovery(waitMs);
        if (!recovered) throw createCodedError('等待代理或网络恢复超时，请稍后再次点击继续下载', 'recovery_timeout');
        await waitForDownloadSlot(runtime, settings.intervalMs);
      }
    }
    throw lastError || createCodedError('下载失败', 'not_succeeded');
  }

  /** 使用 GM_download 下载文件，目录名不被支持时自动退回扁平文件名。 */
  async function downloadWithPathFallback(url, path, stallTimeoutMs) {
    const preferredName = state.flatDownloadNames ? path.replaceAll('/', '__') : path;
    try {
      await gmDownloadOnce(url, preferredName, stallTimeoutMs);
    } catch (firstError) {
      if (state.stopRequested) throw firstError;
      const noPathFallbackCodes = ['not_enabled', 'not_permitted', 'not_whitelisted', 'not_supported', 'stalled', 'stopped'];
      if (state.flatDownloadNames || noPathFallbackCodes.includes(firstError.code)) throw firstError;
      const flatName = path.replaceAll('/', '__');
      appendLog('浏览器未接受子目录路径，正在使用扁平文件名重试。');
      await gmDownloadOnce(url, flatName, stallTimeoutMs);
      state.flatDownloadNames = true;
    }
  }

  /** 把一次 GM_download 包装为带进度心跳和无进度超时的 Promise。 */
  function gmDownloadOnce(url, name, stallTimeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let handle = null;
      let activeEntry = null;
      let watchdog = null;
      let lastProgressAt = Date.now();
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (watchdog) window.clearInterval(watchdog);
        if (activeEntry) state.activeDownloads.delete(activeEntry);
        callback(value);
      };
      try {
        handle = GM_download({
          url,
          name,
          saveAs: false,
          conflictAction: 'uniquify',
          onload: () => finish(resolve),
          onerror: (error) => finish(reject, makeDownloadError(error)),
          ontimeout: () => finish(reject, new Error('下载超时')),
          onabort: () => finish(reject, new Error('下载已取消')),
          onprogress: (progress) => {
            lastProgressAt = Date.now();
            reportDownloadProgress(name, progress);
          },
        });
        activeEntry = {
          abort: () => {
            if (settled) return;
            const activeHandle = handle;
            finish(reject, createCodedError('下载已取消', 'stopped'));
            try {
              activeHandle?.abort?.();
            } catch (error) {
              console.debug(`[${SCRIPT_ID}] 取消活动下载失败`, error);
            }
          },
        };
        if (!settled) state.activeDownloads.add(activeEntry);
        if (!settled) watchdog = window.setInterval(() => {
          if (settled) return;
          const idleMs = Date.now() - lastProgressAt;
          if (idleMs >= 15000) reportDownloadStall(name, idleMs, stallTimeoutMs);
          if (idleMs < stallTimeoutMs) return;
          const stalledError = createCodedError(`连续 ${Math.round(stallTimeoutMs / 1000)} 秒没有下载进度`, 'stalled');
          const activeHandle = handle;
          finish(reject, stalledError);
          try {
            activeHandle?.abort?.();
          } catch (error) {
            console.debug(`[${SCRIPT_ID}] 取消停滞下载失败`, error);
          }
        }, 3000);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  /** 以节流方式在面板显示当前文件下载百分比。 */
  function reportDownloadProgress(name, progress) {
    const now = Date.now();
    if (now - state.lastProgressUiAt < 1000) return;
    state.lastProgressUiAt = now;
    const loaded = Number(progress?.loaded || 0);
    const total = Number(progress?.total || 0);
    const percentage = total > 0 ? ` ${Math.min(100, Math.round((loaded / total) * 100))}%` : '';
    setStatus(`正在下载${percentage}：${shortFilename(name)}`);
  }

  /** 在下载暂时无数据时显示自动恢复倒计时。 */
  function reportDownloadStall(name, idleMs, stallTimeoutMs) {
    const now = Date.now();
    if (now - state.lastProgressUiAt < 2500) return;
    state.lastProgressUiAt = now;
    const remainingSeconds = Math.max(0, Math.ceil((stallTimeoutMs - idleMs) / 1000));
    setStatus(`下载暂无进度：${shortFilename(name)}；${remainingSeconds} 秒后自动恢复`);
  }

  /** 截取相对路径末尾作为紧凑的状态栏文件名。 */
  function shortFilename(name) {
    const flattened = String(name).split('/').pop() || String(name);
    return flattened.length > 48 ? `…${flattened.slice(-47)}` : flattened;
  }

  /** 创建带机器可读错误码的异常。 */
  function createCodedError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  /** 让并发任务共用同一次 Patreon 网络恢复探测。 */
  async function waitForNetworkRecovery(initialDelayMs) {
    if (!state.networkRecoveryPromise) {
      state.networkRecoveryPromise = performNetworkRecovery(initialDelayMs);
    }
    const currentPromise = state.networkRecoveryPromise;
    try {
      return await currentPromise;
    } finally {
      if (state.networkRecoveryPromise === currentPromise) state.networkRecoveryPromise = null;
    }
  }

  /** 在最多两分钟内探测 Patreon 是否可重新访问。 */
  async function performNetworkRecovery(initialDelayMs) {
    await sleepInterruptibly(initialDelayMs);
    const deadline = Date.now() + 120000;
    let probeCount = 0;

    while (!state.stopRequested && Date.now() < deadline) {
      probeCount += 1;
      if (navigator.onLine !== false) {
        try {
          await fetchWithTimeout(`${location.origin}/api/current_user?json-api-version=1.0`, {
            credentials: 'include',
            cache: 'no-store',
          }, 10000);
          appendLog(`网络已恢复（第 ${probeCount} 次探测），继续下载。`);
          return true;
        } catch (error) {
          if (state.stopRequested) throw error;
        }
      }
      const remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setStatus(`等待代理或网络恢复，最长还等待 ${remainingSeconds} 秒…`);
      await sleepInterruptibly(5000);
    }
    if (state.stopRequested) throw createCodedError('下载已停止', 'stopped');
    return false;
  }

  /** 分段等待并在用户点击停止时尽快退出。 */
  async function sleepInterruptibly(milliseconds) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      if (state.stopRequested) throw createCodedError('下载已停止', 'stopped');
      await sleep(Math.min(500, deadline - Date.now()));
    }
  }

  /** 创建同时保留油猴错误码和易读消息的下载异常。 */
  function makeDownloadError(downloadError) {
    const error = new Error(formatDownloadError(downloadError));
    error.code = downloadError?.error || downloadError?.code || '';
    return error;
  }

  /** 把油猴下载错误对象转换为易读信息。 */
  function formatDownloadError(error) {
    if (!error) return '未知下载错误';
    const code = error.error || error.code || '';
    const details = error.details || error.message || '';
    return [code, details].filter(Boolean).join('：') || String(error);
  }

  /** 停止继续扫描或派发下载，并尽力取消活动下载。 */
  function stopCurrentWork() {
    state.stopRequested = true;
    if (state.checkpoint) {
      state.checkpoint.status = 'stopping';
      state.checkpoint.updatedAt = new Date().toISOString();
      saveCheckpoint(state.creatorKey, state.checkpoint);
    }
    if (state.activeFetchController) state.activeFetchController.abort();
    for (const handle of state.activeDownloads) {
      try {
        handle.abort();
      } catch (error) {
        appendLog(`活动下载取消失败：${error.message}`);
      }
    }
    state.activeDownloads.clear();
    setStatus('正在停止…');
  }

  /** 从油猴存储读取当前创作者的成功下载记录。 */
  function loadHistory(creatorKey) {
    if (!creatorKey) return {};
    try {
      const history = GM_getValue(`${HISTORY_PREFIX}${creatorKey}`, {});
      return history && typeof history === 'object' ? history : {};
    } catch (error) {
      console.error(`[${SCRIPT_ID}] 读取下载记录失败`, error);
      return {};
    }
  }

  /** 立即保存当前创作者的成功下载记录并报告存储错误。 */
  function saveHistory(creatorKey, history) {
    if (!creatorKey) return false;
    try {
      GM_setValue(`${HISTORY_PREFIX}${creatorKey}`, history);
      return true;
    } catch (error) {
      appendLog(`⚠ 下载记录保存失败：${error.message || error}`);
      console.error(`[${SCRIPT_ID}] 保存下载记录失败`, error);
      return false;
    }
  }

  /** 从油猴存储读取上一次下载任务检查点。 */
  function loadCheckpoint(creatorKey) {
    if (!creatorKey) return null;
    try {
      const checkpoint = GM_getValue(`${CHECKPOINT_PREFIX}${creatorKey}`, null);
      return checkpoint && typeof checkpoint === 'object' ? checkpoint : null;
    } catch (error) {
      console.error(`[${SCRIPT_ID}] 读取任务检查点失败`, error);
      return null;
    }
  }

  /** 将下载任务检查点写入油猴本地存储。 */
  function saveCheckpoint(creatorKey, checkpoint) {
    if (!creatorKey || !checkpoint) return false;
    try {
      GM_setValue(`${CHECKPOINT_PREFIX}${creatorKey}`, checkpoint);
      return true;
    } catch (error) {
      appendLog(`⚠ 任务检查点保存失败：${error.message || error}`);
      console.error(`[${SCRIPT_ID}] 保存任务检查点失败`, error);
      return false;
    }
  }

  /** 创建并立即保存本次下载任务的初始检查点。 */
  function beginDownloadCheckpoint(jobs) {
    const now = new Date().toISOString();
    state.checkpoint = {
      schemaVersion: 2,
      campaignId: state.campaignId,
      creator: state.creatorLabel,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      totalJobs: jobs.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      interrupted: 0,
      inFlight: {},
      lastErrors: [],
    };
    saveCheckpoint(state.creatorKey, state.checkpoint);
  }

  /** 根据单文件生命周期事件更新并立即保存任务检查点。 */
  function updateDownloadCheckpoint(event, job, details = {}) {
    const checkpoint = state.checkpoint;
    if (!checkpoint || !job?.historyKey) return;
    const key = job.historyKey;
    const now = new Date().toISOString();

    if (event === 'job-started') {
      checkpoint.inFlight[key] = { startedAt: now, path: details.path || '', attempt: 0 };
    } else if (event === 'job-attempt') {
      checkpoint.inFlight[key] = {
        ...(checkpoint.inFlight[key] || { startedAt: now, path: details.path || '' }),
        attempt: details.attempt || 1,
        lastAttemptAt: now,
      };
    } else if (event === 'job-retrying') {
      checkpoint.inFlight[key] = {
        ...(checkpoint.inFlight[key] || { startedAt: now, path: details.path || '' }),
        attempt: details.attempt || 1,
        lastError: details.error || '',
        lastAttemptAt: now,
      };
    } else if (event === 'job-succeeded') {
      delete checkpoint.inFlight[key];
      checkpoint.completed += 1;
      checkpoint.succeeded += 1;
    } else if (event === 'job-failed') {
      delete checkpoint.inFlight[key];
      checkpoint.completed += 1;
      checkpoint.failed += 1;
      checkpoint.lastErrors.push({ key, at: now, error: details.error || '下载失败' });
      checkpoint.lastErrors = checkpoint.lastErrors.slice(-20);
    } else if (event === 'job-interrupted') {
      delete checkpoint.inFlight[key];
      checkpoint.completed += 1;
      checkpoint.interrupted += 1;
    }

    checkpoint.updatedAt = now;
    saveCheckpoint(state.creatorKey, checkpoint);
  }

  /** 把本次任务检查点标记为完成、带错误完成或停止。 */
  function finishDownloadCheckpoint(status) {
    if (!state.checkpoint) return;
    const now = new Date().toISOString();
    state.checkpoint.status = status;
    state.checkpoint.updatedAt = now;
    state.checkpoint.finishedAt = status === 'stopping' ? null : now;
    saveCheckpoint(state.creatorKey, state.checkpoint);
  }

  /** 页面关闭或刷新前同步标记正在运行的任务为中断状态。 */
  function handleBeforeUnload() {
    if (!state.isDownloading || !state.checkpoint) return;
    state.checkpoint.status = 'interrupted';
    state.checkpoint.updatedAt = new Date().toISOString();
    saveCheckpoint(state.creatorKey, state.checkpoint);
  }

  /** 经用户确认后清除当前创作者的下载去重记录。 */
  function clearCurrentHistory() {
    if (!state.creatorKey) {
      alert('请先打开创作者帖子页并完成一次扫描。');
      return;
    }
    if (!confirm(`确定清除“${state.creatorLabel}”的成功下载记录吗？本机文件不会被删除。`)) return;
    GM_deleteValue(`${HISTORY_PREFIX}${state.creatorKey}`);
    GM_deleteValue(`${CHECKPOINT_PREFIX}${state.creatorKey}`);
    state.checkpoint = null;
    appendLog(`已清除下载记录：${state.creatorLabel}`);
    refreshResumeUi(readSettingsFromForm(), {});
    setStatus('已清除下载记录；本机文件未删除。');
  }

  /** 生成可导出的文件清单，并附上本地下载状态。 */
  function buildReportRows(items, settings, history = null) {
    const storedHistory = history || (state.creatorKey ? loadHistory(state.creatorKey) : {});
    return items.map((item) => {
      const parts = formatDateParts(item.publishedAt, settings.useLocalTimezone);
      return {
        published_date: parts.date,
        published_at: item.publishedAt,
        month: parts.month,
        is_monthly_first: item.isMonthlyFirst,
        type: item.kind,
        creator: state.creatorLabel,
        campaign_id: state.campaignId,
        post_id: item.postId,
        post_title: item.postTitle,
        original_filename: item.originalName,
        media_id: item.id,
        post_url: item.postUrl,
        download_url: item.url,
        main_downloaded: Boolean(storedHistory[`main:${item.stableKey}`]),
        monthly_copy_downloaded: Boolean(storedHistory[`monthly:${item.monthKey}:${item.stableKey}`]),
      };
    });
  }

  /** 把当前扫描清单导出为格式化 JSON 文件。 */
  function exportJsonReport() {
    if (!state.reportRows.length) return;
    const payload = {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      creator: state.creatorLabel,
      campaign_id: state.campaignId,
      source_page: location.href,
      timezone_mode: readSettingsFromForm().useLocalTimezone ? 'browser-local' : 'UTC',
      files: buildReportRows(state.items, readSettingsFromForm()),
    };
    downloadTextFile(JSON.stringify(payload, null, 2), reportFilename('json'), 'application/json');
  }

  /** 把当前扫描清单导出为可供表格软件打开的 UTF-8 CSV 文件。 */
  function exportCsvReport() {
    if (!state.reportRows.length) return;
    const rows = buildReportRows(state.items, readSettingsFromForm());
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(','), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))];
    downloadTextFile(`\uFEFF${lines.join('\r\n')}`, reportFilename('csv'), 'text/csv;charset=utf-8');
  }

  /** 生成带日期的清单文件名。 */
  function reportFilename(extension) {
    const today = formatDateParts(new Date().toISOString(), true).date;
    const creator = sanitizeSegment(state.creatorLabel || 'creator', 70);
    return `${creator}__Patreon-file-manifest__${today}.${extension}`;
  }

  /** 转义单个 CSV 单元格。 */
  function csvCell(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  /** 使用浏览器下载属性保存本地文本清单。 */
  function downloadTextFile(content, filename, mimeType) {
    const blobUrl = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    appendLog(`已导出清单：${filename}`);
  }

  /** 将路径片段清理为 Windows、macOS 和 Linux 均可接受的名称。 */
  function sanitizeSegment(value, maxLength = 80) {
    const cleaned = String(value ?? '')
      .normalize('NFKC')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, maxLength);
    if (!cleaned) return 'unnamed';
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
  }

  /** 保留原始扩展名并清理下载文件名。 */
  function sanitizeFilename(value, maxLength = 100) {
    const raw = String(value || 'file.bin');
    const dotIndex = raw.lastIndexOf('.');
    const hasExtension = dotIndex > 0 && raw.length - dotIndex <= 12;
    const extension = hasExtension ? sanitizeSegment(raw.slice(dotIndex), 12) : '';
    const baseLimit = Math.max(12, maxLength - extension.length);
    const base = sanitizeSegment(hasExtension ? raw.slice(0, dotIndex) : raw, baseLimit);
    return `${base}${extension}`;
  }

  /** 为没有媒体 ID 的链接生成稳定短标识。 */
  function stableHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  /** 返回在指定毫秒后完成的 Promise。 */
  function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  /** 追加一行带时间的日志并限制日志长度。 */
  function appendLog(message) {
    const time = new Date().toLocaleTimeString();
    state.logLines.push(`[${time}] ${message}`);
    if (state.logLines.length > 250) state.logLines.splice(0, state.logLines.length - 250);
    state.elements.log.textContent = state.logLines.join('\n');
    state.elements.log.scrollTop = state.elements.log.scrollHeight;
  }

  /** 更新状态提示文字。 */
  function setStatus(message) {
    state.elements.status.textContent = message;
  }

  /** 更新进度条的已完成量与总量。 */
  function setProgress(value, max) {
    state.elements.progress.max = Math.max(1, max);
    state.elements.progress.value = Math.min(value, state.elements.progress.max);
  }

  /** 按当前运行状态启用或禁用操作按钮。 */
  function updateButtons() {
    const busy = state.isScanning || state.isDownloading;
    state.elements.scan.disabled = busy;
    state.elements.download.disabled = busy || state.items.length === 0;
    state.elements.stop.disabled = !busy;
    state.elements.exportJson.disabled = state.items.length === 0;
    state.elements.exportCsv.disabled = state.items.length === 0;
  }

  /** 统一记录并显示可读错误信息。 */
  function handleError(prefix, error) {
    const message = error?.message || String(error);
    setStatus(`${prefix}：${message}`);
    appendLog(`${prefix}：${message}`);
    console.error(`[${SCRIPT_ID}] ${prefix}`, error);
  }

  /** 在下载队列结束时发送油猴桌面通知。 */
  function notifyCompletion(runtime) {
    if (typeof GM_notification !== 'function') return;
    GM_notification({
      title: 'Patreon 订阅文件归档器',
      text: `下载结束：成功 ${runtime.succeeded}，失败 ${runtime.failed}`,
      timeout: 7000,
    });
  }

  main();
}());
