/**
 * 本页调试日志：
 * 1) Web Audio 发声：由 musicmol-piano.js 的 playNote 调用 logNoteOn
 * 2) 网络：包装 fetch，记录与本项目 API / 外向推送相关的请求与响应，便于与琴声对照排查
 */
(function () {
  const MAX = 500;
  const entries = [];
  let listEl;
  let hidden = false;
  const pageInstanceId = "tab-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  function getTabVisibility() {
    try {
      return document.visibilityState || (document.hidden ? "hidden" : "visible");
    } catch {
      return "unknown";
    }
  }

  function getFocusState() {
    try {
      return typeof document.hasFocus === "function" ? !!document.hasFocus() : null;
    } catch {
      return null;
    }
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function push(e) {
    const row = {
      t: nowIso(),
      page_instance_id: pageInstanceId,
      tab_visibility: getTabVisibility(),
      focus: getFocusState(),
      ...e,
    };
    entries.push(row);
    if (entries.length > MAX) entries.shift();
    if (typeof console !== "undefined" && console.debug) {
      console.debug("[ActivityLog]", row);
    }
    render();
  }

  function render() {
    if (!listEl) return;
    const lines = entries.map((r) => JSON.stringify(r));
    listEl.textContent = lines.length
      ? lines.join("\n")
      : "（尚无记录：琴声、接口收发会写在这里。）\n（No entries yet.）";
  }

  function buildPanel() {
    if (document.getElementById("sound-activity-logger-wrap")) return;
    const wrap = document.createElement("div");
    wrap.id = "sound-activity-logger-wrap";
    wrap.className = "sound-activity-logger-wrap";
    wrap.setAttribute("aria-label", "Sound and API log");
    const head = document.createElement("div");
    head.className = "sound-activity-logger-head";
    const title = document.createElement("span");
    title.className = "sound-activity-logger-title";
    title.textContent = "声音与接口 / Sound+API";
    const bar = document.createElement("div");
    bar.className = "sound-activity-logger-bar";
    const bHide = document.createElement("button");
    bHide.type = "button";
    bHide.className = "sound-activity-logger-btn";
    bHide.textContent = "收起";
    bHide.title = "Collapse";
    bHide.addEventListener("click", () => {
      hidden = !hidden;
      wrap.classList.toggle("sound-activity-logger-wrap--collapsed", hidden);
      bHide.textContent = hidden ? "展开" : "收起";
    });
    const bClear = document.createElement("button");
    bClear.type = "button";
    bClear.className = "sound-activity-logger-btn";
    bClear.textContent = "清除";
    bClear.addEventListener("click", () => {
      entries.length = 0;
      render();
    });
    const bJson = document.createElement("button");
    bJson.type = "button";
    bJson.className = "sound-activity-logger-btn";
    bJson.textContent = "导出";
    bJson.addEventListener("click", () => {
      const text = entries.map((r) => JSON.stringify(r)).join("\n");
      const blob = new Blob([text], { type: "application/x-ndjson;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "activity-log-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jsonl";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    bar.appendChild(bClear);
    bar.appendChild(bJson);
    bar.appendChild(bHide);
    head.appendChild(title);
    head.appendChild(bar);
    listEl = document.createElement("pre");
    listEl.className = "sound-activity-logger-list";
    wrap.appendChild(head);
    wrap.appendChild(listEl);
    document.body.appendChild(wrap);
    render();
  }

  function onReady() {
    buildPanel();
  }

  if (document.body) onReady();
  else document.addEventListener("DOMContentLoaded", onReady, { once: true });

  // 记录页面状态变化，帮助排查“我在别的 tab 但声音在响”
  document.addEventListener("visibilitychange", () => {
    push({ kind: "page_state", state: "visibilitychange", value: getTabVisibility() });
  });
  window.addEventListener("focus", () => {
    push({ kind: "page_state", state: "focus", value: true });
  });
  window.addEventListener("blur", () => {
    push({ kind: "page_state", state: "blur", value: false });
  });

  // ---------- fetch 包装：只记录“本项目相关”接口 ----------

  function resolveUrlString(input) {
    try {
      if (typeof input === "string") {
        if (/^https?:/i.test(input)) return input;
        return new URL(input, location.href).href;
      }
      if (input && typeof input === "object" && typeof input.url === "string") {
        return new URL(input.url, location.href).href;
      }
    } catch {
      return String(input);
    }
    return String(input);
  }

  function shouldLogUrl(href) {
    try {
      const u = new URL(href);
      const p = u.pathname || "";
      if (p.indexOf("/api/") >= 0) return true;
      if (p.indexOf("/__push/") >= 0) return true;
      if (p.indexOf("glass_session") >= 0) return true;
    } catch {
      return false;
    }
    return false;
  }

  function summarizeRequestBody(init) {
    if (!init || init.body == null) return undefined;
    const b = init.body;
    if (typeof b === "string") {
      return { type: "text", len: b.length, preview: b.length > 400 ? b.slice(0, 400) + "…" : b };
    }
    if (typeof URLSearchParams !== "undefined" && b instanceof URLSearchParams) {
      const s = b.toString();
      return { type: "urlencoded", len: s.length, preview: s.length > 400 ? s.slice(0, 400) + "…" : s };
    }
    if (typeof FormData !== "undefined" && b instanceof FormData) {
      const keys = [];
      try {
        b.forEach((_v, k) => {
          if (keys.length < 32 && keys.indexOf(k) < 0) keys.push(k);
        });
      } catch {
        /* ignore */
      }
      return { type: "formdata", field_names: keys };
    }
    if (typeof Blob !== "undefined" && b instanceof Blob) {
      return { type: "blob", size: b.size, content_type: b.type || null };
    }
    return { type: typeof b };
  }

  function getMethod(input, init) {
    if (init && init.method) return String(init.method).toUpperCase();
    if (input && typeof input === "object" && input.method) return String(input.method).toUpperCase();
    return "GET";
  }

  if (!window.__activityLogFetchPatched) {
    window.__activityLogFetchPatched = true;
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const href = resolveUrlString(input);
      const logIt = shouldLogUrl(href);
      const t0 = typeof performance !== "undefined" ? performance.now() : 0;
      if (logIt) {
        const req = {
          kind: "api_request",
          direction: "send",
          method: getMethod(input, init),
          url: href,
        };
        const sm = summarizeRequestBody(init);
        if (sm) req.body = sm;
        push(req);
      }
      return origFetch(input, init)
        .then((response) => {
          if (!logIt) return response;
          const ms = t0 && typeof performance !== "undefined" ? Math.round(performance.now() - t0) : undefined;
          const ct = response.headers.get("content-type") || "";
          if (ct.indexOf("application/json") >= 0) {
            return response
              .clone()
              .text()
              .then((text) => {
                let preview = text;
                if (preview.length > 500) preview = preview.slice(0, 500) + "…";
                push({
                  kind: "api_response",
                  direction: "recv",
                  url: response.url || href,
                  status: response.status,
                  ok: response.ok,
                  ms,
                  content_type: ct,
                  body_preview: preview,
                });
                return response;
              })
              .catch(() => {
                push({
                  kind: "api_response",
                  direction: "recv",
                  url: response.url || href,
                  status: response.status,
                  ok: response.ok,
                  ms,
                  content_type: ct,
                  body_preview: "[read error]",
                });
                return response;
              });
          }
          push({
            kind: "api_response",
            direction: "recv",
            url: response.url || href,
            status: response.status,
            ok: response.ok,
            ms,
            content_type: ct || null,
            body_note: "non-json",
          });
          return response;
        })
        .catch((err) => {
          if (logIt) {
            push({
              kind: "api_error",
              direction: "error",
              url: href,
              err: (err && err.message) || String(err),
            });
          }
          return Promise.reject(err);
        });
    };
  }

  window.SoundActivityLogger = {
    logNoteOn(midi, velocity, meta) {
      const source = meta && meta.source != null ? String(meta.source) : "unknown";
      const extra = meta && typeof meta === "object" && meta.extra != null ? meta.extra : undefined;
      push({ kind: "note_on", source, midi: Number(midi), v: Number(velocity), extra });
    },
    log(eventName, data) {
      push({ kind: "event", name: String(eventName), ...(data && typeof data === "object" ? data : { value: data }) });
    },
    getEntries() {
      return entries.slice();
    },
    clear() {
      entries.length = 0;
      render();
    },
    getPageContext() {
      return {
        page_instance_id: pageInstanceId,
        tab_visibility: getTabVisibility(),
        focus: getFocusState(),
      };
    },
  };

  // 启动时写一条上下文，便于标记该日志属于哪个页面实例
  push({ kind: "page_state", state: "boot", value: "logger_ready" });
})();
