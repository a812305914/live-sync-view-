/**
 * Minimal Express server: static files + JSON API for live sync state.
 * 当前激活项持久化在 data/state.json（无数据库）。
 *
 * --- 多场景（scene）---
 * - data/items.json 与草稿为 { scenes: [ { id, name, items: [...] } ] }；旧版 { items: [...] } 读入时自动包一层默认 scene（id: "default"）。
 * - data/state.json 含 sceneId（当前场景）与 activeId（该场景内当前条目）；会众端仅 GET /api/state，不感知 scene 列表，只显示当前场景的当前 item。
 * - 切换 scene：控制端 POST /api/scene { sceneId } → 不保留上一场景的 activeId；activeId 始终重置为当前 scene 的 blank（若存在）否则首项；stateVersion 递增并持久化。
 *
 * --- 草稿（draft）与正式（published）数据关系 ---
 * - data/items.json：会众端 /admin 使用的「已发布」目录；结构与草稿一致（含 scenes）。
 * - data/items.draft.json：编辑器独占的草稿；结构同正式。
 * - 仅当调用「发布」时，才在校验通过后把草稿原子写入 items.json，并复用既有备份逻辑（整份 scenes 一起发布）。
 *
 * --- 发布流程（POST /api/items/publish）---
 * 1. 对内存中的 draftCatalog 跑 validateCatalog（与保存正式时同一套规则）。
 * 2. 调用 writeItemsFile：先 backup 当前 items.json，再临时文件 + rename 覆盖 items.json。
 * 3. 递增 itemsRevision、写入 catalog-meta、递增 stateVersion 并 persistState。
 * 4. 将草稿文件内容与内存 draftCatalog 与线上一致（避免编辑端显示「未发布」误判）。
 *
 * --- 编辑器图片上传 ---
 * - POST /api/editor/upload-media：multipart 字段名 `file`，保存至 public/media，响应 `{ ok, url: "/media/文件名" }`；需编辑端会话（与 PUT /api/items 相同）。
 * - PDF 拆页由编辑端（public/editor.html + pdf.js CDN）在浏览器内转 PNG 后仍走本接口逐页上传，服务端不解析 PDF。
 *
 * --- 页面访问保护（/admin、/editor）---
 * - 环境变量：ADMIN_PASSWORD（控制端）、EDITOR_PASSWORD（编辑端，可省略则与 ADMIN_PASSWORD 相同）；
 *   兼容旧名 WORSHIP_ADMIN_PASSWORD / WORSHIP_EDITOR_PASSWORD。
 * - 未设置任何口令时：不启用保护（与旧行为一致）。
 * - 已设置口令：访问 GET /admin 或 GET /editor 时若无有效 Cookie，302 到 GET /login?next=...&role=...
 * - 用户在 login.html 提交表单 → POST /login（application/x-www-form-urlencoded），服务端比对口令后
 *   设置 HttpOnly Cookie（与 API 共用同一套签名令牌 worship_admin / worship_editor），再 302 回 next。
 * - 会话无服务端 session 存储：状态仅在 Cookie 中（HMAC 签名 + 过期时间），不引入数据库。
 * - GET /view 及 /api/state 等不经过页面门禁；会众端不受影响。
 *
 * --- 环境变量文件 ---
 * - 项目根目录 `.env`（可复制 `.env.example`）；由 dotenv 在启动时加载，不提交口令到仓库。
 * - 仍可直接使用系统环境变量或命令行导出，优先级以运行环境为准。
 * - `PUBLIC_VIEW_URL`：会众端完整 URL（供管理端「分享」生成二维码），例如 `https://聚会投影机局域网IP:端口/view`。
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3002;
const ROOT = __dirname;
const ITEMS_PATH = path.join(ROOT, "data", "items.json");
/** 编辑器默认读写的草稿路径（点号文件名，与 items.json 并列） */
const ITEMS_DRAFT_PATH = path.join(ROOT, "data", "items.draft.json");
/** 旧版草稿文件名；若存在且新路径不存在，启动时复制一次，避免升级丢草稿 */
const LEGACY_ITEMS_DRAFT_PATH = path.join(ROOT, "data", "items-draft.json");
const STATE_PATH = path.join(ROOT, "data", "state.json");
const CATALOG_META_PATH = path.join(ROOT, "data", "catalog-meta.json");
const BACKUPS_DIR = path.join(ROOT, "data", "backups");
const PUBLIC_DIR = path.join(ROOT, "public");
/** 编辑器上传图片落盘目录，对应 URL 前缀 `/media/...` */
const MEDIA_DIR = path.join(PUBLIC_DIR, "media");

