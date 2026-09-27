# 华域地图维护项目

这是华域地图 `4.0.1-huayu-building-model-v9` 的独立交接项目，不依赖 Codex 运行。

维护电脑只需安装 Git 与 Node.js 20 或更高版本。Node.js 官方安装包会同时提供 `npm`；生产部署由 GitHub Actions 执行，本地不需要保存 Cloudflare Token。

## 目录

- `site/`：Cloudflare Pages 实际部署目录，包含完整生产文件。
- `.github/workflows/`：自动部署与每日线上巡检。
- `scripts/`：清单生成、离线校验、线上校验和发布存档脚本。
- `release/`：当前 `site/` 的 SHA-256 清单。
- `docs/`：中文运维、密钥配置和回退说明。

## 常用命令

```powershell
npm run verify
npm run verify:online
pwsh ./scripts/create-release.ps1
```

修改 `site/` 后必须依次运行：

```powershell
npm run manifest:update
npm run verify
```

随后提交到 GitHub。`main` 分支变化会触发 Cloudflare Pages 部署；也可以在 GitHub Actions 页面手动运行。

首次连接 GitHub 和 Cloudflare 前，请完整阅读 [中文运维手册](docs/OPERATIONS_ZH.md) 与 [密钥配置说明](docs/SECRETS_ZH.md)。
