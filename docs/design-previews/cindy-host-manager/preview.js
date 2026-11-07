(function () {
  const state = {
    theme: "light",
    scene: "list",
    viewMode: "list", // "list" | "detail" | "signin"
    listFilter: "all", // "all" | "running" | "stopped" | "error"
    searchQuery: "",
    layout: "stacked",
    activeTab: "accounts",
    selectedId: "codex-1",
    loginActiveTarget: null,
    loginMethod: "google",
    loginEmail: "",
    answerExpanded: false,
    invitationVisible: false,
    defaultProxyUrl: "http://127.0.0.1:7890",
    instances: [
      {
        id: "codex-1",
        name: "My Codex CLI",
        engine: "codex",
        state: "stopped",
        proxyMode: "default",
        proxyUrl: "",
        error: "",
        auth: { cindy: "stored", provider: "missing" },
        accounts: {
          cindy: {
            displayName: "Alex Chen",
            email: "alex@example.com",
            loginMethod: "Cindy 账号",
            plan: "Pro",
            organization: "Cindy Studio",
          },
          provider: null,
        },
        requests: [],
        members: [],
        usage: [],
      },
      {
        id: "claude-team",
        name: "Claude Team Host",
        engine: "claude-code",
        state: "running",
        proxyMode: "custom",
        proxyUrl: "http://proxy.internal:8080",
        error: "",
        auth: { cindy: "stored", provider: "authenticated" },
        accounts: {
          cindy: {
            displayName: "Alex Chen",
            email: "alex@example.com",
            loginMethod: "Cindy 账号",
            plan: "Pro",
            organization: "Cindy Studio",
          },
          provider: {
            displayName: "dev-team@example.com",
            email: "dev-team@example.com",
            loginMethod: "Claude 账号",
            plan: "Max 20x",
            organization: "Engineering Org",
          },
        },
        requests: [
          {
            requestId: "req-1",
            displayName: "Guest User (林晓)",
            expiresAt: "2026/11/07 15:40:00",
          },
        ],
        members: [
          { memberId: "m-1", displayName: "Alice Wang", status: "active" },
          { memberId: "m-2", displayName: "Bob Li", status: "paused" },
        ],
        usage: [
          {
            memberName: "Alice Wang",
            model: "claude-sonnet-5-5",
            turns: 42,
            inputTokens: "128,400",
            outputTokens: "34,120",
          },
          {
            memberName: "Bob Li",
            model: "claude-opus-5-5",
            turns: 8,
            inputTokens: "45,000",
            outputTokens: "12,800",
          },
        ],
      },
      {
        id: "backup-runner",
        name: "Backup Runner",
        engine: "codex",
        state: "error",
        proxyMode: "none",
        proxyUrl: "",
        error: "实例未能及时停止或容器状态异常。请先检查实例或重新启动后再试。",
        auth: { cindy: "stored", provider: "authenticated" },
        accounts: {
          cindy: {
            displayName: "Alex Chen",
            email: "alex@example.com",
            loginMethod: "Cindy 账号",
            plan: "Pro",
          },
          provider: {
            displayName: "ops@example.com",
            email: "ops@example.com",
            loginMethod: "ChatGPT 账号",
            plan: "Plus",
          },
        },
        requests: [],
        members: [],
        usage: [],
      },
    ],
  };

  function showToast(text, kind) {
    const layer = document.getElementById("toast-layer");
    if (!layer) return;
    const pill = document.createElement("div");
    pill.className = "toast-pill";
    const dot = document.createElement("span");
    dot.className = "toast-dot" + (kind ? " " + kind : "");
    const span = document.createElement("span");
    span.textContent = text;
    pill.append(dot, span);
    layer.appendChild(pill);
    setTimeout(() => {
      pill.remove();
    }, 2400);
  }

  function stateLabel(s) {
    if (s === "running") return { text: "容器运行中", dot: "ok" };
    if (s === "stopped") return { text: "已停止", dot: "" };
    if (s === "busy") return { text: "正在处理…", dot: "busy" };
    if (s === "error") return { text: "错误", dot: "err" };
    return { text: "未知", dot: "" };
  }

  function engineName(engine) {
    return engine === "codex" ? "Codex" : "Claude Code";
  }

  function proxyText(inst) {
    if (inst.proxyMode === "none") return "不使用 Proxy";
    if (inst.proxyMode === "default")
      return state.defaultProxyUrl
        ? `使用默认 Proxy (${state.defaultProxyUrl})`
        : "使用默认 Proxy (未配置)";
    return `自定义 Proxy (${inst.proxyUrl || "未填写"})`;
  }

  function enterInstanceDetail(id, options) {
    state.selectedId = id;
    state.viewMode = "detail";
    state.loginActiveTarget = options?.loginTarget ?? null;
    if (options?.invitationVisible !== undefined) {
      state.invitationVisible = options.invitationVisible;
    }
    syncSceneButtons();
    renderAll();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderListPage() {
    const proxyBtn = document.getElementById("list-proxy-btn");
    if (proxyBtn) {
      proxyBtn.textContent = state.defaultProxyUrl
        ? `⚙ 默认 HTTP Proxy：${state.defaultProxyUrl}`
        : "⚙ 默认 HTTP Proxy：未配置";
    }

    // 渲染筛选胶囊
    const filterGroup = document.getElementById("list-filter-group");
    if (filterGroup) {
      const counts = {
        all: state.instances.length,
        running: state.instances.filter((i) => i.state === "running").length,
        stopped: state.instances.filter((i) => i.state === "stopped").length,
        error: state.instances.filter((i) => i.state === "error").length,
      };
      const items = [
        { key: "all", label: `全部 (${counts.all})` },
        { key: "running", label: `运行中 (${counts.running})` },
        { key: "stopped", label: `已停止 (${counts.stopped})` },
        { key: "error", label: `异常 (${counts.error})` },
      ];
      filterGroup.innerHTML = items
        .map(
          (f) => `
        <button type="button" data-filter-key="${f.key}" aria-pressed="${state.listFilter === f.key}">
          ${f.label}
        </button>
      `,
        )
        .join("");
      filterGroup.querySelectorAll("[data-filter-key]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.listFilter = btn.getAttribute("data-filter-key");
          renderListPage();
        });
      });
    }

    // 过滤列表
    const container = document.getElementById("instance-rows-container");
    if (!container) return;

    const q = state.searchQuery.trim().toLowerCase();
    const filtered = state.instances.filter((inst) => {
      if (state.listFilter !== "all" && inst.state !== state.listFilter) {
        return false;
      }
      if (!q) return true;
      const hay = [
        inst.name,
        engineName(inst.engine),
        inst.accounts.cindy?.displayName || "",
        inst.accounts.cindy?.email || "",
        inst.accounts.provider?.displayName || "",
        inst.accounts.provider?.email || "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });

    if (filtered.length === 0) {
      container.innerHTML = `
        <div style="padding: 36px 24px; text-align: center; color: var(--text-secondary);">
          没有符合筛选条件的实例。
        </div>
      `;
      return;
    }

    container.innerHTML = filtered
      .map((inst) => {
        const st = stateLabel(inst.state);
        const pName = engineName(inst.engine);
        const cindyOk = inst.auth.cindy === "stored";
        const provOk = inst.auth.provider === "authenticated";
        const isRunning = inst.state === "running";
        const proxyShort =
          inst.proxyMode === "none"
            ? "直连 (无 Proxy)"
            : inst.proxyMode === "default"
              ? "默认 Proxy"
              : `自定义 (${inst.proxyUrl || "未设"})`;

        const cindySub =
          cindyOk && inst.accounts.cindy
            ? `${inst.accounts.cindy.displayName}${inst.accounts.cindy.plan ? ` · ${inst.accounts.cindy.plan}` : ""}`
            : "点击进入详情登录";

        const provSub =
          provOk && inst.accounts.provider
            ? `${inst.accounts.provider.displayName}${inst.accounts.provider.plan ? ` · ${inst.accounts.provider.plan}` : ""}`
            : `点击进入详情登录 ${pName}`;

        const shareBadges = [];
        if (inst.requests.length > 0) {
          shareBadges.push(
            `<span class="badge"><span class="dot warn"></span>${inst.requests.length} 待审批</span>`,
          );
        }
        if (inst.members.length > 0) {
          const activeCount = inst.members.filter((m) => m.status === "active").length;
          shareBadges.push(
            `<span class="badge subtle">${activeCount}/${inst.members.length} 成员活跃</span>`,
          );
        }

        return `
          <div class="instance-row-card" data-row-instance="${inst.id}" role="button" tabindex="0" aria-label="进入 ${escapeHtml(inst.name)} 详情页">
            <!-- 列 1：名称 / 引擎 / Proxy -->
            <div class="row-col-main">
              <div class="row-name-line">
                <span class="row-name">${escapeHtml(inst.name)}</span>
                <span class="badge subtle">${pName}</span>
              </div>
              <div class="row-subline">
                <span>${escapeHtml(proxyShort)}</span>
              </div>
              ${
                inst.error
                  ? `<div class="row-error-hint">⚠ ${escapeHtml(inst.error)}</div>`
                  : ""
              }
            </div>

            <!-- 列 2：运行状态 -->
            <div>
              <span class="badge"><span class="dot ${st.dot}"></span>${st.text}</span>
            </div>

            <!-- 列 3：Cindy 账号 -->
            <div class="row-account-cell">
              <div class="row-account-status">
                <span class="dot ${cindyOk ? "ok" : "warn"}"></span>
                <span>${cindyOk ? "已保存" : "未保存登录"}</span>
              </div>
              <div class="row-account-detail">${escapeHtml(cindySub)}</div>
            </div>

            <!-- 列 4：供应商账号 -->
            <div class="row-account-cell">
              <div class="row-account-status">
                <span class="dot ${provOk ? "ok" : "warn"}"></span>
                <span>${provOk ? `${pName} 已保存` : `${pName} 未登录`}</span>
              </div>
              <div class="row-account-detail">${escapeHtml(provSub)}</div>
            </div>

            <!-- 列 5：分享概况 & 快捷操作 + 进入详情 -->
            <div class="row-actions-cell">
              ${shareBadges.join("")}
              ${
                isRunning
                  ? `<button type="button" class="btn sm" data-quick-stop="${inst.id}" title="直接停止容器">■ 停止</button>`
                  : `<button type="button" class="btn sm" data-quick-start="${inst.id}" title="直接启动容器">▶ 启动</button>`
              }
              <button type="button" class="btn sm primary" data-enter-detail="${inst.id}">
                管理详情 →
              </button>
            </div>
          </div>
        `;
      })
      .join("");

    // 绑定整行点击进入详情页
    container.querySelectorAll("[data-row-instance]").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        const id = row.getAttribute("data-row-instance");
        state.scene = "detail";
        enterInstanceDetail(id);
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const id = row.getAttribute("data-row-instance");
          state.scene = "detail";
          enterInstanceDetail(id);
        }
      });
    });

    container.querySelectorAll("[data-enter-detail]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-enter-detail");
        state.scene = "detail";
        enterInstanceDetail(id);
      });
    });

    // 列表行内快捷启动/停止（不离开列表页）
    container.querySelectorAll("[data-quick-start]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-quick-start");
        const inst = state.instances.find((i) => i.id === id);
        if (inst) {
          inst.state = "running";
          inst.error = "";
          showToast(`已在列表直接启动 "${inst.name}"`, "");
          renderListPage();
        }
      });
    });

    container.querySelectorAll("[data-quick-stop]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-quick-stop");
        const inst = state.instances.find((i) => i.id === id);
        if (inst) {
          inst.state = "stopped";
          showToast(`已在列表直接停止 "${inst.name}"`, "");
          renderListPage();
        }
      });
    });
  }

  function renderDetail() {
    const pane = document.getElementById("detail-pane");
    const breadName = document.getElementById("breadcrumb-instance-name");
    const switcher = document.getElementById("quick-instance-switcher");
    if (!pane) return;
    const inst = state.instances.find((i) => i.id === state.selectedId);
    if (!inst) return;

    if (breadName) breadName.textContent = inst.name;
    if (switcher) {
      switcher.innerHTML = state.instances
        .map(
          (item) => `
        <option value="${item.id}" ${item.id === inst.id ? "selected" : ""}>
          ${escapeHtml(item.name)} (${engineName(item.engine)} · ${stateLabel(item.state).text})
        </option>
      `,
        )
        .join("");
    }

    const st = stateLabel(inst.state);
    const isRunning = inst.state === "running";
    const cindySaved = inst.auth.cindy === "stored";
    const providerSaved = inst.auth.provider === "authenticated";
    const pName = engineName(inst.engine);

    let html = "";

    // 1. 顶部实例概览头卡
    html += `
      <section class="hero-card" aria-label="实例概览">
        <div class="hero-top">
          <div>
            <div class="hero-title-row">
              <h2>${escapeHtml(inst.name)}</h2>
              <span class="badge subtle">${pName}</span>
              <span class="badge"><span class="dot ${st.dot}"></span>${st.text}</span>
            </div>
            <div class="hero-sub">
              <span>HTTP Proxy：${escapeHtml(proxyText(inst))}</span>
              <span>·</span>
              <span>容器运行不代表 Cindy 已连接，请在客户端检查可用性</span>
            </div>
          </div>
          <div class="hero-actions">
            ${
              !isRunning
                ? `<button type="button" class="btn cta" id="act-start">▶ 启动实例</button>`
                : `<button type="button" class="btn" id="act-stop">■ 停止</button>
                   <button type="button" class="btn" id="act-restart">↻ 重启</button>`
            }
            <button type="button" class="btn" id="act-check">检查已保存的登录</button>
            <button type="button" class="btn" id="act-open-instance-settings">⚙ 实例与 Proxy</button>
          </div>
        </div>
        <div class="hero-footer">
          <div class="readiness-steps">
            <span>启动就绪检查：</span>
            <span class="step-item"><span class="dot ${cindySaved ? "ok" : "warn"}"></span>① Cindy 账号：${cindySaved ? "已保存" : "待登录"}</span>
            <span class="step-item"><span class="dot ${providerSaved ? "ok" : "warn"}"></span>② ${pName} 账号：${providerSaved ? "已保存" : "待登录"}</span>
          </div>
          <span>${isRunning ? "🔒 运行中：修改 Proxy 或重新登录请先停止实例" : "✓ 已停止：可随时登录账号或修改 Proxy 配置"}</span>
        </div>
      </section>
    `;

    // 错误卡片（若存在）
    if (inst.error) {
      html += `
        <div class="error-card" role="alert">
          <div class="error-card-body">
            <span class="dot err" style="margin-top: 5px;"></span>
            <div>
              <div class="error-card-title">实例运行异常</div>
              <div class="error-card-desc">${escapeHtml(inst.error)}</div>
            </div>
          </div>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn sm" id="act-clear-error">忽略提示</button>
            <button type="button" class="btn sm cta" id="act-recover-start">重新启动实例</button>
          </div>
        </div>
      `;
    }

    // 方案 B：Tab 切换栏
    if (state.layout === "tabs") {
      const reqCount = inst.requests.length;
      html += `
        <div class="view-tabs" role="tablist" aria-label="实例管理分区">
          <button type="button" role="tab" data-tab="accounts" aria-selected="${state.activeTab === "accounts"}">
            账号与登录 ${cindySaved && providerSaved ? "✓" : "●"}
          </button>
          <button type="button" role="tab" data-tab="sharing" aria-selected="${state.activeTab === "sharing"}">
            供应商分享 ${reqCount ? `(${reqCount} 待审批)` : ""}
          </button>
          <button type="button" role="tab" data-tab="settings" aria-selected="${state.activeTab === "settings"}">
            实例与 Proxy 设置
          </button>
        </div>
      `;
    }

    const showAccounts = state.layout === "stacked" || state.activeTab === "accounts";
    const showSharing = state.layout === "stacked" || state.activeTab === "sharing";
    const showSettingsInline = state.layout === "tabs" && state.activeTab === "settings";

    // 2. 账号与登录双卡区
    if (showAccounts) {
      html += `
        <section class="section-block" aria-label="账号与登录">
          <div class="section-header">
            <div>
              <h3>账号与登录</h3>
              <p class="section-sub">${
                isRunning
                  ? "实例运行期间账号只读；如需切换账号或重新授权，请先点击上方“停止”。"
                  : "停止状态下可直接点击对应卡片发起原生 CLI 登录，登录结束后会自动核验保存状态。"
              }</p>
            </div>
            ${
              isRunning
                ? `<button type="button" class="btn sm" id="quick-stop-for-login">停止实例以登录账号</button>`
                : ""
            }
          </div>

          <div class="accounts-grid">
            <!-- 左卡：Cindy 账号 -->
            <div class="account-card">
              <div>
                <div class="account-card-head">
                  <div>
                    <h4 class="account-card-title">Cindy 账号</h4>
                    <div class="account-card-role">用于连接你的 Cindy 设备与远程供应商通道</div>
                  </div>
                  <span class="badge"><span class="dot ${cindySaved ? "ok" : "warn"}"></span>${cindySaved ? "已保存" : "未保存登录"}</span>
                </div>
                <div style="margin-top: 14px;">
                  ${
                    cindySaved && inst.accounts.cindy
                      ? `<div class="account-identity-box">
                           <div class="account-primary-name">${escapeHtml(inst.accounts.cindy.displayName)}</div>
                           <div class="account-email">${escapeHtml(inst.accounts.cindy.email || "")}</div>
                           <div class="account-meta-dl">
                             <span>登录方式：<strong>${escapeHtml(inst.accounts.cindy.loginMethod)}</strong></span>
                             ${inst.accounts.cindy.plan ? `<span>套餐：<strong>${escapeHtml(inst.accounts.cindy.plan)}</strong></span>` : ""}
                             ${inst.accounts.cindy.organization ? `<span>组织：<strong>${escapeHtml(inst.accounts.cindy.organization)}</strong></span>` : ""}
                           </div>
                         </div>`
                      : `<div class="account-empty-box">尚未保存 Cindy 账号登录凭证。请选择 Google 或邮箱方式完成登录。</div>`
                  }
                </div>
              </div>
              <div class="account-card-actions">
                <select class="select" id="cindy-login-method" aria-label="Cindy 登录方式" ${isRunning ? "disabled" : ""}>
                  <option value="google" ${state.loginMethod === "google" ? "selected" : ""}>Google 登录</option>
                  <option value="email" ${state.loginMethod === "email" ? "selected" : ""}>邮箱验证码登录</option>
                </select>
                ${
                  state.loginMethod === "email"
                    ? `<input class="input" id="cindy-login-email" type="email" placeholder="输入邮箱地址" value="${escapeHtml(state.loginEmail)}" ${isRunning ? "disabled" : ""} />`
                    : ""
                }
                <button type="button" class="btn ${cindySaved ? "" : "cta"}" id="btn-login-cindy" ${isRunning ? "disabled" : ""}>
                  ${cindySaved ? "重新登录 Cindy" : "登录 Cindy"}
                </button>
              </div>
            </div>

            <!-- 右卡：Provider 供应商账号 -->
            <div class="account-card">
              <div>
                <div class="account-card-head">
                  <div>
                    <h4 class="account-card-title">${pName} 供应商账号</h4>
                    <div class="account-card-role">提供容器内原生 ${pName} CLI 的模型执行额度</div>
                  </div>
                  <span class="badge"><span class="dot ${providerSaved ? "ok" : "warn"}"></span>${providerSaved ? "已保存" : "未保存登录"}</span>
                </div>
                <div style="margin-top: 14px;">
                  ${
                    providerSaved && inst.accounts.provider
                      ? `<div class="account-identity-box">
                           <div class="account-primary-name">${escapeHtml(inst.accounts.provider.displayName)}</div>
                           <div class="account-email">${escapeHtml(inst.accounts.provider.email || "")}</div>
                           <div class="account-meta-dl">
                             <span>登录方式：<strong>${escapeHtml(inst.accounts.provider.loginMethod)}</strong></span>
                             ${inst.accounts.provider.plan ? `<span>套餐：<strong>${escapeHtml(inst.accounts.provider.plan)}</strong></span>` : ""}
                             ${inst.accounts.provider.organization ? `<span>组织：<strong>${escapeHtml(inst.accounts.provider.organization)}</strong></span>` : ""}
                           </div>
                         </div>`
                      : `<div class="account-empty-box">尚未保存 ${pName} 登录凭证。点击下方按钮拉起原生 CLI 授权链接。</div>`
                  }
                </div>
              </div>
              <div class="account-card-actions">
                <button type="button" class="btn ${!providerSaved && !isRunning ? "cta" : ""}" id="btn-login-provider" ${isRunning ? "disabled" : ""}>
                  ${providerSaved ? `重新登录 ${pName}` : `登录 ${pName} 账号`}
                </button>
              </div>
            </div>
          </div>

          ${state.loginActiveTarget ? renderTerminalHtml(inst) : ""}
        </section>
      `;
    }

    // 3. 供应商分享与用量区
    if (showSharing) {
      html += `
        <section class="section-block" aria-label="供应商分享">
          <div class="section-header">
            <div>
              <h3>供应商分享</h3>
              <p class="section-sub">生成一次性分享链接、核对接收人 4 位配对码审批申请，并管理各成员调用状态与 Token 用量。</p>
            </div>
            ${
              isRunning
                ? `<div style="display: flex; gap: 8px;">
                     <button type="button" class="btn sm" id="btn-refresh-share">↻ 刷新分享数据</button>
                     <button type="button" class="btn sm cta" id="btn-create-invite">+ 创建邀请链接</button>
                   </div>`
                : ""
            }
          </div>

          ${
            !isRunning
              ? `<div class="empty-state-banner">
                   <div>
                     <strong style="font-size: 14px;">启动实例后即可管理供应商分享</strong>
                     <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
                       分享功能需要容器处于运行状态，以便实时读取待处理申请、成员列表与模型用量。
                     </div>
                   </div>
                   <button type="button" class="btn primary" id="banner-start-btn">▶ 立即启动实例</button>
                 </div>`
              : renderRunningShareHtml(inst)
          }
        </section>
      `;
    }

    // 方案 B 的独立设置 Tab
    if (showSettingsInline) {
      html += `
        <section class="card-panel" aria-label="实例与 Proxy 设置">
          <div>
            <h3 style="margin: 0; font-size: 16px;">实例名称与 HTTP Proxy</h3>
            <p class="section-sub" style="margin-top: 4px;">
              ${isRunning ? "当前实例正在运行，修改 Proxy 前请先停止实例。" : "实例已停止，可直接修改并测试 Proxy 出口。"}
            </p>
          </div>
          <label class="field" style="max-width: 480px;">
            <span>实例名称</span>
            <input class="input" value="${escapeHtml(inst.name)}" />
          </label>
          <label class="field" style="max-width: 480px;">
            <span>HTTP Proxy 模式</span>
            <select class="select" ${isRunning ? "disabled" : ""}>
              <option value="none" ${inst.proxyMode === "none" ? "selected" : ""}>不使用 Proxy</option>
              <option value="default" ${inst.proxyMode === "default" ? "selected" : ""}>使用默认 Proxy (${escapeHtml(state.defaultProxyUrl || "未配置")})</option>
              <option value="custom" ${inst.proxyMode === "custom" ? "selected" : ""}>自定义 Proxy</option>
            </select>
          </label>
          <div>
            <button type="button" class="btn cta" id="inline-save-settings-btn">保存修改</button>
          </div>
        </section>
      `;
    }

    pane.innerHTML = html;
    bindDetailEvents(inst);
  }

  function renderTerminalHtml(inst) {
    const targetName =
      state.loginActiveTarget === "cindy" ? "Cindy 账号" : `${engineName(inst.engine)} 供应商账号`;
    const authHost =
      state.loginActiveTarget === "cindy"
        ? "auth.cindy.example"
        : inst.engine === "codex"
          ? "auth.openai.com"
          : "claude.ai";
    const authUrl = `https://${authHost}/oauth/authorize?client_id=cindy-cli&state=9f8e7d6c5b`;

    return `
      <div class="terminal-card" role="region" aria-label="登录终端">
        <div class="terminal-header">
          <div class="terminal-title-group">
            <h4>登录终端 · ${escapeHtml(targetName)}</h4>
            <span class="badge"><span class="dot ok"></span>已连接</span>
          </div>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn sm" id="term-copy-sel">复制选中文本</button>
            <button type="button" class="btn sm" id="term-simulate-done">✓ 模拟完成授权</button>
            <button type="button" class="btn sm danger-outline" id="term-close">✕ 取消并关闭</button>
          </div>
        </div>

        <!-- 置顶高亮的浏览器授权引导条 -->
        <div class="oauth-link-banner">
          <div class="oauth-step-text">
            <strong>🔗 第一步：请在浏览器中打开下方授权链接完成登录</strong>
            <span>完成网页授权前请保持此终端开启；终端区域仅显示输出，关闭将取消本次登录。</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <a href="${authUrl}" target="_blank" rel="noopener noreferrer" class="btn sm cta" style="text-decoration: none;">
              ↗ 打开登录页面 (${authHost})
            </a>
            <button type="button" class="btn sm" id="term-copy-link" data-url="${authUrl}">复制授权链接</button>
          </div>
        </div>

        <div class="terminal-screen">[cindy-host] Starting native ${escapeHtml(targetName)} login flow...
[cindy-host] Using proxy: ${escapeHtml(proxyText(inst))}

Open this link in your browser to sign in:
${authUrl}

Waiting for authentication callback or verification code...</div>

        <div class="terminal-footer">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
            <span class="field-hint">仅当原生登录提示输入验证码、选择账号或其他回答时，展开下方输入框提交单行内容：</span>
            <button type="button" class="btn sm" id="term-toggle-answer">
              ${state.answerExpanded ? "收起验证码/回答输入 ▴" : "输入登录所需内容 ▾"}
            </button>
          </div>
          ${
            state.answerExpanded
              ? `<form class="terminal-answer-row" id="term-answer-form">
                   <input class="input" type="password" id="term-answer-input" placeholder="输入验证码或选择序号（单行掩码输入，提交后立即清空）" required />
                   <button type="submit" class="btn sm cta">提交内容</button>
                 </form>`
              : ""
          }
        </div>
      </div>
    `;
  }

  function renderRunningShareHtml(inst) {
    return `
      <div class="card-panel">
        ${
          state.invitationVisible
            ? `<div class="invitation-box">
                 <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                   <strong style="font-size: 13px;">🔗 临时邀请链接（5 分钟内单次有效，请仅发给预期接收人）</strong>
                   <button type="button" class="btn sm" id="btn-close-invite">关闭</button>
                 </div>
                 <div class="invitation-row">
                   <input class="input" readonly value="https://cindy.example/provider-share/invite#e89b12d4-77a1-4c90-9f1b" />
                   <button type="button" class="btn sm cta" id="btn-copy-invite">复制链接</button>
                 </div>
                 <span class="field-hint">到期时间：2026/11/07 15:35:00 · 接收人打开链接并提交申请后，将在下方“待处理申请”中显示。</span>
               </div>`
            : ""
        }

        <!-- 待处理申请 -->
        <div>
          <div class="sub-heading">
            <span>待处理申请 (${inst.requests.length})</span>
            <span class="field-hint">请向接收人核对 4 位数字配对码后再批准</span>
          </div>
          ${
            inst.requests.length === 0
              ? `<div class="account-empty-box">暂无待处理申请。</div>`
              : `<div class="list-box">
                   ${inst.requests
                     .map(
                       (req) => `
                     <form class="list-row" data-approve-id="${req.requestId}">
                       <div class="person-info">
                         <span class="avatar-circle">${escapeHtml(req.displayName.slice(0, 1))}</span>
                         <div class="person-meta">
                           <strong>${escapeHtml(req.displayName)}</strong>
                           <span>到期时间：${escapeHtml(req.expiresAt)}</span>
                         </div>
                       </div>
                       <div class="pairing-actions">
                         <input class="input code-input" name="code" placeholder="4位配对码" maxlength="4" pattern="[0-9]{4}" value="1234" required aria-label="接收人提供的配对码" />
                         <button type="submit" class="btn sm cta">✓ 批准</button>
                         <button type="button" class="btn sm danger-outline" data-reject-id="${req.requestId}">拒绝</button>
                       </div>
                     </form>
                   `,
                     )
                     .join("")}
                 </div>`
          }
        </div>

        <!-- 已授权成员 -->
        <div>
          <div class="sub-heading">
            <span>成员 (${inst.members.length})</span>
          </div>
          ${
            inst.members.length === 0
              ? `<div class="account-empty-box">暂无分享成员。</div>`
              : `<div class="list-box">
                   ${inst.members
                     .map(
                       (m) => `
                     <div class="list-row">
                       <div class="person-info">
                         <span class="avatar-circle">${escapeHtml(m.displayName.slice(0, 1))}</span>
                         <div class="person-meta">
                           <strong>${escapeHtml(m.displayName)}</strong>
                           <span>${m.status === "active" ? "可正常远程调用此供应商" : "已暂停调用权限"}</span>
                         </div>
                       </div>
                       <div class="pairing-actions">
                         <span class="badge"><span class="dot ${m.status === "active" ? "ok" : ""}"></span>${m.status === "active" ? "活跃" : "已暂停"}</span>
                         <button type="button" class="btn sm" data-toggle-member="${m.memberId}">
                           ${m.status === "active" ? "暂停" : "恢复"}
                         </button>
                         <button type="button" class="btn sm danger-outline" data-remove-member="${m.memberId}">移除</button>
                       </div>
                     </div>
                   `,
                     )
                     .join("")}
                 </div>`
          }
        </div>

        <!-- 用量统计 -->
        <div>
          <div class="sub-heading">
            <span>成员用量统计</span>
          </div>
          ${
            inst.usage.length === 0
              ? `<div class="account-empty-box">暂无用量数据。</div>`
              : `<div class="table-wrap">
                   <table>
                     <thead>
                       <tr>
                         <th>成员</th>
                         <th>模型</th>
                         <th class="num">轮数</th>
                         <th class="num">输入 Token</th>
                         <th class="num">输出 Token</th>
                       </tr>
                     </thead>
                     <tbody>
                       ${inst.usage
                         .map(
                           (u) => `
                         <tr>
                           <td><strong>${escapeHtml(u.memberName)}</strong></td>
                           <td><code>${escapeHtml(u.model)}</code></td>
                           <td class="num">${u.turns}</td>
                           <td class="num">${u.inputTokens}</td>
                           <td class="num">${u.outputTokens}</td>
                         </tr>
                       `,
                         )
                         .join("")}
                     </tbody>
                   </table>
                 </div>`
          }
        </div>
      </div>
    `;
  }

  function bindDetailEvents(inst) {
    const startBtn = document.getElementById("act-start");
    const bannerStartBtn = document.getElementById("banner-start-btn");
    const recoverStartBtn = document.getElementById("act-recover-start");
    [startBtn, bannerStartBtn, recoverStartBtn].forEach((btn) => {
      if (btn) {
        btn.addEventListener("click", () => {
          inst.state = "running";
          inst.error = "";
          state.loginActiveTarget = null;
          showToast(`已启动实例 "${inst.name}"，并自动加载分享列表`, "");
          syncSceneButtons();
          renderAll();
        });
      }
    });

    const stopBtn = document.getElementById("act-stop");
    const quickStopBtn = document.getElementById("quick-stop-for-login");
    [stopBtn, quickStopBtn].forEach((btn) => {
      if (btn) {
        btn.addEventListener("click", () => {
          inst.state = "stopped";
          showToast(`实例 "${inst.name}" 已停止，现在可以登录账号或修改 Proxy`, "");
          syncSceneButtons();
          renderAll();
        });
      }
    });

    const restartBtn = document.getElementById("act-restart");
    if (restartBtn) {
      restartBtn.addEventListener("click", () => {
        showToast(`正在重启 "${inst.name}"…`, "pending");
        setTimeout(() => showToast(`实例 "${inst.name}" 重启完成`, ""), 700);
      });
    }

    const checkBtn = document.getElementById("act-check");
    if (checkBtn) {
      checkBtn.addEventListener("click", () => {
        showToast("正在检查已保存的登录…", "pending");
        setTimeout(() => showToast("登录状态已核验更新", ""), 600);
      });
    }

    const clearErrBtn = document.getElementById("act-clear-error");
    if (clearErrBtn) {
      clearErrBtn.addEventListener("click", () => {
        inst.error = "";
        renderAll();
      });
    }

    const openInstSettingsBtn = document.getElementById("act-open-instance-settings");
    if (openInstSettingsBtn) {
      openInstSettingsBtn.addEventListener("click", () => {
        openInstanceSettingsModal(inst);
      });
    }

    // Tab 切换
    document.querySelectorAll("[data-tab]").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        state.activeTab = tabBtn.getAttribute("data-tab");
        renderDetail();
      });
    });

    // Cindy 登录方式切换
    const methodSel = document.getElementById("cindy-login-method");
    if (methodSel) {
      methodSel.addEventListener("change", (e) => {
        state.loginMethod = e.target.value;
        renderDetail();
      });
    }
    const emailInput = document.getElementById("cindy-login-email");
    if (emailInput) {
      emailInput.addEventListener("input", (e) => {
        state.loginEmail = e.target.value;
      });
    }

    // 发起登录
    const loginCindyBtn = document.getElementById("btn-login-cindy");
    if (loginCindyBtn) {
      loginCindyBtn.addEventListener("click", () => {
        state.loginActiveTarget = "cindy";
        showToast("已启动 Cindy 原生登录终端", "");
        renderDetail();
      });
    }
    const loginProviderBtn = document.getElementById("btn-login-provider");
    if (loginProviderBtn) {
      loginProviderBtn.addEventListener("click", () => {
        state.loginActiveTarget = "provider";
        showToast(`已启动 ${engineName(inst.engine)} 原生登录终端`, "");
        renderDetail();
      });
    }

    // 终端内部操作
    const termClose = document.getElementById("term-close");
    if (termClose) {
      termClose.addEventListener("click", () => {
        state.loginActiveTarget = null;
        showToast("已关闭登录终端", "");
        renderDetail();
      });
    }
    const termDone = document.getElementById("term-simulate-done");
    if (termDone) {
      termDone.addEventListener("click", () => {
        if (state.loginActiveTarget === "cindy") {
          inst.auth.cindy = "stored";
          inst.accounts.cindy = {
            displayName: "Alex Chen",
            email: state.loginEmail || "alex@example.com",
            loginMethod: "Cindy 账号",
            plan: "Pro",
          };
        } else {
          inst.auth.provider = "authenticated";
          inst.accounts.provider = {
            displayName: "alex-dev@example.com",
            email: "alex-dev@example.com",
            loginMethod: inst.engine === "codex" ? "ChatGPT 账号" : "Claude 账号",
            plan: inst.engine === "codex" ? "Pro" : "Max",
          };
        }
        state.loginActiveTarget = null;
        showToast("登录进程已结束，已验证并保存账号凭证！", "");
        renderAll();
      });
    }
    const termCopyLink = document.getElementById("term-copy-link");
    if (termCopyLink) {
      termCopyLink.addEventListener("click", () => {
        const url = termCopyLink.getAttribute("data-url");
        if (navigator.clipboard && url) {
          navigator.clipboard.writeText(url).catch(() => {});
        }
        showToast("已复制授权链接到剪贴板", "");
      });
    }
    const termCopySel = document.getElementById("term-copy-sel");
    if (termCopySel) {
      termCopySel.addEventListener("click", () => {
        showToast("已复制终端选中文本", "");
      });
    }
    const termToggleAnswer = document.getElementById("term-toggle-answer");
    if (termToggleAnswer) {
      termToggleAnswer.addEventListener("click", () => {
        state.answerExpanded = !state.answerExpanded;
        renderDetail();
      });
    }
    const termAnswerForm = document.getElementById("term-answer-form");
    if (termAnswerForm) {
      termAnswerForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const inp = document.getElementById("term-answer-input");
        if (inp) inp.value = "";
        showToast("内容已提交给原生登录进程", "");
      });
    }

    // 分享操作
    const createInviteBtn = document.getElementById("btn-create-invite");
    if (createInviteBtn) {
      createInviteBtn.addEventListener("click", () => {
        state.invitationVisible = true;
        showToast("已生成一次性邀请链接", "");
        renderDetail();
      });
    }
    const closeInviteBtn = document.getElementById("btn-close-invite");
    if (closeInviteBtn) {
      closeInviteBtn.addEventListener("click", () => {
        state.invitationVisible = false;
        renderDetail();
      });
    }
    const copyInviteBtn = document.getElementById("btn-copy-invite");
    if (copyInviteBtn) {
      copyInviteBtn.addEventListener("click", () => {
        showToast("邀请链接已复制", "");
      });
    }
    const refreshShareBtn = document.getElementById("btn-refresh-share");
    if (refreshShareBtn) {
      refreshShareBtn.addEventListener("click", () => {
        showToast("分享申请、成员与用量已刷新", "");
      });
    }

    // 审批申请
    document.querySelectorAll("[data-approve-id]").forEach((form) => {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const reqId = form.getAttribute("data-approve-id");
        const idx = inst.requests.findIndex((r) => r.requestId === reqId);
        if (idx !== -1) {
          const req = inst.requests.splice(idx, 1)[0];
          inst.members.push({
            memberId: "m-" + Date.now(),
            displayName: req.displayName,
            status: "active",
          });
          showToast(`已核对配对码并批准 ${req.displayName} 的分享申请`, "");
          renderDetail();
        }
      });
    });
    document.querySelectorAll("[data-reject-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const reqId = btn.getAttribute("data-reject-id");
        inst.requests = inst.requests.filter((r) => r.requestId !== reqId);
        showToast("已拒绝该分享申请", "");
        renderDetail();
      });
    });

    // 成员暂停/恢复/移除
    document.querySelectorAll("[data-toggle-member]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mId = btn.getAttribute("data-toggle-member");
        const member = inst.members.find((m) => m.memberId === mId);
        if (member) {
          member.status = member.status === "active" ? "paused" : "active";
          showToast(
            member.status === "active"
              ? `已恢复 ${member.displayName} 的访问权限`
              : `已暂停 ${member.displayName} 的访问权限`,
            "",
          );
          renderDetail();
        }
      });
    });
    document.querySelectorAll("[data-remove-member]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mId = btn.getAttribute("data-remove-member");
        inst.members = inst.members.filter((m) => m.memberId !== mId);
        showToast("已移除该成员", "");
        renderDetail();
      });
    });
  }

  function openInstanceSettingsModal(inst) {
    const modal = document.getElementById("modal-instance-settings");
    const nameInp = document.getElementById("instance-name-input");
    const modeSel = document.getElementById("instance-proxy-mode-input");
    const urlInp = document.getElementById("instance-proxy-url-input");
    const customBox = document.getElementById("instance-custom-proxy-box");
    const note = document.getElementById("instance-settings-note");
    if (!modal) return;
    nameInp.value = inst.name;
    modeSel.value = inst.proxyMode;
    urlInp.value = inst.proxyUrl || "http://proxy.internal:8080";
    const isRunning = inst.state === "running";
    modeSel.disabled = isRunning;
    urlInp.disabled = isRunning;
    customBox.hidden = modeSel.value !== "custom";
    note.textContent = isRunning
      ? "🔒 当前实例正在运行：仅可修改显示名称；如需修改 Proxy，请先停止实例。"
      : "修改实例显示名称或独立 Proxy 配置。";
    modal.hidden = false;
  }

  function applyScene(scene) {
    state.scene = scene;
    if (scene === "signin") {
      state.viewMode = "signin";
      syncSceneButtons();
      renderAll();
      return;
    }

    if (scene === "list") {
      state.viewMode = "list";
      syncSceneButtons();
      renderAll();
      return;
    }

    state.viewMode = "detail";
    if (scene === "stopped") {
      state.selectedId = "codex-1";
      state.loginActiveTarget = null;
    } else if (scene === "login") {
      state.selectedId = "codex-1";
      state.loginActiveTarget = "provider";
    } else if (scene === "running") {
      state.selectedId = "claude-team";
      state.loginActiveTarget = null;
      state.invitationVisible = true;
    } else if (scene === "error") {
      state.selectedId = "backup-runner";
      state.loginActiveTarget = null;
    }
    syncSceneButtons();
    renderAll();
  }

  function syncSceneButtons() {
    document.querySelectorAll("[data-scene]").forEach((btn) => {
      btn.setAttribute(
        "aria-pressed",
        String(btn.getAttribute("data-scene") === state.scene),
      );
    });
    document.querySelectorAll("[data-layout]").forEach((btn) => {
      btn.setAttribute(
        "aria-pressed",
        String(btn.getAttribute("data-layout") === state.layout),
      );
    });
  }

  function setTheme(theme) {
    state.theme = theme;
    document.documentElement.dataset.theme = theme;
    const sel = document.getElementById("theme-select");
    if (sel) sel.value = theme;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderAll() {
    const signinView = document.getElementById("signin-view");
    const listView = document.getElementById("list-page-view");
    const detailView = document.getElementById("detail-page-view");
    const signoutBtn = document.getElementById("signout-btn");

    if (state.viewMode === "signin") {
      signinView.hidden = false;
      listView.hidden = true;
      detailView.hidden = true;
      signoutBtn.hidden = true;
      return;
    }

    signinView.hidden = true;
    signoutBtn.hidden = false;

    if (state.viewMode === "list") {
      listView.hidden = false;
      detailView.hidden = true;
      renderListPage();
    } else {
      listView.hidden = true;
      detailView.hidden = false;
      renderDetail();
    }
  }

  // 初始化全局事件绑定
  document.querySelectorAll("[data-scene]").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyScene(btn.getAttribute("data-scene"));
    });
  });

  document.querySelectorAll("[data-layout]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.layout = btn.getAttribute("data-layout");
      if (state.viewMode === "list") {
        state.viewMode = "detail";
        state.scene = "stopped";
      }
      syncSceneButtons();
      renderAll();
    });
  });

  document.getElementById("back-to-list-btn")?.addEventListener("click", () => {
    state.viewMode = "list";
    state.scene = "list";
    syncSceneButtons();
    renderAll();
  });

  document
    .getElementById("quick-instance-switcher")
    ?.addEventListener("change", (e) => {
      state.selectedId = e.target.value;
      state.loginActiveTarget = null;
      renderDetail();
    });

  document
    .getElementById("list-search-input")
    ?.addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      renderListPage();
    });

  document.getElementById("list-refresh-btn")?.addEventListener("click", () => {
    showToast("正在刷新全部实例状态与登录核验…", "pending");
    setTimeout(() => showToast("实例列表已更新", ""), 600);
  });

  document.getElementById("toggle-theme-btn")?.addEventListener("click", () => {
    setTheme(state.theme === "light" ? "dark" : "light");
  });

  document.getElementById("theme-select")?.addEventListener("change", (e) => {
    setTheme(e.target.value);
  });

  document.getElementById("signout-btn")?.addEventListener("click", () => {
    applyScene("signin");
    showToast("已退出管理员会话", "");
  });

  document.getElementById("signin-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    applyScene("list");
    showToast("欢迎回来，管理员登录成功", "");
  });

  // 打开与关闭弹窗
  document.querySelectorAll("[data-open-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-open-modal");
      if (target === "create") {
        document.getElementById("modal-create").hidden = false;
      } else if (target === "global-proxy") {
        document.getElementById("modal-global-proxy").hidden = false;
      }
    });
  });

  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("modal-create").hidden = true;
      document.getElementById("modal-global-proxy").hidden = true;
      document.getElementById("modal-instance-settings").hidden = true;
    });
  });

  // 创建实例弹窗里的引擎卡片与 Proxy 切换
  let createEngine = "codex";
  document.querySelectorAll("[data-engine-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      createEngine = btn.getAttribute("data-engine-choice");
      document.querySelectorAll("[data-engine-choice]").forEach((other) => {
        other.setAttribute(
          "aria-checked",
          String(other.getAttribute("data-engine-choice") === createEngine),
        );
      });
    });
  });

  document.getElementById("create-proxy-mode")?.addEventListener("change", (e) => {
    document.getElementById("create-custom-proxy-box").hidden =
      e.target.value !== "custom";
  });

  document
    .getElementById("instance-proxy-mode-input")
    ?.addEventListener("change", (e) => {
      document.getElementById("instance-custom-proxy-box").hidden =
        e.target.value !== "custom";
    });

  // 测试 Proxy 按钮模拟
  document.querySelectorAll("[data-test-proxy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.getAttribute("data-test-proxy");
      const targetId =
        kind === "create"
          ? "create-proxy-test-result"
          : kind === "global"
            ? "global-proxy-test-result"
            : "instance-proxy-test-result";
      const out = document.getElementById(targetId);
      if (!out) return;
      out.textContent = "正在查询 Proxy 出口 IP 和位置…";
      btn.disabled = true;
      setTimeout(() => {
        btn.disabled = false;
        out.innerHTML = `<strong style="color: var(--status-success);">✓ 连通正常</strong> · 出口 IP：203.0.113.7 · Japan / Tokyo`;
      }, 650);
    });
  });

  // 提交创建实例（创建后直接进入新实例详情页完成账号登录）
  document
    .getElementById("create-instance-form")
    ?.addEventListener("submit", (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const name = new FormData(form).get("name") || "New CLI";
      const mode = document.getElementById("create-proxy-mode").value;
      const newId = "inst-" + Date.now();
      state.instances.push({
        id: newId,
        name: String(name),
        engine: createEngine,
        state: "stopped",
        proxyMode: mode,
        proxyUrl: mode === "custom" ? "http://10.0.0.2:8080" : "",
        error: "",
        auth: { cindy: "missing", provider: "missing" },
        accounts: { cindy: null, provider: null },
        requests: [],
        members: [],
        usage: [],
      });
      document.getElementById("modal-create").hidden = true;
      form.reset();
      showToast(`已创建实例 "${name}"，请登录账号后启动`, "");
      enterInstanceDetail(newId);
    });

  // 提交全局 Proxy
  document
    .getElementById("global-proxy-form")
    ?.addEventListener("submit", (e) => {
      e.preventDefault();
      const val = document.getElementById("global-proxy-url-input").value.trim();
      state.defaultProxyUrl = val;
      document.getElementById("modal-global-proxy").hidden = true;
      showToast("默认 Proxy 设置已保存", "");
      renderAll();
    });

  document
    .getElementById("clear-global-proxy-btn")
    ?.addEventListener("click", () => {
      state.defaultProxyUrl = "";
      document.getElementById("global-proxy-url-input").value = "";
      document.getElementById("modal-global-proxy").hidden = true;
      showToast("已清除默认 Proxy", "");
      renderAll();
    });

  // 提交实例设置
  document
    .getElementById("instance-settings-form")
    ?.addEventListener("submit", (e) => {
      e.preventDefault();
      const inst = state.instances.find((i) => i.id === state.selectedId);
      if (inst) {
        inst.name = document.getElementById("instance-name-input").value.trim() || inst.name;
        if (inst.state !== "running") {
          inst.proxyMode = document.getElementById("instance-proxy-mode-input").value;
          inst.proxyUrl = document.getElementById("instance-proxy-url-input").value.trim();
        }
      }
      document.getElementById("modal-instance-settings").hidden = true;
      showToast("实例设置已保存", "");
      renderAll();
    });

  renderAll();
})();