/** 上传允许的 MIME → 文件后缀 */
const UPLOAD_IMAGE_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

function ensureMediaDir() {
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  } catch (e) {
    console.error("无法创建 public/media 目录:", e);
  }
}

ensureMediaDir();

const uploadImageStorage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, MEDIA_DIR);
  },
  filename: function (_req, file, cb) {
    const ext = UPLOAD_IMAGE_MIME[file.mimetype] || ".img";
    const name = Date.now() + "-" + crypto.randomBytes(4).toString("hex") + ext;
    cb(null, name);
  },
});

const uploadImage = multer({
  storage: uploadImageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function (_req, file, cb) {
    if (UPLOAD_IMAGE_MIME[file.mimetype]) {
      cb(null, true);
      return;
    }
    cb(new Error("仅支持 JPEG、PNG、GIF、WebP 图片"));
  },
});

/** 旧版仅 items 数组时，外包的默认场景 id */
const DEFAULT_LEGACY_SCENE_ID = "default";

/** HMAC 签名用：未设置时用固定占位（仅用于开发；生产请设 WORSHIP_AUTH_SECRET） */
const AUTH_SECRET =
  process.env.WORSHIP_AUTH_SECRET || "worship-dev-auth-secret-change-me";

const COOKIE_ADMIN = "worship_admin";
const COOKIE_EDITOR = "worship_editor";

const app = express();
app.use(express.json({ limit: "2mb" }));
/** POST /login 表单使用 */
app.use(express.urlencoded({ extended: false }));

/** @type {{ scenes: Array<{ id: string, name: string, items: Array<{ id: string, type: string, [key: string]: unknown }> }> }} */
let catalog = { scenes: [] };
/** 内存中的草稿目录，与 items.draft.json 同步 */
let draftCatalog = { scenes: [] };
let currentId = "blank";
/** 当前场景 id，与 state.json 同步 */
let currentSceneId = DEFAULT_LEGACY_SCENE_ID;
let itemsRevision = 1;
let itemsUpdatedAt = new Date().toISOString();
let stateVersion = 1;
let stateUpdatedAt = new Date().toISOString();

// ---------- 轻量访问保护（可选 env） ----------

function getAdminPassword() {
  const a = process.env.ADMIN_PASSWORD;
  const b = process.env.WORSHIP_ADMIN_PASSWORD;
  if (a != null && String(a).length) {
    return String(a);
  }
  if (b != null && String(b).length) {
    return String(b);
  }
  return "";
}

function getEditorPassword() {
  const e = process.env.EDITOR_PASSWORD;
  const w = process.env.WORSHIP_EDITOR_PASSWORD;
  if (e != null && String(e).length) {
    return String(e);
  }
  if (w != null && String(w).length) {
    return String(w);
  }
  return getAdminPassword();
}

function adminAuthEnabled() {
  return !!getAdminPassword();
}

function editorAuthEnabled() {
  return !!getEditorPassword();
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header || typeof header !== "string") {
    return {};
  }
  /** @type {Record<string, string>} */
  const out = {};
  header.split(";").forEach(function (part) {
    const idx = part.indexOf("=");
    if (idx < 0) {
      return;
    }
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    if (k) {
      out[k] = v;
    }
  });
  return out;
}

function signAuthToken(role) {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const inner = role + ":" + exp;
  const h = crypto.createHmac("sha256", AUTH_SECRET).update(inner).digest("hex");
  return Buffer.from(inner + "|" + h).toString("base64url");
}

