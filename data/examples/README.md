# 示例数据（参考）

本目录文件**仅供**克隆仓库后对照结构使用，**不会**被 Node 服务自动加载。默认运行仍使用项目根下 `data/items.json`、`data/state.json` 等（若不存在则由 `server.js` 初始化）。

## 文件说明

| 文件 | 说明 |
|------|------|
| `items.sample.json` | 多场景正式目录示例，结构与 `data/items.json` 一致：`{ "scenes": [ { id, name, items } ] }`。含 `blank` / `notice` / `text` / `image` 各一条（含第二场景）。 |
| `items.legacy.sample.json` | **旧版**仅 `{ "items": [...] }` 的示例；服务读入时会自动包一层默认 scene（见仓库根 `README.md`）。 |
| `state.sample.json` | 运行状态示例，结构与 `data/state.json` 一致：`sceneId`、`activeId`、`stateVersion`、`updatedAt`。 |
| `catalog-meta.sample.json` | 目录版本元数据示例，结构与 `data/catalog-meta.json` 一致。 |

## 图片路径

示例中的图片条目使用 **`/media/example.svg`**。仓库内已包含 **`public/media/example.svg`**（占位图），与示例 JSON 对应。

## 如何本地试用示例目录

1. **备份**当前 `data/items.json`（若有）。
2. 将 `items.sample.json` **复制**为 `data/items.json`（或先复制内容再保存）。
3. 按需将 `state.sample.json`、`catalog-meta.sample.json` 复制为 `data/state.json`、`data/catalog-meta.json`（若希望初始状态与示例一致；否则只换 `items.json` 也可，启动后服务端会按规则修正状态）。
4. 重启 `npm start`，用 **控制端 / 会众端** 查看。

更稳妥做法：只阅读 JSON 结构，在 **/editor** 中按界面重新录入。

## 校验规则摘要

- 每个 `scene` 的 `items` 内 **`id` 唯一**。
- 每个 scene **必须**包含一条 **`id` 为 `blank` 且 `type` 为 `blank`** 的项。
- `notice`、`text` 需非空 `body`；`image` 需非空 `src`（一般为 `/media/...` 路径）。

完整规则见 `server.js` 中 `validateCatalog` / `validateSceneItems`。
