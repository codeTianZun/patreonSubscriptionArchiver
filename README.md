<!-- 文件功能概括：说明 Patreon 订阅文件归档油猴脚本的安装、使用、命名规则、隐私与兼容限制。 -->

<div align="center">

# 📦

### Patreon 订阅文件归档器

面向任意 Patreon 创作者页面的通用油猴脚本

[![安装](https://img.shields.io/badge/Install-Userscript-2ea44f?style=for-the-badge&logo=tampermonkey&logoColor=white)](https://raw.githubusercontent.com/CodeTianZun/patreonSubscriptionArchiver/main/patreon-subscription-archiver.user.js)
[![版本](https://img.shields.io/badge/version-1.1.0-2ea44f?style=for-the-badge)](https://github.com/CodeTianZun/patreonSubscriptionArchiver)
[![许可证](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](./LICENSE)

![Tampermonkey](https://img.shields.io/badge/Tampermonkey-userscript-f7a41d?style=for-the-badge&logo=tampermonkey&logoColor=white)
![依赖](https://img.shields.io/badge/dependencies-none-brightgreen?style=for-the-badge)
![平台](https://img.shields.io/badge/platform-Patreon%20Web-ff424d?style=for-the-badge&logo=patreon&logoColor=white)

[仓库](https://github.com/CodeTianZun/patreonSubscriptionArchiver) ·
[问题反馈](https://github.com/CodeTianZun/patreonSubscriptionArchiver/issues) ·
作者 CodeTianZun

</div>

这是一个面向任意 Patreon 创作者页面的通用油猴脚本。它使用浏览器当前登录态扫描你有权访问的帖子文件，不需要手工填写 Cookie。

## 功能

- 扫描创作者全部帖子分页，不只处理当前屏幕已加载的帖子。
- 默认下载帖子附件和音频，也可选择帖子图片。
- 所有文件名包含帖子发布日期 `YYYY-MM-DD`、帖子 ID、标题、媒体类型和媒体 ID。
- 主文件按 `根目录/创作者/YYYY-MM/` 保存。
- 每个自然月最早发布帖子中的第一个已选文件，会额外复制到 `_Monthly-First/YYYY-MM/`。
- 支持成功项去重、重新下载、停止队列、JSON/CSV 清单导出。
- 每个文件成功后立即把记录写入 Tampermonkey 本地存储；浏览器关闭、刷新或脚本中断后，重新扫描即可从未完成项继续。
- 保存任务检查点；面板会显示已记录数量、剩余数量和上次中断时状态不确定的任务。
- 下载连续无进度时会主动取消卡住的任务，等待 Patreon 恢复访问后自动重试，适合中途切换代理节点。
- 默认 2 个并发任务、每 650 毫秒启动一个下载，降低触发限流的概率。

## 安装

1. 浏览器安装 Tampermonkey。
2. 打开 `patreon-subscription-archiver.user.js`，将完整内容复制到 Tampermonkey 的“添加新脚本”编辑器并保存；或直接访问上面的“直接安装”链接，由 Tampermonkey 接管安装。
3. 打开任意创作者的帖子页，例如 `https://www.patreon.com/c/创作者/posts`。
4. 点击页面右下角的“📦 Patreon 归档”。

## 使用

1. 保持 Patreon 登录，并确认当前账号确实有权访问目标帖子。
2. 点击“扫描全部帖子”。扫描只读取清单，不会立刻下载。
3. 检查文件数量和月首文件数量；需要时先导出 JSON 或 CSV 清单。
4. 点击“开始下载”。首次批量下载时，浏览器可能询问是否允许多个文件，请选择允许。
5. 如果中途关闭页面、浏览器崩溃或网络断开，重新打开创作者页面并扫描；按钮会变成“继续下载（剩余数量）”，已经记录成功的文件不会重下。

默认连续 90 秒没有下载进度就判定为卡住，最多自动重试 4 次。可在“速度与兼容设置”中调整；下载特别大的文件且代理较慢时，可把无进度超时提高到 180 或 300 秒。

浏览器通常把相对目录创建在默认“下载”目录下。如果 Tampermonkey 或浏览器不接受子目录，脚本会自动改用包含双下划线的扁平文件名，日期与月首标记仍会保留。

## “每月第一个文件”的定义

脚本先按帖子发布时间从早到晚排序；同一月份最早帖子中的第一个已选文件就是该月首文件。默认按浏览器本地时区划分自然月，可在面板中切换为 UTC。

## 隐私与权限

- 脚本不读取、导出或持久化 Cookie。
- API 请求只使用浏览器已有登录态，并且只发起读取请求。
- 成功下载记录和任务检查点保存在 Tampermonkey 本地存储中，仅用于断点续传和跳过已经成功的项目。
- 文件的临时 `download_url` 会写入你主动导出的清单；如果要分享清单，建议先删除这一列。Patreon 的媒体下载链接可能会过期。

## 已知限制

- 脚本只下载当前账号有权访问、并且 Patreon API 返回可下载地址的内容，不能绕过订阅权限。
- Patreon 托管视频可能采用流媒体或 DRM，本版不处理视频；普通附件、音频和图片受支持。
- Patreon 改版后如果 Campaign ID 无法自动识别，可在面板中手工填写数字 ID。通常不需要这样做。
- 页面大量下载受浏览器的“允许多个文件”和默认下载位置设置控制，油猴脚本不能静默写入任意绝对路径。

## 兼容性与合规

- 脚本仅归档当前账号已获授权的文件，不绕过 Patreon 的订阅、付费或 DRM 限制，请勿用于规避访问控制。
- 使用前请在文件较少的创作者页面上验证一次行为，再用于大批量归档。
- 本项目以 MIT 许可证发布，可自由使用、修改和分发。