function verifyAuthToken(role, token) {
  if (!token || typeof token !== "string") {
    return false;
  }
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const pipe = raw.lastIndexOf("|");
    if (pipe < 0) {
      return false;
    }
    const inner = raw.slice(0, pipe);
    const h = raw.slice(pipe + 1);
    const colon = inner.indexOf(":");
    if (colon < 0) {
      return false;
    }
    const r = inner.slice(0, colon);
    const exp = parseInt(inner.slice(colon + 1), 10);
    if (r !== role || !Number.isFinite(exp) || Date.now() > exp) {
      return false;
    }
    const expect = crypto.createHmac("sha256", AUTH_SECRET).update(inner).digest("hex");
    const a = Buffer.from(h, "hex");
    const b = Buffer.from(expect, "hex");
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function isAdminAuthenticated(req) {
  return verifyAuthToken("admin", parseCookies(req)[COOKIE_ADMIN]);
}

function isEditorAuthenticated(req) {
  return verifyAuthToken("editor", parseCookies(req)[COOKIE_EDITOR]);
}

function requireAdminApi(req, res, next) {
  if (!adminAuthEnabled()) {
    next();
    return;
  }
  if (isAdminAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized", needAuth: true, role: "admin" });
}

function requireEditorApi(req, res, next) {
  if (!editorAuthEnabled()) {
    next();
    return;
  }
  if (isEditorAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized", needAuth: true, role: "editor" });
}

function setAuthCookie(res, role, cookieName) {
  const token = signAuthToken(role);
  const maxAge = 7 * 24 * 60 * 60;
  const parts = [
    cookieName + "=" + encodeURIComponent(token),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + maxAge,
  ];
  res.append("Set-Cookie", parts.join("; "));
}

function clearAuthCookie(res, cookieName) {
  res.append(
    "Set-Cookie",
    cookieName + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
}

/**
 * 登录成功后的跳转路径：仅允许本站相对路径，防止开放重定向。
 */
function safeRedirectPath(p) {
  if (typeof p !== "string") {
    return "/admin";
  }
  const t = p.trim();
  if (!t.startsWith("/") || t.startsWith("//")) {
    return "/admin";
  }
  return t;
}

/** 管理端「分享」二维码指向的会众端地址（完整 URL，由 .env 的 PUBLIC_VIEW_URL 配置） */
function getPublicViewUrl() {
  const raw = process.env.PUBLIC_VIEW_URL;
  if (raw == null || !String(raw).trim()) {
    return "";
  }
  return String(raw).trim();
}

// ---------- 目录：scenes 与旧版迁移 ----------

/**
 * 迁移：旧版根级 items.json 仅含 { items: [...] } 时，自动升级为单场景目录。
 * - 生成一个 scene：id = default（DEFAULT_LEGACY_SCENE_ID），name =「默认」
 * - 原 items 数组原样放入该 scene 的 items（条目 id 仅在 scene 内唯一即可）
 * - 读入时即迁移；写入文件由「保存草稿 / 发布」落盘为新结构
 */
function migrateLegacyCatalog(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { scenes: [{ id: DEFAULT_LEGACY_SCENE_ID, name: "默认", items: [] }] };
  }
  if (Array.isArray(raw.scenes) && raw.scenes.length > 0) {
    return JSON.parse(JSON.stringify(raw));
  }
  if (Array.isArray(raw.items)) {
    return {
      scenes: [
        {
          id: DEFAULT_LEGACY_SCENE_ID,
          name: "默认",
          items: JSON.parse(JSON.stringify(raw.items)),
        },
      ],
    };
  }
  return { scenes: [{ id: DEFAULT_LEGACY_SCENE_ID, name: "默认", items: [] }] };
}

function getSceneById(cat, id) {
  if (!cat || !Array.isArray(cat.scenes)) {
    return null;
  }
  return cat.scenes.find(function (s) {
    return s && s.id === id;
  }) || null;
}

/**
 * 当前「线上」激活场景：仅允许用 currentSceneId 在 catalog 中解析，不向其它 scene 回退。
 * 所有条目 / nextItem 均基于该场景的 items（即 currentScene.items）。
 */
function getCurrentSceneRecord() {
  return getSceneById(catalog, currentSceneId);
}

function getCurrentSceneItems() {
  const sc = getCurrentSceneRecord();
  if (!sc || !Array.isArray(sc.items)) {
    return [];
  }
  return sc.items;
}

function getItemByIdInScene(scene, id) {
  if (!scene || !Array.isArray(scene.items)) {
    return undefined;
  }
  return scene.items.find(function (i) {
    return i && i.id === id;
  });
}

function loadCatalogMeta() {
  try {
    if (fs.existsSync(CATALOG_META_PATH)) {
      const raw = fs.readFileSync(CATALOG_META_PATH, "utf8");
      const o = JSON.parse(raw);
      if (o && typeof o.revision === "number" && o.revision >= 1) {
        itemsRevision = Math.floor(o.revision);
      }
      if (o && typeof o.updatedAt === "string" && o.updatedAt.trim()) {
        itemsUpdatedAt = o.updatedAt.trim();
      }
      return;
    }
  } catch (e) {
    console.warn("catalog-meta.json load failed:", e);
  }
  try {
    const st = fs.statSync(ITEMS_PATH);
    itemsUpdatedAt = st.mtime.toISOString();
  } catch (e) {
    itemsUpdatedAt = new Date().toISOString();
  }
  saveCatalogMeta();
}

function saveCatalogMeta() {
  const out =
    JSON.stringify({ revision: itemsRevision, updatedAt: itemsUpdatedAt }, null, 2) + "\n";
  fs.writeFileSync(CATALOG_META_PATH, out, "utf8");
}

/** 启动时用 catalog revision 对齐 state 时间戳（随后 loadPersistedState 可覆盖 stateVersion） */
function syncStateVersionFromCatalog() {
  stateVersion = itemsRevision;
  stateUpdatedAt = itemsUpdatedAt;
}

/** nextItem 仅基于当前 scene 的 items 顺序，与旧场景无关 */
function getNextItemMinimal(activeId) {
  const items = getCurrentSceneItems();
  const idx = items.findIndex(function (i) {
    return i && i.id === activeId;
  });
  if (idx < 0 || idx >= items.length - 1) {
    return null;
  }
  const next = items[idx + 1];
  if (!next || typeof next !== "object") {
    return null;
  }
  const id = typeof next.id === "string" ? next.id : "";
  const type = typeof next.type === "string" ? next.type : "";
  const o = { id: id, type: type };
  if (type === "image") {
    const src =
      next.src != null && String(next.src).trim()
        ? String(next.src).trim()
        : next.image != null && String(next.image).trim()
          ? String(next.image).trim()
          : "";
    if (src) {
      o.src = src;
    }
    if (next.image != null && String(next.image).trim()) {
      o.image = String(next.image).trim();
    }
  }
  return o;
}

function loadPersistedState() {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      return;
    }
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const o = JSON.parse(raw);
    if (o === null || typeof o !== "object" || Array.isArray(o)) {
      console.warn("state.json: root must be an object, using defaults");
      return;
    }
    if (typeof o.sceneId === "string" && o.sceneId.trim()) {
      currentSceneId = o.sceneId.trim();
    }
    if (typeof o.activeId === "string" && o.activeId.trim()) {
      currentId = o.activeId.trim();
    }
    if (typeof o.stateVersion === "number" && o.stateVersion >= 1 && Number.isFinite(o.stateVersion)) {
      stateVersion = Math.floor(o.stateVersion);
    }
    if (typeof o.updatedAt === "string" && o.updatedAt.trim()) {
      stateUpdatedAt = o.updatedAt.trim();
    }
  } catch (e) {
    console.warn("state.json load failed, using defaults:", e instanceof Error ? e.message : e);
    currentId = "blank";
    currentSceneId = DEFAULT_LEGACY_SCENE_ID;
  }
}

function persistState() {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload = {
      sceneId: currentSceneId,
      activeId: currentId,
      updatedAt: stateUpdatedAt,
      stateVersion: stateVersion,
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  } catch (e) {
    console.error("state.json write failed:", e);
  }
}

/**
 * 启动时：sceneId 不存在则落到第一个 scene；activeId 不在当前 scene 的 items 则回退 blank（或该 scene 首项）。
 */
function reconcileSceneAndActive() {
  if (!catalog.scenes || catalog.scenes.length === 0) {
    return;
  }
  if (!getSceneById(catalog, currentSceneId)) {
    currentSceneId = catalog.scenes[0].id;
  }
  const sc = getSceneById(catalog, currentSceneId);
  if (!sc) {
    return;
  }
  if (!getItemByIdInScene(sc, currentId)) {
    currentId = pickDefaultActiveIdForScene(sc);
  }
  persistState();
}

function pickDefaultActiveIdForScene(sc) {
  if (!sc || !Array.isArray(sc.items)) {
    return "blank";
  }
  if (getItemByIdInScene(sc, "blank")) {
    return "blank";
  }
  const first = sc.items[0];
  return first && typeof first.id === "string" && first.id.trim() ? first.id.trim() : "blank";
}

function formatItemsBackupStamp() {
  const d = new Date();
  const p = function (n) {
    return String(n).padStart(2, "0");
  };
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "-" +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

function ensureBackupsDir() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
}

function backupCurrentItemsFileIfExists() {
  if (!fs.existsSync(ITEMS_PATH)) {
    return;
  }
  ensureBackupsDir();
  const name = "items.backup." + formatItemsBackupStamp() + ".json";
  const dest = path.join(BACKUPS_DIR, name);
  fs.copyFileSync(ITEMS_PATH, dest);
}

function writeItemsJsonAtomic(filePath, catalogObj) {
  const dataDir = path.dirname(filePath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const content = JSON.stringify(catalogObj, null, 2) + "\n";
  const tmpPath = path.join(
    dataDir,
    path.basename(filePath) + "." + process.pid + "." + Date.now() + ".tmp"
  );

  try {
    fs.writeFileSync(tmpPath, content, "utf8");
  } catch (e) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {
      /* ignore */
    }
    throw e;
  }

  try {
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {
      /* ignore */
    }
    throw e;
  }
}

function loadItems() {
  const raw = fs.readFileSync(ITEMS_PATH, "utf8");
  const parsed = JSON.parse(raw);
  catalog = migrateLegacyCatalog(parsed);
}

/**
 * 若尚无 items.draft.json：优先从旧名 items-draft.json 复制；否则从正式 items 复制。
 * 保证首次进入编辑器即有可编辑草稿，且不破坏原有 items.json。
 */
function ensureDraftFileFromPublished() {
  try {
    if (!fs.existsSync(ITEMS_DRAFT_PATH) && fs.existsSync(LEGACY_ITEMS_DRAFT_PATH)) {
      fs.copyFileSync(LEGACY_ITEMS_DRAFT_PATH, ITEMS_DRAFT_PATH);
    }
  } catch (e) {
    console.warn("legacy items-draft.json migration copy failed:", e);
  }

  try {
    if (fs.existsSync(ITEMS_DRAFT_PATH)) {
      const raw = fs.readFileSync(ITEMS_DRAFT_PATH, "utf8");
      const o = JSON.parse(raw);
      const migrated = migrateLegacyCatalog(o);
      if (migrated.scenes && migrated.scenes.length) {
        draftCatalog = migrated;
        return;
      }
    }
  } catch (e) {
    console.warn("items.draft.json load failed, seeding from published:", e);
  }
  draftCatalog = JSON.parse(JSON.stringify(catalog));
  try {
    writeItemsJsonAtomic(ITEMS_DRAFT_PATH, draftCatalog);
  } catch (e) {
    console.error("items.draft.json initial write failed:", e);
  }
}

function writeDraftFile(catalogObj) {
  writeItemsJsonAtomic(ITEMS_DRAFT_PATH, catalogObj);
  draftCatalog = catalogObj;
}

function getItemById(id) {
  return getItemByIdInScene(getCurrentSceneRecord(), id);
}

function getBlankItem() {
  const sc = getCurrentSceneRecord();
  const b = sc && getItemByIdInScene(sc, "blank");
  if (b) {
    return b;
  }
  return {
    id: "blank",
    type: "blank",
    label: "空白",
  };
}

function normalizeItemsArray(items) {
  return items.map(function (it) {
    const o = { ...it };
    if (o.type === "notice") {
      if ((!o.body || !String(o.body).trim()) && o.text != null) {
        o.body = String(o.text);
      }
      delete o.text;
    }
    if (o.type === "image") {
      if ((!o.src || !String(o.src).trim()) && o.image != null) {
        o.src = String(o.image);
      }
      delete o.image;
    }
    return o;
  });
}

function normalizeCatalogForSave(data) {
  const scenes = (data.scenes || []).map(function (sc) {
    return {
      id: String(sc.id || "").trim(),
      name: sc.name != null ? String(sc.name).trim() : "",
      items: normalizeItemsArray(sc.items || []),
    };
  });
  return { scenes: scenes };
}

/**
 * 校验单个 scene 的 items 数组（规则与旧版全目录 items 一致）。
 */
function validateSceneItems(rawItems, sceneLabel) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, error: sceneLabel + "：items 必须是非空数组" };
  }
  const normalized = normalizeItemsArray(rawItems);
  const items = normalized;
  const allowedTypes = new Set(["blank", "notice", "text", "image"]);
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it === null || typeof it !== "object" || Array.isArray(it)) {
      return { ok: false, error: sceneLabel + "：第 " + (i + 1) + " 项不是对象" };
    }
    const id = /** @type {{ id?: unknown }} */ (it).id;
    const type = /** @type {{ type?: unknown }} */ (it).type;
    if (typeof id !== "string" || !id.trim()) {
      return { ok: false, error: sceneLabel + "：第 " + (i + 1) + " 项缺少有效 id" };
    }
    if (typeof type !== "string" || !type.trim()) {
      return { ok: false, error: sceneLabel + "：第 " + (i + 1) + " 项缺少有效 type" };
    }
    const t = type.trim();
    if (!allowedTypes.has(t)) {
      return {
        ok: false,
        error:
          sceneLabel +
          "：第 " +
          (i + 1) +
          " 项（id: " +
          id +
          "）：type 必须是 blank / notice / text / image 之一",
      };
    }
    if (seen.has(id)) {
      return { ok: false, error: sceneLabel + "：本 scene 内 item id 重复: " + id };
    }
    seen.add(id);
    const body = /** @type {{ body?: unknown }} */ (it).body;
    const src = /** @type {{ src?: unknown }} */ (it).src;
    if (t === "text") {
      if (typeof body !== "string" || !body.trim()) {
        return {
          ok: false,
          error: sceneLabel + "：第 " + (i + 1) + " 项（id: " + id + "）：text 类型需要非空 body",
        };
      }
    }
    if (t === "notice") {
      if (typeof body !== "string" || !body.trim()) {
        return {
          ok: false,
          error: sceneLabel + "：第 " + (i + 1) + " 项（id: " + id + "）：notice 类型需要非空 body",
        };
      }
    }
    if (t === "image") {
      if (typeof src !== "string" || !src.trim()) {
        return {
          ok: false,
          error: sceneLabel + "：第 " + (i + 1) + " 项（id: " + id + "）：image 类型需要非空 src",
        };
      }
    }
  }
  const blank = items.find(function (x) {
    return x && typeof x === "object" && /** @type {{ id?: string }} */ (x).id === "blank";
  });
  if (!blank) {
    return {
      ok: false,
      error: sceneLabel + "：必须保留一条 id 为 \"blank\" 的空白项（供「一键空白页」使用）",
    };
  }
  if (/** @type {{ type?: string }} */ (blank).type !== "blank") {
    return { ok: false, error: sceneLabel + "：id 为 blank 的项 type 应为 \"blank\"" };
  }
  return { ok: true, items: items };
}

