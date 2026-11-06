# Isolated Computer · 中文使用指南

**让 AI 在后台工作，把你的桌面留给你。**

本项目是本地 MCP 服务、浏览器接力扩展和独立 Linux 桌面桥的组合。它不运行模型；由你选择的 MCP 客户端提供 AI，并选择是否调用这些工具。

> 当前是 Linux 开发预览版。Firefox 并行测试与失败判定问题已修复，相关局部复测通过；验证范围和限制见 [验证记录](VERIFY.md)。

## 先选择场景

| 你要做什么 | 使用入口 | 保留什么 |
|---|---|---|
| 接着填写你已经打开的网页 | `handoff_*` | 原标签页、原窗口、未提交内容和页面内存 |
| 从头开始一个网页任务 | `browser_*` | 在独立无头 Chromium 中开始新任务 |
| 操作 Linux 原生应用 | `desktop_*` | 应用需要从一开始就运行在独立显示会话 |

已有网页不会为了隔离而被搬到新浏览器里。任意宿主原生窗口也不能通用地迁移进独立桌面。

## 安装

完整 Linux 路径需要 Node.js 22+ 和系统桌面组件。在仓库目录执行：

```bash
npx pnpm@11.25.0 install --frozen-lockfile
node scripts/build-extensions.mjs
node scripts/print-config.mjs json
```

最后一条命令生成 MCP 客户端配置。服务入口是 `node /absolute/path/to/isolated-computer/src/server.mjs`；把绝对路径换成你的仓库位置。

如果要使用新开的无头浏览器，再执行 `npx playwright install chromium`。只用现有标签页接力时不需要启动另一套 Chromium。

## 把半填网页交给 AI

1. Chrome/Edge 在扩展管理页加载 `dist/extensions/chrome/`；Firefox 在 `about:debugging` 临时加载 `dist/extensions/firefox/manifest.json`。
2. 让 AI 调用 `computer_status`，把返回的 `extensionURL` 填入扩展的连接设置。地址包含本地令牌，不要公开。
3. 在可用于测试的网页里填写一半内容，打开扩展，写清任务并交接。
4. 对 AI 说：“继续填写我交接的网页，保留原内容，不要提交，完成后通知我。”
5. 你可以去其他标签页工作。完成时 AI 暂停，点击扩展“接回给我”恢复对原页的控制。

Chrome 读取原生无障碍树，Firefox 当前使用明确标注的 DOM 语义适配。现有标签页拒绝像素键鼠输入，因为这类操作可能激活用户窗口。自定义控件、系统文件选择器、验证码等可能需要你接管。

## 独立 Linux 应用

Ubuntu/Debian 系统组件和启动命令见 [英文快速开始](README.md#run-independent-linux-applications)。启动器创建独立 Xvfb、D-Bus 和应用环境，去除宿主 Wayland 地址；不会回退到用户当前桌面。

用 `examples/linux-apps.json` 指定需要启动的应用。Firefox、Chromium、LibreOffice 等单实例程序可能还需要独立 profile，避免请求被转发给宿主已有进程。

优先通过 `desktop_observe` 读取控件引用，再用 `desktop_controls` 操作并重新观察结果。控件缺少原生点击动作时，会返回截图与 `needs_pixel_action`，此时点击还没有完成。AI 必须看图定位，再用 `desktop_act` 点击；控件边界坐标只是提示。

禁用、只读、密码、失效引用和原生明确拒绝不能靠截图回退绕过。批次中前面的动作可能已经完成，重新观察后再决定是否继续。

## 观察和人工接管

观察默认不向模型发送截图。你可以按需看一次截图或开启本机实时预览。

小窗里点击“接管键鼠”后，先暂停 AI，等待当前动作停止，再授予独占输入。正常“交还 AI”会释放按键并恢复任务；失焦、断线、关闭或超时会释放按键，但保持 AI 暂停。完整操作步骤见 [人工验收](ACCEPTANCE.md)。

## 当前边界

- Linux 是主要验证目标；Windows UIA、macOS AX 没有实现，Safari 仍需转换、签名和真机验证。
- 这是显示、焦点和输入隔离，不是文件系统或网络安全沙箱。
- 普通 submit 控件会停下来确认，但自定义 AJAX 提交仍需要 AI 遵守用户的任务边界。
- 普通表单测试不能证明任意网站兼容；自动输入法组合事件也不等于真实系统输入法验收。
- 本地服务使用回环地址和会话令牌；运行目录、浏览器 profile、cookie 和令牌不应进入公开仓库。

许可证：[MIT](LICENSE)。
