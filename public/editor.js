/**
 * 结构化编辑器：默认读写 data/items.draft.json（多场景 { scenes: [...] }）。
 * - 保存：PUT /api/items（写入编辑文件，不覆盖正式 items.json）
 * - 发布：POST /api/items/publish（整份 scenes 校验后覆盖 items.json → 更新 itemsRevision/stateVersion）
 * - 加载：GET /api/items/draft
 * - 左侧切换场景：先把当前 items 写回对应 scene，再加载另一场景的 items。
 * - PDF：「导入 PDF（拆页）」在浏览器内用 pdf.js 逐页渲染为 PNG，经 POST /api/editor/upload-media 上传后，在当前选中项下方插入多条 image。
 * - 一键清空：确认后清空当前场景 items，仅保留一条 blank（须先保存或发布才会写入文件）。
 */

(function () {
  var ALLOWED_TYPES = ["blank", "notice", "text", "image"];

  var publishedRevision = null;
  var draftMatchesPublished = false;
  var localDirty = false;

  var scenes = [];
  var currentSceneId = "";

  /** 当前场景 items 与选中下标 */
  var items = [];
  var selectedIndex = -1;
  var jsonAdvancedOpen = false;
  var jsonAdvancedDirty = false;

  function apiFetch(url, options) {
    var o = options || {};
    o.credentials = "same-origin";
    return fetch(url, o);
  }

  var btnPdfImport = document.getElementById("btn-pdf-import");
  var fPdfImport = document.getElementById("f-pdf-import");
  var pdfImportStatus = document.getElementById("pdf-import-status");
  /** 单次导入 PDF 最多页数（避免浏览器/服务器压力过大） */
  var MAX_PDF_PAGES = 200;

  function setImageUploadStatus(msg) {
    if (imageUploadStatus) {
      imageUploadStatus.textContent = msg || "";
    }
  }

  function uploadImageFile(file) {
    if (!file || !fSrc) {
      return;
    }
    setImageUploadStatus("上传中…");
    if (fImageFile) {
      fImageFile.disabled = true;
    }
    var fd = new FormData();
    fd.append("file", file);
    apiFetch("/api/editor/upload-media", { method: "POST", body: fd })
      .then(function (r) {
        if (r.status === 401) {
          window.location.href =
            "/login?" +
            new URLSearchParams({ next: "/editor", role: "editor" }).toString();
          throw new Error("需要登录");
        }
        return r.json().then(function (body) {
          if (!r.ok) {
            throw new Error(body.error || r.statusText);
          }
          return body;
        });
      })
      .then(function (data) {
        fSrc.value = data.url || "";
        syncFormToState();
        renderList();
        updateLivePreview();
        touchDraft();
        setImageUploadStatus("已上传");
        setStatus("已上传图片：" + (data.url || ""), false);
        if (fImageFile) {
          fImageFile.value = "";
        }
      })
      .catch(function (e) {
        if (e && e.message === "需要登录") {
          return;
        }
        setImageUploadStatus("");
        setStatus("上传失败: " + (e.message || String(e)), true);
      })
      .finally(function () {
        if (fImageFile) {
          fImageFile.disabled = false;
        }
      });
  }

  function setPdfImportStatus(msg) {
    if (pdfImportStatus) {
      pdfImportStatus.textContent = msg || "";
    }
  }

  function waitForPdfJs(timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 15000);
    return new Promise(function (resolve, reject) {
      function tick() {
        if (window.__PDFJS) {
          resolve(window.__PDFJS);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("PDF 组件加载超时，请刷新页面后重试"));
          return;
        }
        setTimeout(tick, 30);
      }
      tick();
    });
  }

  function canvasToPngBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) {
          reject(new Error("无法将页面导出为 PNG"));
          return;
        }
        resolve(blob);
      }, "image/png");
    });
  }

  function uploadImageBlob(blob, filename) {
    var fd = new FormData();
    fd.append("file", blob, filename || "page.png");
    return apiFetch("/api/editor/upload-media", { method: "POST", body: fd }).then(function (r) {
      if (r.status === 401) {
        window.location.href =
          "/login?" +
          new URLSearchParams({ next: "/editor", role: "editor" }).toString();
        throw new Error("需要登录");
      }
      return r.json().then(function (body) {
        if (!r.ok) {
          throw new Error(body.error || r.statusText);
        }
        return body;
      });
    });
  }

  function renderPdfPageToBlob(pdf, pageNum, maxCssPixels) {
    maxCssPixels = maxCssPixels || 2200;
    return pdf.getPage(pageNum).then(function (page) {
      var base = page.getViewport({ scale: 1 });
      var scale = Math.min(2, maxCssPixels / Math.max(base.width, 1));
      var viewport = page.getViewport({ scale: scale });
      var canvas = document.createElement("canvas");
      var ctx = canvas.getContext("2d", { alpha: false });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      var renderTask = page.render({ canvasContext: ctx, viewport: viewport });
      return renderTask.promise.then(function () {
        return canvasToPngBlob(canvas);
      });
    });
  }

  function processPdfPagesToUrls(pdf, numPages, baseLabel) {
    var urls = [];
    function step(p) {
      if (p > numPages) {
        return Promise.resolve(urls);
      }
      setPdfImportStatus("处理第 " + p + " / " + numPages + " 页…");
      return renderPdfPageToBlob(pdf, p)
        .then(function (blob) {
          return uploadImageBlob(blob, baseLabel + "-p" + p + ".png");
        })
        .then(function (data) {
          var u = (data && data.url) || "";
          if (!u) {
            throw new Error("上传未返回 URL");
          }
          urls.push(u);
          return step(p + 1);
        });
    }
    return step(1);
  }

  function importPdfAsImageItems(file) {
    if (!file) {
      return;
    }
    var lower = (file.name || "").toLowerCase();
    var okType = file.type === "application/pdf" || lower.endsWith(".pdf");
    if (!okType) {
      setStatus("请选择 PDF 文件（.pdf）。", true);
      return;
    }
    syncFormToState();
    var baseLabel = (file.name || "PDF").replace(/\.[^.]+$/, "") || "PDF";
    setPdfImportStatus("准备中…");
    if (btnPdfImport) {
      btnPdfImport.disabled = true;
    }
    waitForPdfJs(20000)
      .then(function (pdfjsLib) {
        return file.arrayBuffer().then(function (buf) {
          var task = pdfjsLib.getDocument({ data: new Uint8Array(buf) });
          return task.promise;
        });
      })
      .then(function (pdf) {
        var n = pdf.numPages;
        if (!n || n < 1) {
          throw new Error("PDF 无有效页");
        }
        if (n > MAX_PDF_PAGES) {
          throw new Error("页数超过上限（最多 " + MAX_PDF_PAGES + " 页）");
        }
        return processPdfPagesToUrls(pdf, n, baseLabel).finally(function () {
          if (pdf && typeof pdf.destroy === "function") {
            return pdf.destroy().catch(function () {});
          }
        });
      })
      .then(function (finalUrls) {
        var insertAt = selectedIndex >= 0 ? selectedIndex + 1 : items.length;
        var firstIdx = insertAt;
        for (var i = 0; i < finalUrls.length; i++) {
          var id = uniqueIdForType("image", -1);
          items.splice(insertAt + i, 0, {
            id: id,
            type: "image",
            label: baseLabel + " 第 " + (i + 1) + " 页",
            src: finalUrls[i],
          });
        }
        selectedIndex = firstIdx;
        renderList();
        renderForm();
        updateLivePreview();
        touchDraft();
        setPdfImportStatus("");
        setStatus("已从 PDF 插入 " + finalUrls.length + " 条图片项。", false);
      })
      .catch(function (e) {
        if (e && e.message === "需要登录") {
          setPdfImportStatus("");
          return;
        }
        setPdfImportStatus("");
        setStatus("PDF 导入失败: " + (e.message || String(e)), true);
      })
      .finally(function () {
        if (btnPdfImport) {
          btnPdfImport.disabled = false;
        }
        if (fPdfImport) {
          fPdfImport.value = "";
        }
      });
  }

  var sceneItemWarningEl = document.getElementById("scene-item-warning");

  var viewStructured = document.getElementById("view-structured");
  var viewJson = document.getElementById("view-json");
  var statusEl = document.getElementById("editor-status");
  var itemListEl = document.getElementById("item-list");
  var formEmpty = document.getElementById("form-empty");
  var formWrap = document.getElementById("form-wrap");
  var form = document.getElementById("item-form");

  var itemFilterSearch = document.getElementById("item-filter-search");
  var itemFilterType = document.getElementById("item-filter-type");

  var ctxSceneName = document.getElementById("ctx-scene-name");
  var ctxItemTitle = document.getElementById("ctx-item-title");
  var ctxItemType = document.getElementById("ctx-item-type");
  var ctxItemIndex = document.getElementById("ctx-item-index");

  var btnPrevItem = document.getElementById("btn-prev-item");
  var btnNextItem = document.getElementById("btn-next-item");

  var fId = document.getElementById("f-id");
  var fType = document.getElementById("f-type");
  var fLabel = document.getElementById("f-label");
  var fieldNotice = document.getElementById("field-notice");
  var fieldText = document.getElementById("field-text");
  var fieldImage = document.getElementById("field-image");
  var fBodyNotice = document.getElementById("f-body-notice");
  var fTitle = document.getElementById("f-title");
  var fBodyText = document.getElementById("f-body-text");
  var fSrc = document.getElementById("f-src");
  var fImageFile = document.getElementById("f-image-file");
  var imageUploadStatus = document.getElementById("image-upload-status");

  var livePreviewBlank = document.getElementById("live-preview-blank");
  var livePreviewNotice = document.getElementById("live-preview-notice");
  var livePreviewText = document.getElementById("live-preview-text");
  var livePreviewImage = document.getElementById("live-preview-image");
  var liveNoticeText = document.getElementById("live-notice-text");
  var liveTextTitle = document.getElementById("live-text-title");
  var liveTextBody = document.getElementById("live-text-body");
  var liveImageImg = document.getElementById("live-image-img");
  var liveImageFallback = document.getElementById("live-image-fallback");

  var jsonReadonly = document.getElementById("json-readonly");
  var jsonAdvancedTa = document.getElementById("json-advanced-ta");
  var jsonAdvancedWarn = document.getElementById("json-advanced-warn");
  var jsonAdvancedActions = document.getElementById("json-advanced-actions");

  var editorAddWrap = document.getElementById("editor-add-wrap");
  var btnAddMenu = document.getElementById("btn-add-menu");
  var addTypeMenu = document.getElementById("add-type-menu");

  var imageCheckSection = document.getElementById("image-check-section");
  var imageCheckSummary = document.getElementById("image-check-summary");
  var imageCheckTbody = document.getElementById("image-check-tbody");
  var btnCheckImages = document.getElementById("btn-check-images");

  var sceneListEl = document.getElementById("scene-list");
  var btnSceneAdd = document.getElementById("btn-scene-add");
  var btnSceneRename = document.getElementById("btn-scene-rename");
  var btnSceneDelete = document.getElementById("btn-scene-delete");

  var IMAGE_CHECK_CONCURRENCY = 4;

  function setStatus(msg, isError) {
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("is-error", !!isError);
  }

  function touchDraft() {
    localDirty = true;
  }

  function getCurrentSceneIndex() {
    for (var i = 0; i < scenes.length; i++) {
      if (scenes[i].id === currentSceneId) {
        return i;
      }
    }
    return -1;
  }

  function getCurrentScene() {
    var i = getCurrentSceneIndex();
    return i >= 0 ? scenes[i] : null;
  }

  function syncItemsToCurrentScene() {
    var idx = getCurrentSceneIndex();
    if (idx < 0) {
      return;
    }
    scenes[idx].items = items.map(cloneItem);
  }

  function uniqueSceneId(base) {
    var id = base;
    var n = 0;
    while (true) {
      var clash = scenes.some(function (s) {
        return s.id === id;
      });
      if (!clash) {
        return id;
      }
      n += 1;
      id = base + "-" + n;
    }
  }

  function selectScene(id, skipSync) {
    var hadDirty = !skipSync && localDirty;
    if (!skipSync) {
      syncItemsToCurrentScene();
    }
    currentSceneId = id;
    var idx = getCurrentSceneIndex();
    items = [];
    selectedIndex = -1;
    if (idx >= 0) {
      items = scenes[idx].items.map(function (it) {
        return normalizeIncomingItem(it);
      });
      selectedIndex = items.length ? 0 : -1;
    }
    renderSceneList();
    renderList();
    renderForm();
    refreshJsonPreview();
    updateSceneItemWarning();
    if (hadDirty) {
      setStatus(
        "已把上一场景内容合并到内存（未写入文件）。需要持久化请点击「保存」。",
        false
      );
    }
  }

  function buildPerItemErrors(list) {
    var perItem = list.map(function () {
      return [];
    });
    var seen = {};
    var idToFirstIndex = {};
    (list || []).forEach(function (it, idx) {
      var id = it && it.id != null ? String(it.id).trim() : "";
      if (!id) {
        perItem[idx].push("id 不能为空");
      } else {
        if (idToFirstIndex[id] !== undefined) {
          perItem[idx].push("id 重复");
          perItem[idToFirstIndex[id]].push("id 重复");
        } else {
          idToFirstIndex[id] = idx;
        }
      }
      var ty = it && it.type;
      if (!ty || ALLOWED_TYPES.indexOf(ty) === -1) {
        perItem[idx].push("type 无效");
        return;
      }
      if (ty === "text") {
        if (!it.body || !String(it.body).trim()) {
          perItem[idx].push("需非空 body");
        }
      }
      if (ty === "notice") {
        if (!it.body || !String(it.body).trim()) {
          perItem[idx].push("需非空 body");
        }
      }
      if (ty === "image") {
        if (!it.src || !String(it.src).trim()) {
          perItem[idx].push("需非空 src");
        }
      }
    });
    var hasBlank = (list || []).some(function (i) {
      return i && i.id === "blank" && i.type === "blank";
    });
    return { perItem: perItem, hasBlank: hasBlank };
  }

  function updateSceneItemWarning() {
    if (!sceneItemWarningEl) {
      return;
    }
    var info = buildPerItemErrors(items);
    if (!info.hasBlank) {
      sceneItemWarningEl.textContent =
        "本场景须包含一条 id 与 type 均为 blank 的项，否则无法通过保存/发布校验。";
      sceneItemWarningEl.classList.remove("is-hidden");
    } else {
      sceneItemWarningEl.textContent = "";
      sceneItemWarningEl.classList.add("is-hidden");
    }
  }

  function renderSceneList() {
    if (!sceneListEl) {
      return;
    }
    sceneListEl.innerHTML = "";
    scenes.forEach(function (sc) {
      var li = document.createElement("li");
      li.className = "editor-scene-item";
      li.setAttribute("role", "option");
      li.setAttribute("data-scene-id", sc.id);
      if (sc.id === currentSceneId) {
        li.classList.add("is-active");
      }
      var line1 = document.createElement("div");
      line1.className = "editor-scene-line-main";
      line1.textContent = sc.name || sc.id;
      var line2 = document.createElement("div");
      line2.className = "editor-scene-line-sub";
      var n = (sc.items && sc.items.length) || 0;
      line2.textContent = "id: " + sc.id + " · " + n + " 条";
      li.appendChild(line1);
      li.appendChild(line2);
      li.addEventListener("click", function () {
        if (sc.id !== currentSceneId) {
          selectScene(sc.id, false);
          touchDraft();
        }
      });
      sceneListEl.appendChild(li);
    });
  }

  function addScene() {
    syncItemsToCurrentScene();
    var sid = uniqueSceneId("scene");
    scenes.push({
      id: sid,
      name: "新场景",
      items: [{ id: "blank", type: "blank", label: "空白页" }],
    });
    selectScene(sid, true);
    touchDraft();
    setStatus("已添加场景，请编辑名称与条目。", false);
  }

  function renameCurrentScene() {
    var idx = getCurrentSceneIndex();
    if (idx < 0) {
      return;
    }
    var name = window.prompt("场景名称", scenes[idx].name || "");
    if (name === null) {
      return;
    }
    scenes[idx].name = String(name).trim();
    renderSceneList();
    renderForm();
    touchDraft();
  }

  function deleteCurrentScene() {
    if (scenes.length <= 1) {
      alert("至少保留一个场景。");
      return;
    }
    syncItemsToCurrentScene();
    var idx = getCurrentSceneIndex();
    scenes.splice(idx, 1);
    currentSceneId = scenes[0].id;
    selectScene(currentSceneId, true);
    touchDraft();
  }

  function cloneItem(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function normalizeIncomingItem(raw) {
    var o = cloneItem(raw);
    var t = o.type;
    if (t === "notice") {
      if ((!o.body || !String(o.body).trim()) && o.text != null) {
        o.body = String(o.text);
      }
    }
    if (t === "image") {
      if (!o.src && o.image != null) {
        o.src = String(o.image);
      }
    }
    return stripItemToType(o);
  }

  function stripItemToType(o) {
    var t = o.type;
    var base = { id: String(o.id || "").trim(), type: t };
    if (o.label != null && String(o.label).trim()) {
      base.label = String(o.label).trim();
    }
    if (t === "blank") {
      return base;
    }
    if (t === "notice") {
      base.body =
        o.body != null
          ? String(o.body)
          : o.text != null
            ? String(o.text)
            : "";
      return base;
    }
    if (t === "text") {
      if (o.title != null) {
        base.title = String(o.title);
      }
      base.body = o.body != null ? String(o.body) : "";
      return base;
    }
    if (t === "image") {
      base.src =
        o.src != null
          ? String(o.src)
          : o.image != null
            ? String(o.image)
            : "";
      return base;
    }
    return base;
  }

  function serializeItem(o) {
    var t = o.type;
    var out = { id: String(o.id).trim(), type: t };
    if (o.label != null && String(o.label).trim()) {
      out.label = String(o.label).trim();
    }
    if (t === "blank") {
      return out;
    }
    if (t === "notice") {
      out.body = o.body != null ? String(o.body) : "";
      return out;
    }
    if (t === "text") {
      if (o.title != null && String(o.title).trim()) {
        out.title = String(o.title).trim();
      }
      out.body = o.body != null ? String(o.body) : "";
      return out;
    }
    if (t === "image") {
      out.src = o.src != null ? String(o.src).trim() : "";
      return out;
    }
    return out;
  }

  function getCatalogForSave() {
    syncItemsToCurrentScene();
    return {
      scenes: scenes.map(function (sc) {
        return {
          id: sc.id,
          name: sc.name || "",
          items: sc.items.map(serializeItem),
        };
      }),
    };
  }

  function applyTypeChange(oldItem, newType) {
    var id = String(oldItem.id || "").trim();
    var label = oldItem.label != null ? String(oldItem.label) : "";
    var o = { id: id, type: newType };
    if (label.trim()) {
      o.label = label.trim();
    }
    if (newType === "blank") {
      return o;
    }
    if (newType === "notice") {
      o.body =
        oldItem.body != null
          ? String(oldItem.body)
          : oldItem.text != null
            ? String(oldItem.text)
            : "";
      return o;
    }
    if (newType === "text") {
      o.title = oldItem.title != null ? String(oldItem.title) : "";
      o.body = oldItem.body != null ? String(oldItem.body) : "";
      return o;
    }
    if (newType === "image") {
      o.src =
        oldItem.src != null
          ? String(oldItem.src)
          : oldItem.image != null
            ? String(oldItem.image)
            : "";
      return o;
    }
    return o;
  }

  function uniqueId(base, excludeIndex) {
    var id = base;
    var n = 0;
    while (true) {
      var clash = false;
      for (var i = 0; i < items.length; i++) {
        if (i === excludeIndex) {
          continue;
        }
        if (items[i].id === id) {
          clash = true;
          break;
        }
      }
      if (!clash) {
        return id;
      }
      n += 1;
      id = base + "-" + n;
    }
  }

  /**
   * 按类型生成唯一 id：blank 优先使用字面量 "blank"（若未被其他项占用）。
   * excludeIndex 为将写入的下标；新建条目尚未插入列表时用 -1。
   */
  function uniqueIdForType(type, excludeIndex) {
    if (type === "blank") {
      var otherHasBlankId = items.some(function (it, i) {
        return i !== excludeIndex && it && String(it.id || "").trim() === "blank";
      });
      if (!otherHasBlankId) {
        return "blank";
      }
      return uniqueId("blank", excludeIndex);
    }
    var base = type === "notice" ? "notice" : type === "text" ? "text" : type === "image" ? "image" : "item";
    return uniqueId(base, excludeIndex);
  }

  function createDefaultItem(type) {
    var id = uniqueIdForType(type, -1);
    switch (type) {
      case "blank":
        return {
          id: id,
          type: "blank",
          label: "空白页",
        };
      case "notice":
        return {
          id: id,
          type: "notice",
          label: "提示",
          body: "",
        };
      case "text":
        return {
          id: id,
          type: "text",
          label: "正文",
          title: "",
          body: "",
        };
      case "image":
        return {
          id: id,
          type: "image",
          label: "图片",
          src: "",
        };
      default:
        return { id: id, type: "blank", label: "" };
    }
  }

  function validateItems(list) {
    var errors = [];
    if (!list || !Array.isArray(list) || !list.length) {
      errors.push("items 不能为空。");
      return { ok: false, errors: errors };
    }
    var hasBlank = list.some(function (i) {
      return i && i.id === "blank" && i.type === "blank";
    });
    if (!hasBlank) {
      errors.push("必须存在一条 id 为 blank 且 type 为 blank 的项。");
    }
    var seen = {};
    list.forEach(function (it, idx) {
      var n = idx + 1;
      var id = it && it.id != null ? String(it.id).trim() : "";
      if (!id) {
        errors.push("第 " + n + " 项：id 不能为空。");
      }
      if (id && seen[id]) {
        errors.push("id 重复：" + id);
      }
      if (id) {
        seen[id] = true;
      }
      var ty = it && it.type;
      if (!ty || ALLOWED_TYPES.indexOf(ty) === -1) {
        errors.push(
          "第 " + n + " 项" + (id ? "（id: " + id + "）" : "") + "：type 必须是 blank / notice / text / image 之一。"
        );
        return;
      }
      if (ty === "text") {
        if (!it.body || !String(it.body).trim()) {
          errors.push("第 " + n + " 项（id: " + id + "）：text 类型需要非空 body。");
        }
      }
      if (ty === "notice") {
        if (!it.body || !String(it.body).trim()) {
          errors.push("第 " + n + " 项（id: " + id + "）：notice 类型需要非空 body。");
        }
      }
      if (ty === "image") {
        if (!it.src || !String(it.src).trim()) {
          errors.push("第 " + n + " 项（id: " + id + "）：image 类型需要非空 src。");
        }
      }
    });
    return { ok: errors.length === 0, errors: errors };
  }

  function validateAllScenes() {
    syncItemsToCurrentScene();
    for (var s = 0; s < scenes.length; s++) {
      var v = validateItems(scenes[s].items);
      if (!v.ok) {
        return {
          ok: false,
          error: "场景 \"" + scenes[s].id + "\"：" + v.errors.join(" "),
        };
      }
    }
    return { ok: true };
  }

  function refreshJsonPreview() {
    var catalog = getCatalogForSave();
    var pretty = JSON.stringify(catalog, null, 2);
    jsonReadonly.textContent = pretty;
    if (jsonAdvancedOpen) {
      if (!jsonAdvancedDirty) {
        jsonAdvancedTa.value = pretty;
      }
    }
  }

  function syncFormToState() {
    if (selectedIndex < 0 || selectedIndex >= items.length) {
      return;
    }
    var it = items[selectedIndex];
    var t = fType.value;
    it.id = fId.value.trim();
    it.type = t;
    delete it.label;
    delete it.body;
    delete it.title;
    delete it.src;
    delete it.text;
    delete it.image;
    var lab = fLabel.value.trim();
    if (lab) {
      it.label = lab;
    }
    if (t === "notice") {
      it.body = fBodyNotice.value;
    } else if (t === "text") {
      it.title = fTitle.value;
      it.body = fBodyText.value;
    } else if (t === "image") {
      it.src = fSrc.value;
    }
    refreshJsonPreview();
  }

  function hasActiveFilter() {
    var q = itemFilterSearch && itemFilterSearch.value.trim();
    var ft = itemFilterType && itemFilterType.value;
    return !!(q || ft);
  }

  function getFilteredIndices() {
    var q = (itemFilterSearch && itemFilterSearch.value) ? itemFilterSearch.value.trim().toLowerCase() : "";
    var ft = (itemFilterType && itemFilterType.value) || "";
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (ft && it.type !== ft) {
        continue;
      }
      if (q) {
        var id = String(it.id || "").toLowerCase();
        var lab = String(it.label || "").toLowerCase();
        if (id.indexOf(q) === -1 && lab.indexOf(q) === -1) {
          continue;
        }
      }
      out.push(i);
    }
    return out;
  }

  function getNavIndices() {
    if (!hasActiveFilter()) {
      var all = [];
      for (var i = 0; i < items.length; i++) {
        all.push(i);
      }
      return all;
    }
    var fi = getFilteredIndices();
    if (fi.length === 0 && items.length) {
      var fallback = [];
      for (var j = 0; j < items.length; j++) {
        fallback.push(j);
      }
      return fallback;
    }
    return fi;
  }

  function updateNavButtons() {
    var nav = getNavIndices();
    var pos = nav.indexOf(selectedIndex);
    if (btnPrevItem) {
      btnPrevItem.disabled = nav.length < 2 || pos <= 0;
    }
    if (btnNextItem) {
      btnNextItem.disabled = nav.length < 2 || pos < 0 || pos >= nav.length - 1;
    }
  }

  function updateLivePreview() {
    if (selectedIndex < 0 || selectedIndex >= items.length) {
      return;
    }
    syncFormToState();
    var t = fType.value;
    livePreviewBlank.classList.toggle("is-hidden", t !== "blank");
    livePreviewNotice.classList.toggle("is-hidden", t !== "notice");
    livePreviewText.classList.toggle("is-hidden", t !== "text");
    livePreviewImage.classList.toggle("is-hidden", t !== "image");

    if (t === "notice") {
      var nb = (fBodyNotice.value || "").trim();
      liveNoticeText.textContent = nb || "（空）";
    }
    if (t === "text") {
      var tit = (fTitle.value || "").trim();
      liveTextTitle.textContent = tit;
      liveTextTitle.classList.toggle("is-hidden", !tit);
      liveTextBody.textContent = fBodyText.value || "";
    }
    if (t === "image") {
      var src = (fSrc.value || "").trim();
      liveImageFallback.classList.add("is-hidden");
      if (!src) {
        liveImageImg.removeAttribute("src");
        liveImageImg.classList.add("is-hidden");
        liveImageFallback.textContent = "请填写图片路径";
        liveImageFallback.classList.remove("is-hidden");
        return;
      }
      liveImageImg.classList.remove("is-hidden");
      liveImageImg.alt = (fLabel.value || "").trim() || "预览";
      liveImageImg.onload = function () {
        liveImageFallback.classList.add("is-hidden");
        liveImageImg.classList.remove("is-hidden");
      };
      liveImageImg.onerror = function () {
        liveImageImg.classList.add("is-hidden");
        liveImageFallback.textContent = "无法加载图片";
        liveImageFallback.classList.remove("is-hidden");
      };
      liveImageImg.src = src;
    }
  }

  function updateContextHeader() {
    var sc = getCurrentScene();
    if (ctxSceneName) {
      ctxSceneName.textContent = sc ? (sc.name || sc.id) + "（" + (sc.id || "") + "）" : "—";
    }
    if (selectedIndex < 0 || selectedIndex >= items.length) {
      if (ctxItemTitle) ctxItemTitle.textContent = "—";
      if (ctxItemType) {
        ctxItemType.textContent = "";
        ctxItemType.className = "editor-type-pill";
      }
      if (ctxItemIndex) ctxItemIndex.textContent = "";
      return;
    }
    var it = items[selectedIndex];
    var disp = (it.label && String(it.label).trim()) || it.id || "（无 id）";
    if (ctxItemTitle) {
      ctxItemTitle.textContent = disp + " · " + (it.id || "");
    }
    if (ctxItemType) {
      ctxItemType.textContent = it.type || "?";
      ctxItemType.className = "editor-type-pill editor-type-pill--" + String(it.type || "");
    }
    if (ctxItemIndex) {
      ctxItemIndex.textContent =
        "第 " + (selectedIndex + 1) + " / " + items.length + " 项";
    }
  }

  function renderList() {
    itemListEl.innerHTML = "";
    var errInfo = buildPerItemErrors(items);
    var perItem = errInfo.perItem;
    var indices = getFilteredIndices();
    var filterOn = hasActiveFilter();

    if (filterOn && indices.length === 0 && items.length) {
      var emptyLi = document.createElement("li");
      emptyLi.className = "editor-list-empty-filter";
      emptyLi.textContent = "无匹配条目，请调整搜索或类型筛选。";
      itemListEl.appendChild(emptyLi);
      updateNavButtons();
      updateSceneItemWarning();
      return;
    }

    var showIndices = filterOn ? indices : items.map(function (_, i) {
      return i;
    });

    showIndices.forEach(function (index) {
      var it = items[index];
      var li = document.createElement("li");
      li.className = "editor-list-item";
      li.setAttribute("role", "option");
      li.setAttribute("data-index", String(index));
      if (index === selectedIndex) {
        li.classList.add("is-active");
      }
      var errs = perItem[index] || [];
      if (errs.length) {
        li.classList.add("has-error");
      }

      var rowTop = document.createElement("div");
      rowTop.className = "editor-list-item-top";
      var title = (it.label && String(it.label).trim()) || it.id || "（无 id）";
      var line1 = document.createElement("div");
      line1.className = "editor-list-line1";
      line1.textContent = title;

      var typePill = document.createElement("span");
      typePill.className = "editor-type-pill editor-type-pill--small editor-type-pill--" + String(it.type || "");
      typePill.textContent = it.type || "?";

      rowTop.appendChild(line1);
      rowTop.appendChild(typePill);

      var line2 = document.createElement("div");
      line2.className = "editor-list-line2";
      line2.textContent = "id: " + (it.id || "");

      li.appendChild(rowTop);
      li.appendChild(line2);

      if (errs.length) {
        var errEl = document.createElement("div");
        errEl.className = "editor-list-errors";
        errEl.textContent = errs.join(" · ");
        li.appendChild(errEl);
      }

      li.addEventListener("click", function () {
        selectIndex(index);
      });
      itemListEl.appendChild(li);
    });
    updateNavButtons();
    updateSceneItemWarning();
  }

  function renderForm() {
    updateContextHeader();
    if (selectedIndex < 0 || selectedIndex >= items.length) {
      formWrap.classList.add("is-hidden");
      formEmpty.classList.remove("is-hidden");
      refreshJsonPreview();
      updateNavButtons();
      return;
    }
    formEmpty.classList.add("is-hidden");
    formWrap.classList.remove("is-hidden");
    var it = items[selectedIndex];
    if (!String(it.id || "").trim()) {
      it.id = uniqueIdForType(it.type || "blank", selectedIndex);
    }
    fId.value = it.id || "";
    fType.value = it.type || "blank";
    fLabel.value = it.label != null ? it.label : "";

    fieldNotice.classList.toggle("is-hidden", it.type !== "notice");
    fieldText.classList.toggle("is-hidden", it.type !== "text");
    fieldImage.classList.toggle("is-hidden", it.type !== "image");

    fBodyNotice.value = it.type === "notice" ? (it.body != null ? it.body : "") : "";
    fTitle.value = it.type === "text" ? (it.title != null ? it.title : "") : "";
    fBodyText.value = it.type === "text" ? (it.body != null ? it.body : "") : "";
    fSrc.value = it.type === "image" ? (it.src != null ? it.src : "") : "";
    if (fImageFile) {
      fImageFile.value = "";
    }
    setImageUploadStatus("");

    updateLivePreview();
    refreshJsonPreview();
    updateNavButtons();
  }

  function selectIndex(index) {
    if (index === selectedIndex) {
      return;
    }
    if (selectedIndex >= 0 && selectedIndex < items.length) {
      syncFormToState();
    }
    selectedIndex = index;
    renderList();
    renderForm();
  }

  function onFilterChange() {
    if (selectedIndex >= 0 && hasActiveFilter()) {
      var fi = getFilteredIndices();
      if (fi.indexOf(selectedIndex) === -1 && fi.length) {
        selectIndex(fi[0]);
        return;
      }
    }
    renderList();
    renderForm();
  }

  function navPrev() {
    var nav = getNavIndices();
    if (nav.length < 2) {
      return;
    }
    var pos = nav.indexOf(selectedIndex);
    if (pos < 0) {
      selectIndex(nav[0]);
      return;
    }
    if (pos <= 0) {
      return;
    }
    selectIndex(nav[pos - 1]);
  }

  function navNext() {
    var nav = getNavIndices();
    if (nav.length < 2) {
      return;
    }
    var pos = nav.indexOf(selectedIndex);
    if (pos < 0) {
      selectIndex(nav[0]);
      return;
    }
    if (pos >= nav.length - 1) {
      return;
    }
    selectIndex(nav[pos + 1]);
  }

  function loadFromServer() {
    setStatus("加载中…", false);
    apiFetch("/api/items/draft")
      .then(function (r) {
        if (r.status === 401) {
          window.location.href =
            "/login?" +
            new URLSearchParams({ next: "/editor", role: "editor" }).toString();
          throw new Error("需要登录");
        }
        if (!r.ok) {
          throw new Error("HTTP " + r.status);
        }
        return r.json();
      })
      .then(function (data) {
        if (data.scenes && data.scenes.length) {
          scenes = data.scenes.map(function (sc) {
            return {
              id: String(sc.id || "").trim(),
              name: sc.name != null ? String(sc.name) : "",
              items: (sc.items || []).map(normalizeIncomingItem),
            };
          });
        } else if (data.items && data.items.length) {
          scenes = [
            {
              id: "default",
              name: "默认",
              items: data.items.map(normalizeIncomingItem),
            },
          ];
        } else {
          scenes = [
            {
              id: "default",
              name: "默认",
              items: [{ id: "blank", type: "blank", label: "空白页" }],
            },
          ];
        }
        currentSceneId = scenes[0].id;
        selectScene(currentSceneId, true);
        jsonAdvancedDirty = false;
        publishedRevision =
          typeof data.publishedRevision === "number" ? data.publishedRevision : null;
        draftMatchesPublished = data.draftMatchesPublished === true;
        localDirty = false;
        var hint =
          publishedRevision != null
            ? "已加载。（当前正式目录 revision " + publishedRevision + "）"
            : "已加载。";
        setStatus(hint, false);
      })
      .catch(function (e) {
        if (e && e.message === "需要登录") {
          return;
        }
        setStatus("加载失败: " + (e.message || String(e)), true);
      });
  }

  function save() {
    syncFormToState();
    if (jsonAdvancedOpen && jsonAdvancedDirty) {
      if (
        !window.confirm(
          "高级 JSON 有未应用的修改。将忽略这些修改，仅保存当前表单数据。是否继续？"
        )
      ) {
        return;
      }
    }
    var catalog = getCatalogForSave();
    var va = validateAllScenes();
    if (!va.ok) {
      setStatus(va.error, true);
      renderList();
      return;
    }
    setStatus("保存中…", false);
    apiFetch("/api/items", {
      method: "PUT",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(catalog),
    })
      .then(function (r) {
        if (r.status === 401) {
          window.location.href =
            "/login?" +
            new URLSearchParams({ next: "/editor", role: "editor" }).toString();
          throw new Error("需要登录");
        }
        return r.json().then(function (body) {
          if (!r.ok) {
            throw new Error(body.error || r.statusText);
          }
          return body;
        });
      })
      .then(function (data) {
        jsonAdvancedDirty = false;
        refreshJsonPreview();
        publishedRevision =
          data && typeof data.publishedRevision === "number"
            ? data.publishedRevision
            : publishedRevision;
        draftMatchesPublished = data.draftMatchesPublished === true;
        localDirty = false;
        var line =
          publishedRevision != null
            ? "已保存至编辑文件，需「发布」后同步至会众端）。"
            : "已保存。请点击「发布」更新正式 items.json。";
        setStatus(line, false);
      })
      .catch(function (e) {
        if (e && e.message === "需要登录") {
          return;
        }
        setStatus(String(e.message || e), true);
      });
  }

  function publishLive() {
    syncFormToState();
    if (jsonAdvancedOpen && jsonAdvancedDirty) {
      if (
        !window.confirm(
          "高级 JSON 有未应用的修改。发布将基于当前表单与列表，未应用的 JSON 修改将丢失。是否继续？"
        )
      ) {
        return;
      }
    }
    var catalog = getCatalogForSave();
    var va = validateAllScenes();
    if (!va.ok) {
      setStatus(va.error, true);
      renderList();
      return;
    }
    setStatus("正在保存并发布…", false);
    apiFetch("/api/items", {
      method: "PUT",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(catalog),
    })
      .then(function (r) {
        if (r.status === 401) {
          window.location.href =
            "/login?" +
            new URLSearchParams({ next: "/editor", role: "editor" }).toString();
          throw new Error("需要登录");
        }
        return r.json().then(function (body) {
          if (!r.ok) {
            throw new Error(body.error || r.statusText);
          }
          return body;
        });
      })
      .then(function () {
        return apiFetch("/api/items/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: "{}",
        });
      })
      .then(function (r) {
        if (r.status === 401) {
          window.location.href =
            "/login?" +
            new URLSearchParams({ next: "/editor", role: "editor" }).toString();
          throw new Error("需要登录");
        }
        return r.json().then(function (body) {
          if (!r.ok) {
            throw new Error(body.error || r.statusText);
          }
          return body;
        });
      })
      .then(function (data) {
        publishedRevision = data.revision != null ? data.revision : publishedRevision;
        draftMatchesPublished = true;
        localDirty = false;
        jsonAdvancedDirty = false;
        refreshJsonPreview();
        setStatus(
          "已发布。正式 items.json 已更新，revision " +
            (data.revision != null ? data.revision : "") +
            "，stateVersion " +
            (data.stateVersion != null ? data.stateVersion : "") +
            "。",
          false
        );
      })
      .catch(function (e) {
        if (e && e.message === "需要登录") {
          return;
        }
        setStatus(String(e.message || e), true);
      });
  }

  function formatJson() {
    syncFormToState();
    try {
      var catalog = getCatalogForSave();
      var pretty = JSON.stringify(catalog, null, 2);
      jsonReadonly.textContent = pretty;
      if (jsonAdvancedOpen) {
        jsonAdvancedTa.value = pretty;
        jsonAdvancedDirty = false;
      }
      setStatus("已格式化预览。", false);
    } catch (e) {
      setStatus("格式化失败: " + (e.message || String(e)), true);
    }
  }

  function toggleJsonView() {
    syncFormToState();
    refreshJsonPreview();
    var btn = document.getElementById("btn-toggle-json");
    var structuredVisible = !viewStructured.classList.contains("is-hidden");
    if (structuredVisible) {
      viewStructured.classList.add("is-hidden");
      viewJson.classList.remove("is-hidden");
      btn.textContent = "返回表单编辑";
    } else {
      viewJson.classList.add("is-hidden");
      viewStructured.classList.remove("is-hidden");
      btn.textContent = "查看原始 JSON";
    }
  }

  function toggleJsonAdvanced() {
    jsonAdvancedOpen = !jsonAdvancedOpen;
    jsonAdvancedWarn.classList.toggle("is-hidden", !jsonAdvancedOpen);
    jsonAdvancedTa.classList.toggle("is-hidden", !jsonAdvancedOpen);
    jsonAdvancedActions.classList.toggle("is-hidden", !jsonAdvancedOpen);
    document.getElementById("btn-json-advanced").textContent = jsonAdvancedOpen
      ? "关闭高级编辑"
      : "高级模式：直接编辑 JSON";
    if (jsonAdvancedOpen) {
      jsonAdvancedTa.value = jsonReadonly.textContent;
      jsonAdvancedDirty = false;
    } else {
      jsonAdvancedDirty = false;
    }
  }

  function applyJsonAdvanced() {
    var text = jsonAdvancedTa.value;
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setStatus("JSON 无法解析: " + (e.message || String(e)), true);
      return;
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.scenes)) {
      setStatus("根对象必须是 { \"scenes\": [ { id, name, items: [...] }, ... ] }。", true);
      return;
    }
    scenes = parsed.scenes.map(function (sc) {
      return {
        id: String(sc.id || "").trim(),
        name: sc.name != null ? String(sc.name) : "",
        items: (sc.items || []).map(normalizeIncomingItem),
      };
    });
    if (!scenes.length) {
      setStatus("scenes 不能为空。", true);
      return;
    }
    currentSceneId = scenes[0].id;
    selectScene(currentSceneId, true);
    jsonAdvancedDirty = false;
    renderList();
    renderForm();
    refreshJsonPreview();
    viewJson.classList.add("is-hidden");
    viewStructured.classList.remove("is-hidden");
    document.getElementById("btn-toggle-json").textContent = "查看原始 JSON";
    jsonAdvancedOpen = false;
    jsonAdvancedWarn.classList.add("is-hidden");
    jsonAdvancedTa.classList.add("is-hidden");
    jsonAdvancedActions.classList.add("is-hidden");
    document.getElementById("btn-json-advanced").textContent = "高级模式：直接编辑 JSON";
    touchDraft();
    setStatus("已应用 JSON 到表单。", false);
  }

  function setAddMenuOpen(open) {
    if (!addTypeMenu || !btnAddMenu) {
      return;
    }
    addTypeMenu.classList.toggle("is-hidden", !open);
    btnAddMenu.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function addItemOfType(type) {
    syncFormToState();
    var item = createDefaultItem(type);
    items.push(item);
    selectedIndex = items.length - 1;
    setAddMenuOpen(false);
    renderList();
    renderForm();
    touchDraft();
    setStatus("已新增一项，请检查 id 是否唯一。", false);
  }

  function deleteCurrent() {
    if (selectedIndex < 0) {
      return;
    }
    if (!window.confirm("确定删除该项？")) {
      return;
    }
    items.splice(selectedIndex, 1);
    if (selectedIndex >= items.length) {
      selectedIndex = items.length - 1;
    }
    renderList();
    renderForm();
    touchDraft();
  }

  function clearCurrentSceneItems() {
    syncFormToState();
    var sc = getCurrentScene();
    var sceneLabel = sc ? (sc.name && String(sc.name).trim() ? sc.name : sc.id) : "当前场景";
    var msg =
      "确定要一键清空场景「" +
      sceneLabel +
      "」下的全部条目吗？\n\n将只保留一条空白页（blank）。未保存的修改可点「重新加载」恢复（若已保存则无法由此恢复）。";
    if (!window.confirm(msg)) {
      return;
    }
    items = [{ id: "blank", type: "blank", label: "空白页" }];
    selectedIndex = 0;
    syncItemsToCurrentScene();
    if (itemFilterSearch) {
      itemFilterSearch.value = "";
    }
    if (itemFilterType) {
      itemFilterType.value = "";
    }
    jsonAdvancedDirty = false;
    renderList();
    renderForm();
    updateSceneItemWarning();
    touchDraft();
    setStatus("已清空当前场景条目（仅保留空白页）。如需写入文件请点击「保存」或「发布」。", false);
  }

  function copyCurrent() {
    if (selectedIndex < 0) {
      return;
    }
    syncFormToState();
    var copy = cloneItem(items[selectedIndex]);
    copy.id = uniqueId(String(copy.id || "item") + "-copy", -1);
    items.splice(selectedIndex + 1, 0, copy);
    selectedIndex += 1;
    renderList();
    renderForm();
    touchDraft();
    setStatus("已复制，请按需修改 id。", false);
  }

  function moveUp() {
    if (selectedIndex <= 0) {
      return;
    }
    syncFormToState();
    var t = items[selectedIndex - 1];
    items[selectedIndex - 1] = items[selectedIndex];
    items[selectedIndex] = t;
    selectedIndex -= 1;
    renderList();
    renderForm();
    touchDraft();
  }

  function moveDown() {
    if (selectedIndex < 0 || selectedIndex >= items.length - 1) {
      return;
    }
    syncFormToState();
    var t = items[selectedIndex + 1];
    items[selectedIndex + 1] = items[selectedIndex];
    items[selectedIndex] = t;
    selectedIndex += 1;
    renderList();
    renderForm();
    touchDraft();
  }

  function getImageSrcForItem(it) {
    if (!it || it.type !== "image") {
      return "";
    }
    if (it.src != null && String(it.src).trim()) {
      return String(it.src).trim();
    }
    if (it.image != null && String(it.image).trim()) {
      return String(it.image).trim();
    }
    return "";
  }

  function checkImageResources() {
    syncFormToState();
    syncItemsToCurrentScene();

    var rows = [];
    scenes.forEach(function (sc) {
      (sc.items || []).forEach(function (it) {
        if (it && it.type === "image") {
          rows.push({
            sceneId: sc.id,
            id: it.id != null ? String(it.id) : "",
            label:
              it.label != null && String(it.label).trim()
                ? String(it.label).trim()
                : "—",
            src: getImageSrcForItem(it),
          });
        }
      });
    });

    if (!rows.length) {
      imageCheckSection.classList.add("is-hidden");
      imageCheckTbody.innerHTML = "";
      imageCheckSummary.textContent = "";
      setStatus("没有 image 类型的项。", false);
      return;
    }

    imageCheckSection.classList.remove("is-hidden");
    btnCheckImages.disabled = true;
    imageCheckSummary.textContent =
      "检查中… 共 " +
      rows.length +
      " 条，每批最多 " +
      IMAGE_CHECK_CONCURRENCY +
      " 张并行";

    imageCheckTbody.innerHTML = "";
    var trList = [];
    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      var tdScene = document.createElement("td");
      var tdId = document.createElement("td");
      var tdLabel = document.createElement("td");
      var tdSrc = document.createElement("td");
      var tdStatus = document.createElement("td");
      tdStatus.className = "editor-image-check-status";
      tdScene.textContent = row.sceneId || "";
      tdId.textContent = row.id;
      tdLabel.textContent = row.label;
      tdSrc.textContent = row.src || "（空）";
      tdSrc.title = row.src || "";
      tdStatus.textContent = "检查中…";
      tr.appendChild(tdScene);
      tr.appendChild(tdId);
      tr.appendChild(tdLabel);
      tr.appendChild(tdSrc);
      tr.appendChild(tdStatus);
      imageCheckTbody.appendChild(tr);
      trList.push(tr);
    });

    var okCount = 0;
    var failCount = 0;

    function applyStatus(tr, ok, statusText) {
      var td = tr.querySelector(".editor-image-check-status");
      td.textContent = statusText;
      td.classList.remove("editor-image-check-status--ok", "editor-image-check-status--fail");
      if (ok) {
        okCount += 1;
        td.classList.add("editor-image-check-status--ok");
      } else {
        failCount += 1;
        td.classList.add("editor-image-check-status--fail");
      }
    }

    function checkOneRow(row, tr) {
      return new Promise(function (resolve) {
        if (!row.src || !String(row.src).trim()) {
          applyStatus(tr, false, "缺少 src");
          resolve();
          return;
        }
        var img = new Image();
        var settled = false;
        function done(ok, text) {
          if (settled) return;
          settled = true;
          applyStatus(tr, ok, text);
          resolve();
        }
        img.onload = function () {
          done(true, "正常");
        };
        img.onerror = function () {
          done(false, "图片加载失败");
        };
        try {
          img.src = row.src;
        } catch (e) {
          done(false, "图片加载失败");
        }
      });
    }

    var batchStart = 0;

    function runNextBatch() {
      if (batchStart >= rows.length) {
        btnCheckImages.disabled = false;
        imageCheckSummary.textContent =
          "共 " +
          rows.length +
          " 条 · 成功 " +
          okCount +
          " · 失败 " +
          failCount +
          "（每批并行 " +
          IMAGE_CHECK_CONCURRENCY +
          "）";
        setStatus(
          "图片检查完成：成功 " + okCount + "，失败 " + failCount + "。",
          failCount > 0
        );
        return;
      }
      var end = Math.min(batchStart + IMAGE_CHECK_CONCURRENCY, rows.length);
      var promises = [];
      for (var j = batchStart; j < end; j++) {
        promises.push(checkOneRow(rows[j], trList[j]));
      }
      batchStart = end;
      Promise.all(promises).then(function () {
        imageCheckSummary.textContent =
          "进行中… 已处理 " + batchStart + " / " + rows.length;
        runNextBatch();
      });
    }

    runNextBatch();
  }

  fId.addEventListener("input", function () {
    syncFormToState();
    renderList();
    updateContextHeader();
    updateLivePreview();
    touchDraft();
  });
  fLabel.addEventListener("input", function () {
    syncFormToState();
    updateContextHeader();
    updateLivePreview();
    touchDraft();
  });
  fBodyNotice.addEventListener("input", function () {
    syncFormToState();
    renderList();
    updateLivePreview();
    touchDraft();
  });
  fTitle.addEventListener("input", function () {
    syncFormToState();
    updateLivePreview();
    touchDraft();
  });
  fBodyText.addEventListener("input", function () {
    syncFormToState();
    renderList();
    updateLivePreview();
    touchDraft();
  });
  fSrc.addEventListener("input", function () {
    syncFormToState();
    renderList();
    updateLivePreview();
    touchDraft();
  });

  if (fImageFile) {
    fImageFile.addEventListener("change", function () {
      var files = fImageFile.files;
      if (!files || !files.length) {
        return;
      }
      uploadImageFile(files[0]);
    });
  }

  if (btnPdfImport && fPdfImport) {
    btnPdfImport.addEventListener("click", function () {
      fPdfImport.click();
    });
    fPdfImport.addEventListener("change", function () {
      var fs = fPdfImport.files;
      if (!fs || !fs.length) {
        return;
      }
      importPdfAsImageItems(fs[0]);
    });
  }

  fType.addEventListener("change", function () {
    if (selectedIndex < 0) {
      return;
    }
    var newType = fType.value;
    items[selectedIndex] = applyTypeChange(items[selectedIndex], newType);
    items[selectedIndex].id = uniqueIdForType(newType, selectedIndex);
    renderList();
    renderForm();
    touchDraft();
  });

  if (itemFilterSearch) {
    itemFilterSearch.addEventListener("input", onFilterChange);
  }
  if (itemFilterType) {
    itemFilterType.addEventListener("change", onFilterChange);
  }

  if (btnPrevItem) {
    btnPrevItem.addEventListener("click", navPrev);
  }
  if (btnNextItem) {
    btnNextItem.addEventListener("click", navNext);
  }

  document.getElementById("btn-reload").addEventListener("click", loadFromServer);
  var btnClearScene = document.getElementById("btn-clear-scene");
  if (btnClearScene) {
    btnClearScene.addEventListener("click", clearCurrentSceneItems);
  }
  document.getElementById("btn-save").addEventListener("click", save);
  var btnPublish = document.getElementById("btn-publish");
  if (btnPublish) {
    btnPublish.addEventListener("click", publishLive);
  }
  document.getElementById("btn-check-images").addEventListener("click", checkImageResources);
  document.getElementById("btn-format").addEventListener("click", formatJson);
  document.getElementById("btn-toggle-json").addEventListener("click", toggleJsonView);
  document.getElementById("btn-back-form").addEventListener("click", toggleJsonView);

  document.getElementById("btn-json-advanced").addEventListener("click", toggleJsonAdvanced);
  document.getElementById("btn-json-apply").addEventListener("click", applyJsonAdvanced);

  jsonAdvancedTa.addEventListener("input", function () {
    jsonAdvancedDirty = true;
  });

  if (btnAddMenu && addTypeMenu) {
    btnAddMenu.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = addTypeMenu.classList.contains("is-hidden");
      setAddMenuOpen(open);
    });
    addTypeMenu.querySelectorAll("[data-new-type]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        addItemOfType(btn.getAttribute("data-new-type"));
      });
    });
    document.addEventListener("click", function () {
      setAddMenuOpen(false);
    });
    editorAddWrap.addEventListener("click", function (e) {
      e.stopPropagation();
    });
  }

  document.getElementById("btn-delete").addEventListener("click", deleteCurrent);
  document.getElementById("btn-copy").addEventListener("click", copyCurrent);
  document.getElementById("btn-move-up").addEventListener("click", moveUp);
  document.getElementById("btn-move-down").addEventListener("click", moveDown);

  if (btnSceneAdd) {
    btnSceneAdd.addEventListener("click", addScene);
  }
  if (btnSceneRename) {
    btnSceneRename.addEventListener("click", renameCurrentScene);
  }
  if (btnSceneDelete) {
    btnSceneDelete.addEventListener("click", deleteCurrentScene);
  }

  loadFromServer();
})();