function validateCatalog(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "根对象必须是 { \"scenes\": [...] }" };
  }
  let payload = data;
  if (!Array.isArray(data.scenes) && Array.isArray(data.items)) {
    payload = migrateLegacyCatalog(data);
  }
  const scenes = payload.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return { ok: false, error: "scenes 必须是非空数组" };
  }
  const sceneIds = new Set();
  const outScenes = [];
  for (let si = 0; si < scenes.length; si++) {
    const sc = scenes[si];
    if (sc === null || typeof sc !== "object" || Array.isArray(sc)) {
      return { ok: false, error: "第 " + (si + 1) + " 个 scene 不是对象" };
    }
    const sid = typeof sc.id === "string" ? sc.id.trim() : "";
    if (!sid) {
      return { ok: false, error: "第 " + (si + 1) + " 个 scene 缺少有效 id" };
    }
    if (sceneIds.has(sid)) {
      return { ok: false, error: "scene id 重复: " + sid };
    }
    sceneIds.add(sid);
    const name = sc.name != null ? String(sc.name).trim() : "";
    const vi = validateSceneItems(sc.items, "场景 \"" + sid + "\"");
    if (!vi.ok) {
      return { ok: false, error: vi.error };
    }
    outScenes.push({ id: sid, name: name, items: vi.items });
  }
  return { ok: true, catalog: { scenes: outScenes } };
}

