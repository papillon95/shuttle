# Shuttle（梭子）· 桌面 AI 助手

[English](README.md) | 简体中文

Shuttle 是基于 Electron 的桌面 AI 助手：登录后直接用国内主流大模型，让 AI 读写本地文件和代码、执行命令、上网查资料、操作网页，还能接入腾讯文档、高德地图、GitHub 等外部服务。

这个仓库是 **桌面客户端** 的全部源码，使用 [Apache-2.0](LICENSE) 许可证开源。账号、会员和平台模型转发由官方服务端 `https://richbrian.site` 提供（服务端不在本仓库）；也可以在设置 →「模型与 Key」里填自己的 API Key，由客户端直接调用各家模型，不经过服务端转发。

## 功能

| 功能 | 说明 |
|---|---|
| 读写文件、执行命令 | 在工作文件夹里查看、搜索、修改文件，执行命令；修改前自动备份，默认每次都先问你 |
| 内置浏览器 | 右侧浏览器面板，AI 能自己打开网页查资料、点击、填表；做完网页自动预览并检查报错，你也可以随时自己操作（登录、输验证码） |
| 后台运行 | 复杂任务在后台跑，最多同时 3 个；可以新开对话做别的，完成或需要确认时发通知 |
| 读取文档 | 直接读 PDF、Word、Excel、PPT；也可以把文件拖进输入框或用 📎 选择，不用放进工作文件夹 |
| 连接器 | 一键接入腾讯文档、高德 / 百度 / 腾讯地图、语雀、GitHub、Notion、Figma 等（MCP），需要登录的走浏览器授权，密钥用安全输入框填写、加密保存 |
| 技能 | 飞书、金山文档、Word / Excel / PPT 等专门技能，也支持从 GitHub 或本地文件夹安装 |
| 语音输入 | 点麦克风或在输入框里按住 Option（Alt）说话 |
| 截图提问 | `Cmd/Ctrl+Shift+X` 或输入框旁的按钮，框选屏幕直接问 |
| 快捷小窗 | 在任何软件里按 `Cmd/Ctrl+Shift+Space` 随时提问，自动带上刚复制的文字 |
| 定时任务 | 让 AI 每天、每周、每月或每隔一段时间自动做事，在设置里管理，也可以在对话里直接说 |
| 生成图片、看图 | 粘贴或拖入图片让 AI 识图，或让 AI 画图 |
| 对话管理 | 搜索、按日期分组、重命名、归档、多选批量删除；长对话可以一键总结后新开 |
| 手机远程控制 | 在设置 →「远程控制」里打开后，用手机浏览器打开 `https://richbrian.site/aidesk/web/` 登录同一账号，让这台电脑处理文件、跑命令，进度实时显示，结果文件在手机上下载。第一次连接要在电脑上确认配对，远程任务里改文件和执行命令都要逐个确认 |
| 云端同步对话 | 在设置 → 数据里打开后，换电脑登录同一账号也能看到以前的对话（加密存在私有云存储里） |
| 下一句建议 | 回答完在输入框里给出你可能想问的话，按 Tab 采用 |

## 下载安装

最新版本 **v0.3.26**：

