# 华域地图中文运维手册

## 1. 当前架构

- 网站与 Worker：Cloudflare Pages 项目 `ogf-atlas`。
- 生产域名：`https://ogf-atlas.pages.dev`。
- 生产目录：仓库中的 `site/`。
- 建筑：Pages Worker 查询 OGF Overpass，Cloudflare 与浏览器各缓存约 2 分钟。
- 华域底图：OGF 官方 OpenMapTiles 数据加华域样式，不由本仓库生成。
- 全国交通与导航：`site/` 内的预生成 JSON 快照，不会自动从 OGF 更新。

## 2. 首次建立 GitHub 仓库

维护电脑需要安装 Git 和 Node.js 20 或更高版本。先在自己的 GitHub 账号创建私有空仓库，不要勾选自动生成 README、`.gitignore` 或 License。然后在本项目根目录执行：

```powershell
git init -b main
git add .
git commit -m "Initialize OGF Atlas maintenance project"
git remote add origin https://github.com/<账号>/<仓库>.git
git push -u origin main
```

若 Git 提示没有身份，先按自己的 GitHub 资料配置：

```powershell
git config --global user.name "你的 GitHub 用户名"
git config --global user.email "你的 GitHub 邮箱"
```

推送后继续完成：

1. 默认分支确认是 `main`。
2. 按 `docs/SECRETS_ZH.md` 配置 `production` 环境和两个 Cloudflare Secrets。
3. 在 Actions 页面手动运行 `Production health check`。
4. 校验通过后再手动运行 `Deploy production`。

项目没有运行时 npm 依赖，不需要提交 `node_modules`。

## 3. 修改与发布

所有网站代码和数据修改只能进入 `site/`。修改完成后运行：

```powershell
npm run manifest:update
npm run verify
pwsh ./scripts/create-release.ps1
```

确认新的发布存档存在后再提交 Git：

```powershell
git add .
git commit -m "说明本次变化"
git push origin main
```

推送后 GitHub Actions 会先核对全部 SHA-256 和 JavaScript 语法，再部署 Cloudflare，最后访问主域名和建筑 API。任何一步失败都会阻止或标记发布失败。

## 4. 手动部署

进入 GitHub 仓库的 `Actions -> Deploy production -> Run workflow`。不需要本地安装 Wrangler，也不需要 Codex。

## 5. 每日巡检

`Production health check` 每天自动执行一次，检查：

- 主域名返回目标版本。
- `app.js` 的建筑缩放门槛正确。
- Cloudflare Worker 的 `z11` 建筑接口可读取 OGF 要素。

GitHub 会对失败的工作流发送通知。也可以在 Actions 页面随时手动运行。

## 6. 回退

最快方法：进入 Cloudflare Dashboard 的 `Workers & Pages -> ogf-atlas -> Deployments`，选择上一个成功部署并执行回退。

源码回退：从 `releases/` 选择目标版本，将其中生产文件恢复到 `site/`，更新 `release.json` 和 SHA-256 清单，通过 `npm run verify` 后重新部署。任何现有发布存档都不得覆盖。

## 7. 数据更新时间

- 建筑与部分补绘要素接近实时，但受 OGF Overpass 同步和缓存影响。
- 道路、水体、土地利用与普通地名等待 OGF 官方 Vector 更新。
- 交通预载、导航图和车站接入数据仍需重新生成后提交。

不要把“网站自动部署”误认为“所有数据自动生成”。在交通数据生成脚本和自建底图流水线完成前，这两部分仍属于人工发布内容。

## 8. 灾难恢复

至少保留三份：GitHub 私有仓库、Cloudflare 当前部署、本地或云盘发布存档。Cloudflare 部署不能替代源码仓库，个人电脑也不能作为唯一备份。

恢复顺序：克隆 GitHub 仓库，运行 `npm run verify`，确认 GitHub Secrets 有效，然后手动执行生产部署。若 GitHub 不可用，可从完整发布包恢复 `site/` 并使用 Cloudflare Dashboard 或 Wrangler 部署。

从新电脑恢复的完整命令是：

```powershell
git clone https://github.com/<账号>/<仓库>.git
cd <仓库>
npm run verify
npm run verify:online
```

这套流程只依赖 Git、Node.js、GitHub 和 Cloudflare，不依赖 Codex。即使不再使用 Codex，仍可通过普通编辑器修改 `site/`、运行校验、提交 Git，并由 GitHub Actions 发布。