/**
 * 发布正式目录：先备份现有 items.json，再原子写入；并递增 itemsRevision 与 stateVersion。
 * stateVersion 递增场景：切换 item（POST /api/state）、切换 scene（POST /api/scene）、发布（本函数）。
 */
function writeItemsFile(catalogObj) {
  backupCurrentItemsFileIfExists();
  writeItemsJsonAtomic(ITEMS_PATH, catalogObj);
  itemsRevision += 1;
  itemsUpdatedAt = new Date().toISOString();
  saveCatalogMeta();
  stateVersion += 1;
  stateUpdatedAt = new Date().toISOString();
  persistState();
}

/** 草稿与正式是否一致（归一化后比较 JSON，供编辑端显示「未发布 / 已同步」） */
function draftMatchesPublished() {
  try {
    const d = normalizeCatalogForSave(draftCatalog);
    const p = normalizeCatalogForSave(catalog);
    return JSON.stringify(d) === JSON.stringify(p);
  } catch {
    return false;
  }
}

/** 发布后令草稿文件与线上一致，避免「已发布」仍显示未同步 */
function syncDraftFileWithPublished(publishedCatalog) {
  draftCatalog = JSON.parse(JSON.stringify(publishedCatalog));
  try {
    writeItemsJsonAtomic(ITEMS_DRAFT_PATH, draftCatalog);
  } catch (e) {
    console.error("items.draft.json sync after publish failed:", e);
  }
}

