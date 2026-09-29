# 华域地图中文运维手册

## 1. 当前架构

- 网站与 Worker：Cloudflare Pages 项目 `ogf-atlas`。
- 生产域名：`https://ogf-atlas.pages.dev`。
- 生产目录：仓库中的 `site/`。
- 建筑：Pages Worker 按 `z11-z15` 查询 OGF Overpass，Cloudflare 与已打开视图稳定缓存三小时。约 500 米使用 `z14`、约 300 米使用 `z15`，避免密集城区大分片阻塞。中心分片先到先显示，完整覆盖前保留发布建筑兜底。
- 华域底图：OGF 官方 OpenMapTiles 提供稳定基线；近距离补绘层按 `z13-z15` 查询当前 OGF。`z13-z14` 为三小时快照，`z15` 边缘数据约两分钟更新，但浏览器中完整加载的当前视图稳定保留三小时并整批替换。
- 全国交通与导航：`site/` 内的预生成 JSON 快照，可用仓库自带的跨平台命令统一手动更新。
- 数据审计：GitHub Actions 每天检查交通、铁路、站口和机场快照年龄，并探测实时底图 Overpass 查询；超过 14 天或接口失败时工作流告警。

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
npm run check:data
pwsh ./scripts/create-release.ps1
npm run archive:project
```

`create-release.ps1` 只保存可部署的 `site/`；`archive:project` 保存整个维护项目，并默认写到项目外的 `work/` 目录。两种存档都拒绝覆盖同名版本。整项目包排除 Git 内部数据库、密钥、依赖缓存和临时报告，并在根目录生成 `SHA256.txt`。

确认新的发布存档存在后再提交 Git：

```powershell
git add .
git commit -m "说明本次变化"
git push origin main
```

推送后 GitHub Actions 会先核对全部 SHA-256、JavaScript 语法和 Worker 接口。两个 Cloudflare Secrets 齐全时才部署并检查主域名、建筑 API 与实时底图 API；凭据缺失时部署任务会明确警告并跳过，不会制造一次伪失败，也不会改动当前生产站点。

### 本地开发服务器

需要验证建筑或实时底图接口时，在项目根目录运行：

```powershell
npm run dev -- 45126
```

然后访问 `http://127.0.0.1:45126/`。该服务器同时提供 `site/` 静态文件和 `_worker.js` 中的 `/api/buildings/`、`/api/live-basemap/` 接口，行为比直接双击 `site/index.html` 更接近 Cloudflare Pages。停止服务时在终端按 `Ctrl+C`。

本地发版前建议依次运行：

```powershell
npm run test:worker
npm run check:data
npm run probe:live
npm run verify
```

## 4. 手动部署

进入 GitHub 仓库的 `Actions -> Deploy production -> Run workflow`。不需要本地安装 Wrangler，也不需要 Codex。

## 5. 每日巡检

`Production health check` 每天自动执行一次，检查：

- 主域名返回目标版本。
- `app.js` 的建筑缩放门槛正确。
- Cloudflare Worker 的 `z11` 建筑接口可读取 OGF 要素。
- Cloudflare Worker 的实时底图探测分片可读取道路或土地利用要素。

GitHub 会对失败的工作流发送通知。也可以在 Actions 页面随时手动运行。

`Data freshness audit` 每天自动检查六份静态数据的 `generatedAt`，并上传 `data-freshness-report.json` 作为保留 14 天的 Actions 产物。这个流程负责发现过期，不会伪造或覆盖交通快照。

## 6. 统一手动更新全部数据

安装 Node.js 20 或更高版本后，在项目根目录运行：

```powershell
npm run data:update:check
npm run data:update:dry
npm run data:update
npm run data:update:resume
```

- `data:update:check` 不联网、不修改 `site/`，只检查当前六份静态数据。
- `data:update:dry` 联网完整生成候选包并运行安全校验，但不替换生产文件。
- `data:update` 生成候选包，通过全部校验后备份并原子替换六份数据，再更新 SHA-256 清单和执行整包校验。
- `data:update:resume` 只在最近一次构建失败后使用，复用同一次运行中已成功的全国分块并继续；如果 `site/` 基线已经改变则拒绝恢复。

该工具统一处理：

- `transit-preload.json`
- `transit-relations.json`
- `railway-routing.json`
- `railway-connections.json`
- `station-access.json`
- `airports.json`

`transit-services.json` 是人工确认的票价、换乘和运营规则，不会被自动生成器覆盖。建筑与近距底图由 Worker 按分片从当前 OGF 数据按需生成，也不需要复制成一份永久静态文件；完整更新过程会实际访问相同的 OGF/Overpass 数据源，因此也能发现源站不可用。

完整更新需要多次全国范围 Overpass 查询，通常需要数十分钟，具体时间取决于 OGF 服务负载。出现 HTTP 错误、Overpass `remark`、空响应、不完整几何或数据量异常下降时，脚本立即停止，`site/` 保持原样。候选、逐步日志和报告位于 `.data-update/runs/`；成功替换前的旧文件位于 `.data-update/backups/`。确认新数据后仍需人工执行 Git 提交、发布存档和 Cloudflare 部署，更新器本身不会上传或部署。

在没有 npm 的精简环境中，可直接运行：

```powershell
node scripts/update-all-data.mjs --check
node scripts/update-all-data.mjs --dry-run
node scripts/update-all-data.mjs
```

Windows 入口为 `update-data.cmd`；macOS/Linux 入口为 `sh update-data.sh`。所有路径相对仓库计算，不含设备专用路径，也不依赖 Codex、大模型、浏览器或 Playwright。

## 7. 回退

最快方法：进入 Cloudflare Dashboard 的 `Workers & Pages -> ogf-atlas -> Deployments`，选择上一个成功部署并执行回退。

源码回退：从 `releases/` 选择目标版本，将其中生产文件恢复到 `site/`，更新 `release.json` 和 SHA-256 清单，通过 `npm run verify` 后重新部署。任何现有发布存档都不得覆盖。

## 8. 数据更新时间

- 建筑与近距离底图首次进入新分片时读取当前 OGF 数据；同一已打开视图稳定保留三小时，避免停留期间反复重绘。
- 较远比例尺以及实时补绘未覆盖的要素仍等待 OGF 官方 Vector 更新。
- 实时补绘可以覆盖新增和修改的几何；官方瓦片中已删除的旧对象要等上游瓦片更新后才会彻底消失。
- 交通预载、导航图、铁路连接、车站接入和机场数据通过 `npm run data:update` 统一重新生成，确认后再提交。

不要把“网站自动部署”误认为“所有数据自动生成”。静态交通数据仍由维护者手动触发并审查；建筑和近距底图在访问时按需读取当前 OGF 数据。

## 9. 灾难恢复

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
