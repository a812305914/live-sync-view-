/**
 * Audience view: 仅轮询 GET /api/state；用 stateVersion 跳过无变化时的重渲染；
 * 用响应中的 nextItem 做下一页图片预加载（不拉全量 items）。
 * 多场景：不读取 scene 列表；服务端保证 item / nextItem 均来自当前 scene 的 items，切换由控制端 POST /api/scene 驱动。
 * stateVersion 在切换条目、切换场景或发布时递增，用于跳过无变化的轮询帧。
 * 模块：离线（navigator.onLine）与连续请求失败时的提示条。
 */

(function () {
  var POLL_MS = 2000;
  /** 连续失败次数达到此值后显示「失联」类提示（避免单次抖动） */
  var FAIL_THRESHOLD = 2;

  var preloadedImages = new Map();

  var lastStateVersion = null;

  var bannerEl = document.getElementById("view-connection-banner");
  var consecutiveFailures = 0;

  var panels = {
    blank: document.getElementById("panel-blank"),
    notice: document.getElementById("panel-notice"),
    text: document.getElementById("panel-text"),
    image: document.getElementById("panel-image"),
  };

  var els = {
    noticeText: document.getElementById("notice-text"),
    textTitle: document.getElementById("text-title"),
    textBody: document.getElementById("text-body"),
    viewImage: document.getElementById("view-image"),
    imageFallback: document.getElementById("image-fallback"),
  };

  /** 根据浏览器联网状态与轮询结果更新顶部提示条 */
  function updateConnectionBanner() {
    if (!bannerEl) {
      return;
    }
    bannerEl.classList.remove("view-connection-banner--warn", "view-connection-banner--ok");
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      bannerEl.textContent = "离线：无法获取最新画面，请检查网络。";
      bannerEl.classList.remove("is-hidden");
      bannerEl.classList.add("view-connection-banner--warn");
      return;
    }
    if (consecutiveFailures >= FAIL_THRESHOLD) {
      bannerEl.textContent = "无法连接服务器，正在重试…（将保留上一屏内容）";
      bannerEl.classList.remove("is-hidden");
      bannerEl.classList.add("view-connection-banner--warn");
      return;
    }
    bannerEl.classList.add("is-hidden");
    bannerEl.textContent = "";
  }

  if (typeof window !== "undefined") {
    window.addEventListener("online", function () {
      consecutiveFailures = 0;
      updateConnectionBanner();
      fetchState();
    });
    window.addEventListener("offline", function () {
      updateConnectionBanner();
    });
  }

  function showPanel(type) {
    Object.keys(panels).forEach(function (key) {
      panels[key].classList.toggle("is-hidden", key !== type);
    });
  }

  function getImageSrc(item) {
    if (!item || item.type !== "image") {
      return "";
    }
    if (item.src != null && String(item.src).trim()) {
      return String(item.src).trim();
    }
    if (item.image != null && String(item.image).trim()) {
      return String(item.image).trim();
    }
    return "";
  }

  function isImagePreloaded(src) {
    var e = preloadedImages.get(src);
    return !!(e && e.status === "loaded");
  }

  function preloadImage(src) {
    if (!src || !String(src).trim()) {
      return Promise.resolve();
    }
    src = String(src).trim();

    var prev = preloadedImages.get(src);
    if (prev && prev.status === "loaded") {
      return Promise.resolve();
    }
    if (prev && prev.status === "loading" && prev.promise) {
      return prev.promise;
    }
    if (prev && prev.status === "error") {
      return Promise.resolve();
    }

    var img = new Image();
    var promise = new Promise(function (resolve, reject) {
      img.onload = function () {
        preloadedImages.set(src, { status: "loaded" });
        resolve();
      };
      img.onerror = function () {
        preloadedImages.set(src, { status: "error" });
        reject(new Error("preload failed"));
      };
      img.src = src;
    });

    preloadedImages.set(src, { status: "loading", promise: promise });
    promise.catch(function () {
      /* 由调用方决定是否忽略 */
    });
    return promise;
  }

  function preloadFromNextItem(nextItem) {
    try {
      if (!nextItem || nextItem.type !== "image") {
        return;
      }
      var src = getImageSrc(nextItem);
      if (!src) {
        return;
      }
      preloadImage(src).catch(function () {});
    } catch (e) {
      /* 静默 */
    }
  }

  function render(item) {
    var t = item.type || "blank";
    if (t === "blank") {
      showPanel("blank");
      return;
    }
    if (t === "notice") {
      showPanel("notice");
      els.noticeText.textContent = item.body || item.text || "";
      return;
    }
    if (t === "text") {
      showPanel("text");
      var title = item.title || "";
      els.textTitle.textContent = title;
      els.textTitle.style.display = title ? "block" : "none";
      els.textBody.textContent = item.body || "";
      return;
    }
    if (t === "image") {
      showPanel("image");
      var src = getImageSrc(item);
      els.imageFallback.classList.add("is-hidden");
      els.viewImage.classList.remove("is-hidden");

      els.viewImage.onload = function () {
        els.imageFallback.classList.add("is-hidden");
        els.viewImage.classList.remove("is-hidden");
      };
      els.viewImage.onerror = function () {
        els.viewImage.classList.add("is-hidden");
        els.imageFallback.classList.remove("is-hidden");
      };

      if (src) {
        els.viewImage.alt = item.label || "内容图片";
        if (isImagePreloaded(src)) {
          els.imageFallback.classList.add("is-hidden");
        }
        els.viewImage.src = src;
      } else {
        els.viewImage.removeAttribute("src");
        els.viewImage.classList.add("is-hidden");
        els.imageFallback.classList.remove("is-hidden");
      }
      return;
    }
    showPanel("blank");
  }

  function applyStatePayload(stateData) {
    if (!stateData) {
      return;
    }
    var ver =
      typeof stateData.stateVersion === "number" ? stateData.stateVersion : null;
    if (ver !== null && lastStateVersion !== null && ver === lastStateVersion) {
      return;
    }
    lastStateVersion = ver;

    if (stateData.item) {
      render(stateData.item);
    }
    preloadFromNextItem(stateData.nextItem != null ? stateData.nextItem : null);
  }

  function fetchState() {
    fetch("/api/state")
      .then(function (r) {
        if (!r.ok) {
          throw new Error("HTTP " + r.status);
        }
        return r.json();
      })
      .then(function (data) {
        consecutiveFailures = 0;
        updateConnectionBanner();
        applyStatePayload(data);
      })
      .catch(function () {
        consecutiveFailures += 1;
        updateConnectionBanner();
      });
  }

  updateConnectionBanner();
  fetchState();
  setInterval(fetchState, POLL_MS);
})();