function jsonDraftPayloadExtra() {
  return {
    publishedRevision: itemsRevision,
    publishedUpdatedAt: itemsUpdatedAt,
    draftMatchesPublished: draftMatchesPublished(),
  };
}

loadItems();
loadCatalogMeta();
syncStateVersionFromCatalog();
ensureDraftFileFromPublished();
loadPersistedState();
reconcileSceneAndActive();

// --- API：认证 ---

app.get("/api/auth/status", (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json({
    needAdmin: adminAuthEnabled(),
    needEditor: editorAuthEnabled(),
    admin: isAdminAuthenticated(req),
    editor: isEditorAuthenticated(req),
  });
});

app.post("/api/auth/login", (req, res) => {
  const body = req.body || {};
  const role = body.role;
  const password = body.password != null ? String(body.password) : "";
  if (role !== "admin" && role !== "editor") {
    res.status(400).json({ error: "role must be \"admin\" or \"editor\"" });
    return;
  }
  if (role === "admin") {
    if (!adminAuthEnabled()) {
      res.json({ ok: true, skipped: true });
      return;
    }
    if (password !== getAdminPassword()) {
      res.status(401).json({ error: "Invalid password" });
      return;
    }
    setAuthCookie(res, "admin", COOKIE_ADMIN);
    res.json({ ok: true });
    return;
  }
  if (!editorAuthEnabled()) {
    res.json({ ok: true, skipped: true });
    return;
  }
  if (password !== getEditorPassword()) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }
  setAuthCookie(res, "editor", COOKIE_EDITOR);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  const body = req.body || {};
  const role = body.role;
  if (role === "admin") {
    clearAuthCookie(res, COOKIE_ADMIN);
  } else if (role === "editor") {
    clearAuthCookie(res, COOKIE_EDITOR);
  } else {
    res.status(400).json({ error: "role must be \"admin\" or \"editor\"" });
    return;
  }
  res.json({ ok: true });
});

