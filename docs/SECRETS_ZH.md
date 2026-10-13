# GitHub 与 Cloudflare 密钥配置

仓库只引用密钥名称，禁止提交任何真实 Token、OAuth 配置或账号密码。

## 必需的 GitHub Actions Secrets

在 GitHub 仓库的 `Settings -> Secrets and variables -> Actions` 中添加：

- `CLOUDFLARE_API_TOKEN`：授予目标账号的 Cloudflare Pages、D1 和 R2 编辑权限。发布流程只创建或更新 `ogf-atlas`、`ogf-atlas-users` 和 `ogf-atlas-user-images`。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账号 ID，不是登录密码。

## 可选的 GitHub Actions Variable

- `HUAYU_ADMIN_USERNAMES`：以英文逗号分隔的初始管理员用户名。用户名本身不是密钥；变量为空时注册、登录和用户自助管理仍可用，但不会显示管理员用户列表。

发布前的资源配置脚本会幂等创建 D1 数据库 `ogf-atlas-users`、R2 存储桶 `ogf-atlas-user-images`，执行 `migrations/0001_personal_data.sql`，并把 `DB`、`USER_IMAGES` 绑定到 Pages 生产环境。真实资源 ID 只从 Cloudflare API 读取，不提交到仓库。

建议在 GitHub `Environments` 中建立 `production` 环境，并把上述密钥放在该环境内。可以为生产环境启用人工批准。

若这两个 Secret 尚未配置，`Deploy production` 会完成项目校验，随后显示警告并跳过 Cloudflare 上传。它不会把当前线上版本清空，也不会把凭据缺失记成代码故障。配置完成后重新手动运行工作流即可正式部署。

## 禁止提交的文件

- `.wrangler/config/default.toml`
- `.env` 与 `.env.*`
- Cloudflare OAuth Token、刷新 Token
- 个人浏览器配置与登录 Cookie

密钥失效时，只需在 GitHub 中替换 Secret，不需要修改源代码。人员变更后应立即轮换 Token。
