# 华域地图应用端

本批构建标识：`9.0-app-clients-v1`。源码、构建成功、已生成安装包、签名、公开下载与应用商店上架分别核验；工程存在不等于所有平台均已发版。

## 共用的功能与数据

浏览器安装版（PWA）及原生客户端都使用现有华域地图页面、地图算法和同源 HTTPS 服务。地图、屋顶及颜色、日照、交通、导航、模拟、品牌、词条、共享数据、车次、模板和自备 AI 继续使用原处理器；没有复制一套简化地图。所有客户端使用同一线上 D1，按原账号和作者／管理员权限鉴权，无需新增数据库或改变 OGF。

网页与客户端的会话存储彼此独立，各设备首次需要登录同一地图账号。私人收藏和已发布资料按原服务同步；本机 GLB、渲染偏好、未发布草稿及 AI 密钥不自动跨设备复制。密钥继续只在当前页面内存中，刷新／退出／账号切换后清除，不写入原生配置、安装包或系统钥匙串。

应用为在线客户端，首次加载、地图瓦片、查询、上传与实时更新需要网络。PWA 服务工作线程仅保存断网提示页与图标，导航失败才显示提示；不缓存账号接口、上传、模型、底图、快照或主页面，不改变两分钟建模、五分钟检查和三小时重建。不能将安装到主屏幕宣称为全量离线地图。系统后台仍遵守原页面暂停，不新增持续定位或后台模拟。

## 安装与平台工程

| 平台 | 浏览器安装版 | 原生工程及产物 |
| --- | --- | --- |
| Windows | Edge／Chrome 等支持安装的浏览器 | Electron、x64 NSIS 安装程序；可另构建 ARM64 |
| Linux | 支持安装的 Chromium 浏览器 | Electron、x64 AppImage／Deb |
| macOS | 支持安装的浏览器 | Electron、DMG；正式分发需签名与公证 |
| Android 8.0及以上 | Chrome 等支持安装的浏览器 | Java＋系统 WebView，测试 APK；正式包需维护者持有固定签名 |
| iOS／iPadOS 15及以上 | Safari 分享 → 添加到主屏幕 | Swift＋WKWebView，未签名 archive；安装分发需苹果签名及对应权限 |

站内“关于 → 安装到设备”与独立 [安装页](../site/apps.html) 调用真实浏览器安装事件。没有事件时显示平台菜单步骤，不模拟安装成功；iOS通过Safari添加主屏幕。原生包下载清单 `site/app-releases.json` 只在核实实际产物、版本、架构和 SHA-256 后添加真实 HTTPS 地址，未发布时明确为空，不填虚构下载按钮。

桌面运行时包含在安装包中；手机使用系统 WebView／WKWebView。安装包首次启动连接固定 `https://ogf-atlas.pages.dev`，保证已有 HttpOnly、Secure、SameSite 会话与同源写入规则继续有效，不放宽跨域接口。外部网站交给系统浏览器，拒绝 file/javascript 等任意协议；不提供命令执行、任意文件读取或通用原生接口。网页内容升级跟随网站，原生组件升级需重新分发安装包。原生客户端需先配套发布本批页面，才有移动文件导出适配。

## 文件与安全边界

桌面使用受沙箱保护的 Chromium，关闭 Node 集成、隔离上下文且开启 webSecurity；预加载仅暴露平台和版本，不暴露文件系统／IPC。下载限于本地图域或其 Blob，使用系统保存窗口。

移动端沿用 HTML 文件选择器上传，用户主动选择的文件继续在原表单核对。导出通过限定生产域且仅主框架可用的通信桥，将完整 Blob 分块送到应用私有临时文件；逐块计数，只有收到声明的全部字节后才打开系统文件保存窗口，取消／失败清理本次临时任务，不报告成功。不新增共享数据上传配额，实际文件、内存、磁盘与平台限制仍适用。Android 使用 Storage Access Framework，iOS 使用文件导出选择器，不申请全盘存储或持续定位权限。未知源页面和子框架不能调用保存接口。

桌面、手机、网页的文件导入与导出、图片／SVG／CSV／ZIP、账号变更、软键盘、刘海／手势安全区及横竖屏应分别实机验收；单元回归不等于所有设备完成实测。不要为了打包关闭地图功能、缩小源数据或降低既有模型细节。

## 构建

先运行 `node scripts/prepare-apps.mjs --check` 与 `node scripts/test-app-clients.mjs`。图标为仓库内确定性几何绘制，运行 `node scripts/prepare-apps.mjs` 可重新生成，共用配置为 `apps/app.json`。

桌面安装 Node.js 24 与 pnpm 11.25.0，在 `apps/desktop`：
```text
pnpm install --frozen-lockfile --ignore-scripts
node node_modules/electron/install.js
pnpm start
pnpm run dist -- --win nsis --x64
```
Linux用 `--linux AppImage deb --x64`；macOS用 `--mac dmg`，在对应系统构建。依赖和官方 Electron 运行时需要联网；版本锁定，不在生产机器自动升级依赖。

Android安装JDK17、Android SDK35与Gradle8.11.1：
```text
gradle -p apps/android :app:assembleDebug :app:lintDebug
```
测试 APK 使用开发签名，不作为稳定升级／商店生产包。生产签名由维护者安全保管，不能提交 keystore、密码或证书；签名变化可能需要卸载旧测试包，卸载会清除客户端本机数据。

iOS需macOS和Xcode，先在 `apps/ios` 运行 `xcodegen generate`，再打开生成工程。GitHub的未签名archive仅验证编译，不能直接装到iPhone；正式TestFlight／App Store分发由持有苹果开发者权限的维护者配置签名与审核。未接入商店发布、自动签名或支付，不会替用户注册／购买开发者服务。

`.github/workflows/app-build.yml` 提供独立多平台构建，上传Actions产物，不改D1、不更新网站、不自动发布GitHub Release或应用商店。正式下载前核对哈希、签名和实机验收。网站发布仍运行原四项检查并核实Cloudflare部署。

## 助手接入与验收

`get_app_status` 真实调用 `HuayuApp.status()`，返回当前平台、独立窗口、原生文件保存及安装提示状态，不安装应用、不读本机文件或私人信息。帮助复用“常见问题”的应用小节及原“关于”入口。既有助手对话与地图工具共用原处理器，不能宣称已完成签名、安装或商店上架。

回归覆盖显式安装、不支持安装时的提示、Android／iOS分块字节一致、保存取消与失败、服务工作线程不接管原数据和不清理其他缓存、原生来源隔离及助手真实调用。继续执行 `test-panel-help`、`test-map-agent` 和发布要求的整包／数据检查。