/**
 * GET /login：简单登录页（口令仅由 POST /login 提交，不写在前端）。
 */
app.get("/login", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "login.html"));
});

/**
 * POST /login：校验口令 → 设置 HttpOnly Cookie → 302 至 next（失败则回登录页并带 error=1，不跳转 /view）。
 */
app.post("/login", (req, res) => {
  const password = req.body && req.body.password != null ? String(req.body.password) : "";
  const next = safeRedirectPath(req.body && req.body.next != null ? String(req.body.next) : "/admin");
  const role = req.body && req.body.role === "editor" ? "editor" : "admin";

  const failRedirect =
    "/login?" +
    new URLSearchParams({
      next: next,
      role: role,
      error: "1",
    }).toString();

  if (role === "admin") {
    if (!adminAuthEnabled()) {
      res.redirect(302, next);
      return;
    }
    if (password !== getAdminPassword()) {
      res.redirect(302, failRedirect);
      return;
    }
    setAuthCookie(res, "admin", COOKIE_ADMIN);
    res.redirect(302, next);
    return;
  }

  if (!editorAuthEnabled()) {
    res.redirect(302, next);
    return;
  }
  if (password !== getEditorPassword()) {
    res.redirect(302, failRedirect);
    return;
  }
  setAuthCookie(res, "editor", COOKIE_EDITOR);
  res.redirect(302, next);
});

/**
 * GET /api/share/view-url：返回配置的会众端分享链接（需控制端登录）。
 * 未配置 PUBLIC_VIEW_URL 时 url 为空字符串，configured 为 false。
 */
app.get("/api/share/view-url", requireAdminApi, (req, res) => {
  const url = getPublicViewUrl();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json({
    url: url,
    configured: !!url,
  });
});

/**
 * GET /api/share/qrcode.png：为 PUBLIC_VIEW_URL 生成 PNG 二维码（需控制端登录）。
 */
app.get("/api/share/qrcode.png", requireAdminApi, async (req, res) => {
  const url = getPublicViewUrl();
  if (!url) {
    res.status(503);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json({ error: "未配置 PUBLIC_VIEW_URL" });
    return;
  }
  try {
    const buf = await QRCode.toBuffer(url, {
      type: "png",
      width: 280,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json({ error: "二维码生成失败: " + msg });
  }
});

/** GET /api/items/draft：草稿目录（编辑端），含全部 scenes */
app.get("/api/items/draft", requireEditorApi, (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json({
    scenes: draftCatalog.scenes,
    ...jsonDraftPayloadExtra(),
  });
});

/**
 * PUT /api/items：仅保存草稿到 items.draft.json，不修改正式 items.json。
 */
app.put("/api/items", requireEditorApi, (req, res) => {
  const checked = validateCatalog(req.body);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  try {
    writeDraftFile(checked.catalog);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json({
      ok: true,
      scenes: draftCatalog.scenes,
      ...jsonDraftPayloadExtra(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "草稿保存失败: " + msg });
  }
});

/**
 * POST /api/items/publish：校验草稿 → 备份并覆盖 items.json → 更新 itemsRevision / stateVersion → 同步草稿文件与线上一致。
 */
app.post("/api/items/publish", requireEditorApi, (req, res) => {
  const checked = validateCatalog(draftCatalog);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error || "草稿校验失败" });
    return;
  }
  try {
    catalog = checked.catalog;
    reconcileSceneAndActive();
    writeItemsFile(catalog);
    syncDraftFileWithPublished(catalog);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json({
      ok: true,
      scenes: catalog.scenes,
      revision: itemsRevision,
      updatedAt: itemsUpdatedAt,
      stateVersion: stateVersion,
      draftMatchesPublished: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "发布失败: " + msg });
  }
});

