/**
 * Control panel: 已发布目录列表、切换激活项、预览。
 * 多场景：顶部下拉框切换当前 scene（POST /api/scene）后刷新当前场景的 items；会众端仅随 GET /api/state 同步，无需改 view。
 * 访问保护由服务端 /login + Cookie 完成；API 401 时跳转登录页。
 * 放映：全屏层与会众端相近布局；点击画面 POST 下一项；Esc 或退出全屏时关闭放映层。
 */

(function () {
  var items = [];
  var activeId = null;
  var listEl = document.getElementById("item-list");
  var previewEl = document.getElementById("preview");
  var btnBlank = document.getElementById("btn-blank");
  var btnPrev = document.getElementById("btn-prev");
  var btnNext = document.getElementById("btn-next");
  var searchInput = document.getElementById("admin-search");
  var filterTypeEl = document.getElementById("admin-filter-type");
  var filterHintEl = document.getElementById("admin-filter-hint");
  var sceneSelectEl = document.getElementById("admin-scene-select");

  var btnShare = document.getElementById("btn-share");
  var shareModal = document.getElementById("admin-share-modal");
  var shareBackdrop = document.getElementById("admin-share-backdrop");
  var shareHint = document.getElementById("admin-share-hint");
  var shareQrWrap = document.getElementById("admin-share-qr-wrap");
  var shareQrcodeImg = document.getElementById("admin-share-qrcode");
  var shareUrlText = document.getElementById("admin-share-url-text");
  var btnShareCopy = document.getElementById("admin-share-copy");
  var btnShareClose = document.getElementById("admin-share-close");

  var adminSlideshow = document.getElementById("admin-slideshow");
  var btnSlideshow = document.getElementById("btn-slideshow");
  /** 放映层打开时为 true（含请求全屏失败但仍显示浮层的情况） */
  var slideshowOpen = false;

  var ssPanels = {
    blank: document.getElementById("admin-ss-panel-blank"),
    notice: document.getElementById("admin-ss-panel-notice"),
    text: document.getElementById("admin-ss-panel-text"),
    image: document.getElementById("admin-ss-panel-image"),
  };

  var ssEls = {
    noticeText: document.getElementById("admin-ss-notice-text"),
    textTitle: document.getElementById("admin-ss-text-title"),
    textBody: document.getElementById("admin-ss-text-body"),
    viewImage: document.getElementById("admin-ss-view-image"),
    imageFallback: document.getElementById("admin-ss-image-fallback"),
  };

  /** 当前分享链接（供复制） */
  var shareUrlCurrent = "";

  function apiFetch(url, options) {
    var o = options || {};
    o.credentials = "same-origin";
    return fetch(url, o);
  }

  function redirectLogin() {
    window.location.href =
      "/login?" +
      new URLSearchParams({ next: "/admin", role: "admin" }).toString();
  }

  function populateSceneSelect(scenes, currentSceneId) {
    if (!sceneSelectEl) {
      return;
    }
    sceneSelectEl.innerHTML = "";
    (scenes || []).forEach(function (sc) {
      var opt = document.createElement("option");
      opt.value = sc.id;
      opt.textContent = (sc.name || sc.id) + " · " + sc.id;
      sceneSelectEl.appendChild(opt);
    });
    if (currentSceneId) {
      sceneSelectEl.value = currentSceneId;
    }
  }

  /** 模块：根据关键词与类型从全量 items 得到列表子集（仅用于展示） */
  function getFilteredItems() {
    var q = (searchInput && searchInput.value ? searchInput.value : "").trim().toLowerCase();
    var t = filterTypeEl ? filterTypeEl.value : "all";
    return items.filter(function (item) {
      if (!item) {
        return false;
      }
      if (t !== "all" && (item.type || "") !== t) {
        return false;
      }
      if (!q) {
        return true;
      }
      var id = String(item.id || "").toLowerCase();
      var label = String(item.label || "").toLowerCase();
      var ty = String(item.type || "").toLowerCase();
      return id.indexOf(q) >= 0 || label.indexOf(q) >= 0 || ty.indexOf(q) >= 0;
    });
  }

  function updateFilterHint() {
    if (!filterHintEl) {
      return;
    }
    var total = items.length;
    var shown = getFilteredItems().length;
    if (total === shown) {
      filterHintEl.textContent = "共 " + total + " 项";
    } else {
      filterHintEl.textContent = "显示 " + shown + " / " + total + " 项（筛选中）";
    }
  }

  function escapeHtml(s) {
    var div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  function getItemIndex(id) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return i;
    }
    return -1;
  }

  function isSlideshowFullscreen() {
    if (!adminSlideshow) {
      return false;
    }
    return (
      document.fullscreenElement === adminSlideshow ||
      document.webkitFullscreenElement === adminSlideshow
    );
  }

  function showSsPanel(type) {
    Object.keys(ssPanels).forEach(function (key) {
      var el = ssPanels[key];
      if (el) {
        el.classList.toggle("is-hidden", key !== type);
      }
    });
  }

  function getSsImageSrc(item) {
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

  function renderSlideshow(item) {
    if (!slideshowOpen || !ssPanels.blank) {
      return;
    }
    var t = item && item.type ? item.type : "blank";
    if (t === "blank" || !item) {
      showSsPanel("blank");
      return;
    }
    if (t === "notice") {
      showSsPanel("notice");
      if (ssEls.noticeText) {
        ssEls.noticeText.textContent = item.body || item.text || "";
      }
      return;
    }
    if (t === "text") {
      showSsPanel("text");
      var title = item.title || "";
      if (ssEls.textTitle) {
        ssEls.textTitle.textContent = title;
        ssEls.textTitle.style.display = title ? "block" : "none";
      }
      if (ssEls.textBody) {
        ssEls.textBody.textContent = item.body || "";
      }
      return;
    }
    if (t === "image") {
      showSsPanel("image");
      var src = getSsImageSrc(item);
      if (ssEls.imageFallback) {
        ssEls.imageFallback.classList.add("is-hidden");
      }
      if (ssEls.viewImage) {
        ssEls.viewImage.classList.remove("is-hidden");
        ssEls.viewImage.onload = function () {
          if (ssEls.imageFallback) {
            ssEls.imageFallback.classList.add("is-hidden");
          }
          ssEls.viewImage.classList.remove("is-hidden");
        };
        ssEls.viewImage.onerror = function () {
          ssEls.viewImage.classList.add("is-hidden");
          if (ssEls.imageFallback) {
            ssEls.imageFallback.classList.remove("is-hidden");
          }
        };
        if (src) {
          ssEls.viewImage.alt = item.label || "内容图片";
          ssEls.viewImage.src = src;
        } else {
          ssEls.viewImage.removeAttribute("src");
          ssEls.viewImage.classList.add("is-hidden");
          if (ssEls.imageFallback) {
            ssEls.imageFallback.classList.remove("is-hidden");
          }
        }
      }
      return;
    }
    showSsPanel("blank");
  }

  function renderSlideshowIfOpen(item) {
    if (slideshowOpen) {
      renderSlideshow(item);
    }
  }

  function requestSlideshowFullscreen() {
    if (!adminSlideshow) {
      return;
    }
    var p = null;
    if (adminSlideshow.requestFullscreen) {
      p = adminSlideshow.requestFullscreen();
    } else if (adminSlideshow.webkitRequestFullscreen) {
      try {
        adminSlideshow.webkitRequestFullscreen();
      } catch (e) {
        /* 忽略 */
      }
    }
    if (p && typeof p.then === "function") {
      p.catch(function () {
        /* 非安全上下文等情况下全屏失败，仍可使用浮层放映 */
      });
    }
  }

  function exitSlideshow() {
    slideshowOpen = false;
    function hideLayer() {
      if (adminSlideshow) {
        adminSlideshow.classList.add("is-hidden");
        adminSlideshow.setAttribute("aria-hidden", "true");
      }
    }
    if (isSlideshowFullscreen()) {
      var chain = null;
      if (document.exitFullscreen) {
        chain = document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        try {
          document.webkitExitFullscreen();
        } catch (e2) {
          /* 忽略 */
        }
      }
      if (chain && typeof chain.then === "function") {
        chain.then(hideLayer).catch(hideLayer);
      } else {
        hideLayer();
      }
    } else {
      hideLayer();
    }
  }

  function enterSlideshow() {
    if (!adminSlideshow) {
      return;
    }
    if (!items.length) {
      alert("当前场景无条目，无法放映。");
      return;
    }
    slideshowOpen = true;
    adminSlideshow.classList.remove("is-hidden");
    adminSlideshow.setAttribute("aria-hidden", "false");
    apiFetch("/api/state")
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        activeId = data.activeId;
        highlightList();
        renderPreview(data.item);
        renderSlideshow(data.item);
      })
      .catch(function () {
        renderSlideshow(null);
      });
    requestSlideshowFullscreen();
  }

  function onSlideshowFullscreenChange() {
    if (!adminSlideshow) {
      return;
    }
    var fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs === adminSlideshow) {
      return;
    }
    if (!slideshowOpen) {
      return;
    }
    if (!adminSlideshow.classList.contains("is-hidden")) {
      slideshowOpen = false;
      adminSlideshow.classList.add("is-hidden");
      adminSlideshow.setAttribute("aria-hidden", "true");
    }
  }

  function renderPreview(item) {
    if (!item) {
      previewEl.innerHTML = "<p class=\"preview-empty\">（无）</p>";
      return;
    }
    var t = item.type || "";
    var html = "<div class=\"preview-inner\">";
    html += "<p class=\"preview-meta\"><strong>类型</strong> " + escapeHtml(t) + "</p>";
    if (item.label) {
      html += "<p class=\"preview-meta\"><strong>标签</strong> " + escapeHtml(String(item.label)) + "</p>";
    }
    if (t === "notice") {
      html += "<p class=\"preview-notice\">" + escapeHtml(String(item.body || item.text || "")) + "</p>";
    } else if (t === "text") {
      if (item.title) {
        html += "<p class=\"preview-text-title\">" + escapeHtml(String(item.title)) + "</p>";
      }
      html += "<p class=\"preview-text-body\">" + escapeHtml(String(item.body || "")) + "</p>";
    } else if (t === "image") {
      var src = item.src || item.image || "";
      html += "<p class=\"preview-meta\"><strong>图片</strong> " + escapeHtml(src || "（未设置）") + "</p>";
      if (src) {
        html += "<div class=\"preview-img-box\"><img src=\"" + escapeHtml(src) + "\" alt=\"\" class=\"preview-img\" /></div>";
      }
    } else if (t === "blank") {
      html += "<p class=\"preview-muted\">会众端显示「请稍候」</p>";
    }
    html += "</div>";
    previewEl.innerHTML = html;
  }

  function highlightList() {
    var nodes = listEl.querySelectorAll("[data-id]");
    nodes.forEach(function (node) {
      node.classList.toggle("is-active", node.getAttribute("data-id") === activeId);
    });
  }

  function renderList() {
    listEl.innerHTML = "";
    var filtered = getFilteredItems();
    filtered.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "admin-list-item";
      li.setAttribute("data-id", item.id);
      var label = item.label || item.id;
      li.textContent = label + " · " + (item.type || "");
      li.addEventListener("click", function () {
        setState(item.id);
      });
      listEl.appendChild(li);
    });
    highlightList();
    updateFilterHint();
  }

  function setState(id) {
    apiFetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ id: id }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || r.status); });
        return r.json();
      })
      .then(function (data) {
        activeId = data.activeId;
        highlightList();
        renderPreview(data.item);
        renderSlideshowIfOpen(data.item);
      })
      .catch(function (err) {
        alert(err.message || "设置失败");
      });
  }

  function refreshState() {
    apiFetch("/api/state")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        activeId = data.activeId;
        if (sceneSelectEl && data.sceneId) {
          sceneSelectEl.value = data.sceneId;
        }
        highlightList();
        renderPreview(data.item);
        renderSlideshowIfOpen(data.item);
      })
      .catch(function () {});
  }

  function loadItems() {
    Promise.all([apiFetch("/api/scenes"), apiFetch("/api/items")])
      .then(function (responses) {
        var rs = responses[0];
        var ri = responses[1];
        if (rs.status === 401 || ri.status === 401) {
          redirectLogin();
          throw new Error("需要登录");
        }
        if (!rs.ok) {
          throw new Error("场景列表 HTTP " + rs.status);
        }
        if (!ri.ok) {
          throw new Error("条目列表 HTTP " + ri.status);
        }
        return Promise.all([rs.json(), ri.json()]);
      })
      .then(function (pair) {
        var scenesPayload = pair[0];
        var itemsPayload = pair[1];
        populateSceneSelect(scenesPayload.scenes || [], itemsPayload.sceneId);
        // 始终替换为新数组，避免保留上一场景的 items 引用
        items = [].concat(itemsPayload.items || []);
        renderList();
        refreshState();
      })
      .catch(function (e) {
        if (e && e.message === "需要登录") {
          return;
        }
        listEl.innerHTML = "<li class=\"admin-error\">无法加载列表</li>";
      });
  }

  function goPrev() {
    var idx = getItemIndex(activeId);
    if (idx <= 0) return;
    setState(items[idx - 1].id);
  }

  function goNext() {
    var idx = getItemIndex(activeId);
    if (idx < 0 || idx >= items.length - 1) return;
    setState(items[idx + 1].id);
  }

  function openShareModal() {
    if (!shareModal) {
      return;
    }
    shareModal.classList.remove("is-hidden");
    shareModal.setAttribute("aria-hidden", "false");
  }

  function closeShareModal() {
    if (!shareModal) {
      return;
    }
    shareModal.classList.add("is-hidden");
    shareModal.setAttribute("aria-hidden", "true");
    if (shareQrcodeImg) {
      shareQrcodeImg.removeAttribute("src");
    }
  }

  /** 获取 .env 中 PUBLIC_VIEW_URL 并展示二维码（服务端生成 PNG） */
  function openShare() {
    apiFetch("/api/share/view-url")
      .then(function (r) {
        if (r.status === 401) {
          redirectLogin();
          throw new Error("需要登录");
        }
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.configured || !data.url) {
          alert(
            "未配置分享地址。请在项目根目录 .env 中设置：\nPUBLIC_VIEW_URL=https://你的主机:端口/view\n然后重启服务。"
          );
          return;
        }
        shareUrlCurrent = data.url;
        if (shareHint) {
          shareHint.textContent =
            "请使用手机扫描下方二维码打开会众端页面（链接由服务器环境变量 PUBLIC_VIEW_URL 提供）。";
        }
        if (shareUrlText) {
          shareUrlText.textContent = data.url;
        }
        if (shareQrWrap) {
          shareQrWrap.classList.remove("is-hidden");
        }
        if (shareQrcodeImg) {
          shareQrcodeImg.onerror = function () {
            alert("二维码图片加载失败，请检查服务器是否已安装依赖并查看控制台。");
          };
          shareQrcodeImg.onload = function () {
            shareQrcodeImg.onerror = null;
          };
          shareQrcodeImg.src =
            "/api/share/qrcode.png?t=" + String(Date.now());
        }
        openShareModal();
      })
      .catch(function (e) {
        if (e && e.message === "需要登录") {
          return;
        }
        alert("获取分享配置失败");
      });
  }

  if (btnShare) {
    btnShare.addEventListener("click", openShare);
  }
  if (btnShareClose) {
    btnShareClose.addEventListener("click", closeShareModal);
  }
  if (shareBackdrop) {
    shareBackdrop.addEventListener("click", closeShareModal);
  }
  if (btnShareCopy) {
    btnShareCopy.addEventListener("click", function () {
      if (!shareUrlCurrent) {
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(shareUrlCurrent).then(
          function () {
            alert("已复制到剪贴板");
          },
          function () {
            prompt("请手动复制：", shareUrlCurrent);
          }
        );
      } else {
        prompt("请手动复制：", shareUrlCurrent);
      }
    });
  }

  btnBlank.addEventListener("click", function () {
    setState("blank");
  });

  if (btnSlideshow) {
    btnSlideshow.addEventListener("click", function () {
      enterSlideshow();
    });
  }

  if (adminSlideshow) {
    adminSlideshow.addEventListener("click", function (ev) {
      if (!slideshowOpen) {
        return;
      }
      ev.preventDefault();
      goNext();
    });
  }

  document.addEventListener("fullscreenchange", onSlideshowFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onSlideshowFullscreenChange);

  btnPrev.addEventListener("click", goPrev);
  btnNext.addEventListener("click", goNext);

  if (searchInput) {
    searchInput.addEventListener("input", function () {
      renderList();
    });
  }
  if (filterTypeEl) {
    filterTypeEl.addEventListener("change", function () {
      renderList();
    });
  }

  if (sceneSelectEl) {
    sceneSelectEl.addEventListener("change", function () {
      var sid = sceneSelectEl.value;
      apiFetch("/api/scene", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ sceneId: sid }),
      })
        .then(function (r) {
          if (r.status === 401) {
            redirectLogin();
            throw new Error("需要登录");
          }
          if (!r.ok) {
            return r.json().then(function (e) {
              throw new Error(e.error || r.status);
            });
          }
          return r.json();
        })
        .then(function () {
          loadItems();
        })
        .catch(function (err) {
          alert(err.message || "切换场景失败");
          refreshState();
        });
    });
  }

  function isFormFieldTarget(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  document.addEventListener("keydown", function (ev) {
    if (slideshowOpen && ev.key === "Escape") {
      ev.preventDefault();
      exitSlideshow();
      return;
    }
    if (isFormFieldTarget(ev.target) || ev.isComposing) {
      return;
    }
    var k = ev.key;
    if (k === "b" || k === "B") {
      ev.preventDefault();
      setState("blank");
      return;
    }
    if (k === "r" || k === "R") {
      ev.preventDefault();
      refreshState();
      return;
    }
    if (k === "ArrowLeft" || k === "ArrowUp") {
      ev.preventDefault();
      goPrev();
      return;
    }
    if (k === "ArrowRight" || k === "ArrowDown") {
      ev.preventDefault();
      goNext();
      return;
    }
  });

  loadItems();
})();
