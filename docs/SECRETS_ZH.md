# GitHub 与 Cloudflare 密钥配置

仓库只引用密钥名称，禁止提交任何真实 Token、OAuth 配置或账号密码。

## 必需的 GitHub Actions Secrets

在 GitHub 仓库的 `Settings -> Secrets and variables -> Actions` 中添加：

- `CLOUDFLARE_API_TOKEN`：仅授予目标账号的 Cloudflare Pages 编辑权限。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账号 ID，不是登录密码。

建议在 GitHub `Environments` 中建立 `production` 环境，并把上述密钥放在该环境内。可以为生产环境启用人工批准。

若这两个 Secret 尚未配置，`Deploy production` 会完成项目校验，随后显示警告并跳过 Cloudflare 上传。它不会把当前线上版本清空，也不会把凭据缺失记成代码故障。配置完成后重新手动运行工作流即可正式部署。

## 禁止提交的文件

- `.wrangler/config/default.toml`
- `.env` 与 `.env.*`
- Cloudflare OAuth Token、刷新 Token
- 个人浏览器配置与登录 Cookie

密钥失效时，只需在 GitHub 中替换 Secret，不需要修改源代码。人员变更后应立即轮换 Token。