/**
 * POST /api/editor/upload-media：上传图片到 public/media，返回可写入 item.src 的 URL（/media/文件名）。
 * multipart 字段名：file。需编辑端会话（与 PUT /api/items 相同）。
 */
app.post(
  "/api/editor/upload-media",
  requireEditorApi,
  function (req, res, next) {
    uploadImage.single("file")(req, res, function (err) {
      if (err) {
        var msg =
          err instanceof multer.MulterError
            ? err.code === "LIMIT_FILE_SIZE"
              ? "文件大小不能超过 10MB"
              : String(err.message || err)
            : String(err.message || err);
        res.status(400).json({ error: msg });
        return;
      }
      next();
    });
  },
  function (req, res) {
    if (!req.file) {
      res.status(400).json({ error: "请选择图片文件" });
      return;
    }
    var url = "/media/" + req.file.filename;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json({ ok: true, url: url, filename: req.file.filename });
  }
);

/** GET /api/scenes：当前已发布目录中的场景列表（id + name） */
app.get("/api/scenes", requireAdminApi, (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json({
    scenes: catalog.scenes.map(function (s) {
      return { id: s.id, name: s.name || "" };
    }),
  });
});

/**
 * POST /api/scene：切换当前场景；重置 activeId（blank 或首项）；递增 stateVersion。
 */
app.post("/api/scene", requireAdminApi, (req, res) => {
  const body = req.body || {};
  const sceneId = typeof body.sceneId === "string" ? body.sceneId.trim() : "";
  if (!sceneId) {
    res.status(400).json({ error: "Body must be JSON: { \"sceneId\": \"...\" }" });
    return;
  }
  const sc = getSceneById(catalog, sceneId);
  if (!sc) {
    res.status(400).json({ error: "Unknown sceneId: " + sceneId });
    return;
  }
  // 切换 scene：不保留上一场景的 activeId，始终按当前 scene 重置为 blank（若存在）否则首项
  currentSceneId = sceneId;
  currentId = pickDefaultActiveIdForScene(sc);
  stateVersion += 1;
  stateUpdatedAt = new Date().toISOString();
  persistState();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json(buildStatePayload());
});

/** GET /api/items：正式目录中「当前场景」的 items（必须在 put/post 子路径之后定义无歧义） */
app.get("/api/items", requireAdminApi, (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json({
    sceneId: currentSceneId,
    items: getCurrentSceneItems().slice(),
    revision: itemsRevision,
    updatedAt: itemsUpdatedAt,
  });
});

function buildStatePayload() {
  let item = getItemById(currentId);
  let activeId = currentId;
  if (!item) {
    item = getBlankItem();
    activeId = item.id || "blank";
  }
  return {
    sceneId: currentSceneId,
    activeId: activeId,
    item: item,
    stateVersion: stateVersion,
    updatedAt: stateUpdatedAt,
    nextItem: getNextItemMinimal(activeId),
    itemsRevision: itemsRevision,
  };
}

app.get("/api/state", (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json(buildStatePayload());
});

app.post("/api/state", (req, res) => {
  const id = req.body && req.body.id;
  if (typeof id !== "string" || !id.trim()) {
    res.status(400).json({ error: "Body must be JSON: { \"id\": \"...\" }" });
    return;
  }
  const found = getItemById(id);
  if (!found) {
    res.status(400).json({ error: "Unknown id: " + id });
    return;
  }
  currentId = id;
  // 切换当前 scene 内激活条目：stateVersion 递增
  stateVersion += 1;
  stateUpdatedAt = new Date().toISOString();
  persistState();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json(buildStatePayload());
});

app.get("/view", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "view.html"));
});

app.get("/admin", (req, res) => {
  if (adminAuthEnabled() && !isAdminAuthenticated(req)) {
    res.redirect(
      302,
      "/login?" +
        new URLSearchParams({
          next: "/admin",
          role: "admin",
        }).toString()
    );
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.get("/editor", (req, res) => {
  if (editorAuthEnabled() && !isEditorAuthenticated(req)) {
    res.redirect(
      302,
      "/login?" +
        new URLSearchParams({
          next: "/editor",
          role: "editor",
        }).toString()
    );
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, "editor.html"));
});

app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  console.log("Server listening on http://localhost:" + PORT);
  console.log("  View:   /view");
  console.log("  Admin:  /admin  (optional ADMIN_PASSWORD → /login)");
  console.log("  Editor: /editor (optional EDITOR_PASSWORD or same as admin)");
  console.log("  Login:  /login");
});