| 系统 | 下载 | 大小 |
|---|---|---|
| macOS（Apple 芯片 M1/M2/M3/M4） | [Shuttle-0.3.26-mac-arm64.dmg](https://mamahug-1256157831.cos.ap-guangzhou.myqcloud.com/shuttle/releases/v0.3.26/Shuttle-0.3.26-mac-arm64.dmg) | 97 MB |
| macOS（Intel 芯片） | [Shuttle-0.3.26-mac-x64.dmg](https://mamahug-1256157831.cos.ap-guangzhou.myqcloud.com/shuttle/releases/v0.3.26/Shuttle-0.3.26-mac-x64.dmg) | 103 MB |
| Windows 10/11（64 位） | [Shuttle-0.3.26-win-x64.exe](https://mamahug-1256157831.cos.ap-guangzhou.myqcloud.com/shuttle/releases/v0.3.26/Shuttle-0.3.26-win-x64.exe) | 79 MB |

历史版本、更新说明和 SHA-256 校验值见 [Releases](https://github.com/papillon95/shuttle/releases)。装了 0.2.0 及以上版本的用户会自动收到更新，重启即可。

安装包暂未签名，第一次打开会被系统拦一下：
- **macOS**：提示「无法验证开发者」时，打开「系统设置 → 隐私与安全性」，在下方点「仍要打开」；或在「应用程序」里右键点 App 选「打开」。
- **Windows**：出现「Windows 已保护你的电脑」时，点「更多信息 → 仍要运行」。

macOS 上截图需要「屏幕录制」权限、语音输入需要「麦克风」权限，第一次使用时按提示在系统设置里打开即可。

## 从源码运行

```bash
npm install
npm start
```

默认连接线上服务 `https://richbrian.site`。本地调试后端时，用环境变量指向本地若依（开发环境端口 8089）：

```bash
AGENT_SERVER_URL=http://127.0.0.1:8089 npm start
```

Electron 下载慢时可以用国内镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`

测试（纯 Node，不需要启动界面）：

```bash
node scripts/test-docs.mjs        # 读取 PDF / Word / Excel / PPT
node scripts/test-scheduler.mjs   # 定时任务的时间计算
node scripts/test-quick.mjs       # 快捷小窗
node scripts/test-crop.mjs        # 截图裁剪
node scripts/test-wav.mjs         # 语音输入的录音编码
```

## 更新机制

| 方式 | 什么时候用 | 用户下载 |
|---|---|---|
| **补丁更新**（大多数版本） | 只改了 `src/` 里的代码 | 约 4MB，后台自动下载，重启生效 |
| **完整安装包** | 升级了 Electron、改了 `boot.js` 或打包配置（比如 macOS 权限说明） | 新用户下载；老用户照样能收到补丁 |

- 客户端启动 10 秒后、之后每 6 小时检查一次 COS 上的版本清单 `shuttle/updates/stable.json`；设置 →「关于」里可以手动检查。
- 补丁用发布者的 **Ed25519 私钥签名**，客户端内置公钥校验，签名或指纹不对一律拒绝。
- `boot.js` 优先加载用户目录里的补丁；补丁加载报错或连续两次没能打开窗口，会自动回退到安装包自带版本。
- 补丁只包含 `src/` 和 `package.json`，**不包含 node_modules**：运行时不要新增 npm 依赖，需要的第三方库放进 `src/vendor/`（比如读 PDF 用的 pdfjs）。

## 发版（维护者）

一条命令完成：改版本号 → 发补丁并核对签名 →（完整版）打 mac / Windows 安装包、上传、登记版本、更新下载地址 → 生成发布说明 → 推送 master → 同步公开仓库并打标签 → 同步 GitHub（每个版本一个提交「Shuttle v<版本号>」并打版本标签，不带开发过程的提交记录；脚本 `scripts/sync-github.sh`，也可以单独运行）→ 创建 Gitea 发布页。

```bash
# 只发补丁（最常用）
npm run ship -- patch 0.3.1 --notes "修复了……；新增了……" --notes-en "Fixed ...; Added ..."

# 补丁 + 完整安装包
npm run ship -- full 0.4.0 --notes "……"

# 演练：只检查、列出步骤，不改任何东西
npm run ship -- patch 0.3.1 --notes "x" --dry-run
```

- 需要在 mamahug 主仓库的 master 分支、`aidesk-desktop` 没有未提交的改动时运行。
- 密钥优先读环境变量 `COS_SECRET_ID` / `COS_SECRET_KEY`、`DB_HOST` / `DB_USER` / `DB_PASS`，没设置时从主仓库的若依配置里读；签名私钥默认在 `~/.config/shuttle/release-ed25519.pem`（务必备份）。
- 设置了 `GITEA_TOKEN` 才会自动创建发布页，否则把生成的 `dist/RELEASE-v<版本>.md` 贴到发布页。
- `--notes` 里用「；」分隔多条，会变成发布说明里的列表。
- 完整安装包模式**不会提高最低外壳版本（minShell）**，老版本用户照样能收到补丁。不要直接用 `release.mjs full`，它会提高 minShell。

## 两种使用模式

| 模式 | 请求路径 | 计费 |
|---|---|---|
| 平台模型（默认） | 客户端 → `/aidesk/llm/chat/completions`（若依后端用后台配置的平台 Key 转发给厂商） | 按会员额度扣，倍率见后台「厂商与模型」；命中模型缓存的部分按 1/10 计 |
| 自己的 API Key（设置 →「模型与 Key」里填好后，在顶部模型列表「我的 Key」一组里选） | 客户端直接调用厂商的 OpenAI 兼容接口 | 不扣额度，只上报 token 数用于统计 |

两种模式在同一个模型列表里，随时切换。生成图片、语音输入、下一句建议和对话总结始终走平台（登录后）。

## 数据与隐私

- **对话内容默认只存在用户本机**：`~/Library/Application Support/Shuttle/conversations/<用户ID>/`（Windows 为 `%APPDATA%\Shuttle\`）。平台模式下消息经服务端转发给模型厂商，服务端不保存对话和文件内容。
- **云端同步对话（用户自己打开，默认关闭）**：对话文件存在私有 COS 存储桶 `shuttle-conv-1256157831`（`users/<用户ID>/<对话ID>.json`，默认 AES256 加密，匿名不可读）。客户端用服务端签发的 10 分钟临时链接直接上传 / 下载，内容不经过服务端；服务端只在 `aidesk_conversation` 表里存索引（标题、版本、是否删除）。同一对话以最后修改的为准，删除会同步到其他设备；清空全部对话或注销账号时云端一并删除。AI 生成的图片文件不同步。
- 本机设置：同目录下 `settings.json`（API Key、登录凭证、连接器密钥用系统钥匙串加密）；定时任务也存在这里。
- 修改文件前的备份：同目录下 `backups/`；内置浏览器的登录状态在独立的存储分区里，和用户的 Chrome 分开。
- 服务端保存：账号、会员与订单、调用用量（只有 token 数）、可同步的设置（自定义指令、主题、语言等，不含 API Key）。
- 只使用在 Shuttle 里安装的技能，不读取其他 AI 工具的技能目录。

## 代码结构

| 文件 | 作用 |
|---|---|
| `boot.js` | 启动入口：优先加载已下载的补丁，失败自动回退 |
| `src/main.js` | 主进程：Agent 循环（调用模型 → 执行工具 → 回传结果）、多对话后台运行、平台模型 / 自带 Key、流式解析、登录与服务端接口、设置同步、对话保存、定时任务运行器 |
| `src/tools.js` | 本地工具：list_dir / read_file / search / edit_file / write_file / run_command，限制在工作目录内 |
| `src/docs.js` | 读取 PDF / Word / Excel / PPT（PDF 用 `src/vendor/pdfjs`，其余自己解析 zip + XML） |
| `src/browser.js` | 内置浏览器：面板视图、页面快照、点击 / 输入 / 滚动、页面问题检查 |
| `src/mcp.js` / `src/mcp-remote.js` | MCP 客户端：本地（stdio）和远程（Streamable HTTP / SSE、OAuth）连接器 |
| `src/runtimes.js` | 连接器需要的 Node.js / uv 一键安装 |
| `src/skills.js` | 技能：安装、启用、按需加载 |
| `src/remote.js` | 手机远程控制：长轮询收命令、配对和授权、把进度转发给手机 |
| `src/convsync.js` | 对话云端同步：上传、拉取、删除同步、冲突处理 |
| `src/scheduler.js` | 定时任务的周期规则和下次运行时间（纯函数） |
| `src/quickask.js` | 全局快捷键小窗 |
| `src/screenshot.js` | 截图提问：截屏、框选窗口、裁剪 |
| `src/updater.js` | 补丁更新：检查、下载、验签 |
| `src/providers.js` | 内置的厂商与模型列表（离线兜底；登录后以服务端 `/aidesk/catalog` 为准） |
| `src/i18n.js` | 中英文文案（主进程和界面共用，两套键必须一一对应） |
| `src/preload.js` 等 | 暴露给各个窗口的 IPC 接口 |
| `src/renderer/` | 界面：聊天、侧边栏、设置、连接器与技能、浏览器面板、快捷小窗（`quick.*`）、截图框选（`capture.*`）、Markdown 渲染（`markdown.js`）、语音输入（`voice.js`） |
| `scripts/` | 发版（`ship.mjs`、`release.mjs`、`upload-installers.mjs`、`sync-github.sh`）和测试脚本 |

## 发布前检查

- `src/main.js` 里的 `DEFAULT_SERVER` 是否为正式地址。
- 如需上架或避免系统拦截，配置 macOS 签名公证、Windows 代码签名。

## 支持作者

Shuttle 由个人开发者独立开发和维护。如果它帮你省了时间，欢迎用微信扫码请我喝杯咖啡，每一份支持都会用在项目的运行和改进上。谢谢你！

<img src="docs/wechat-pay.jpg" alt="微信收款码" width="240">

点个 Star、反馈问题、提提建议，也都是很大的支持。

## 参与贡献

欢迎提 Issue 和 Pull Request。提交前请先跑一下上面的测试脚本；界面文案改动要同时更新 `src/i18n.js` 里的中英文两套。

## 许可证

[Apache License 2.0](LICENSE) © 2026 richbrian.site
