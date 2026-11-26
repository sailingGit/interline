<div align="center">
  <img src="assets/logo.svg" width="72" height="72" alt="Interline" />
  <h1>行间翻译 Interline</h1>
  <p><strong>原文和译文一行一行对照着读。</strong></p>
  <p>Chrome 扩展：双语网页翻译、划词翻译、YouTube 双语字幕。</p>
</div>

## 功能

| 功能 | 说明 |
| --- | --- |
| 双语网页 | 译文插在每段原文下方，短标题、菜单项直接接在原文后面；只翻译滚动到附近的段落，省请求 |
| X / Twitter | 只翻推文、回复、引用和个人简介，译文另起一行；名字、@账号、按钮和计数不翻 |
| iframe 与 Web Components | 页面里的 iframe（包括跨域和后加载的）跟着整页一起翻译；Shadow DOM 组件里的文字也会翻译，开放和封闭的都支持 |
| 动态内容 | 无限滚动、单页应用、后加载的评论都会自动翻译；文字变了会重新翻译 |
| 划词翻译 | 选中文字后出现翻译按钮，弹出卡片，可以复制、朗读；也可以用右键菜单 |
| YouTube 双语字幕 | 原文在上、译文在下，提前批量翻译后面的字幕；自动生成的字幕会重新断句 |
| 点词查词 | 点字幕里的单词会暂停视频并显示翻译 |
| 逐句暂停 | 可选：每句字幕播完自动暂停，适合跟读 |
| 翻译引擎 | Google 翻译（免费，不需要 Key）、OpenAI，或任何兼容 OpenAI 的服务（DeepSeek、Kimi、Ollama…） |
| 译文样式 | 普通、淡色、虚线下划线、高亮背景 |
| 总是翻译 | 按网站记住，打开就自动翻译 |
| 快捷键 | `Alt+A` 切换翻译 / 原文 |

## 安装

```bash
npm install
npm run build
```

打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」，选择 `dist` 目录。

## 开发

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 打包到 `dist` |
| `npm test` | 单元测试：文本过滤、分批、引擎请求与解析、字幕解析 |
| `npm run test:e2e` | 在真实 Chromium 里加载扩展，用本地模拟的翻译服务和播放器跑完整流程 |
| `npm run smoke` | 调用真实的 OpenAI（或兼容接口）翻译几段网页文字和字幕，会花一点钱；Key 从 `.env.local` 读取 |
| `npm run package` | 打包成 `release/interline-<版本>.zip` |
| `npm run icons` | 从 `assets/*.svg` 生成图标 |

Playwright 找不到浏览器时，用 `CHROMIUM_PATH` 指向本机的 Chromium。

## 结构

| 文件 | 作用 |
| --- | --- |
| `src/background.js` | 所有翻译请求都经过这里：缓存、调用引擎、快捷键、右键菜单 |
| `src/engines.js` | Google 批量接口和 OpenAI 兼容接口 |
| `src/sites.js` | 网站规则：在界面文字多的网站（如 X）上只翻用户写的内容 |
| `src/tabs.js` | 装扩展之前就打开的标签页，第一次使用时补注入脚本 |
| `src/page.js` | 找出网页里的段落，按可见性排队翻译，监听页面变化 |
| `src/ui.js` | 划词按钮、翻译卡片、错误提示，放在 Shadow DOM 里，不受页面样式影响 |
| `src/youtube-hook.js` | 运行在 YouTube 页面里，把播放器拿到的字幕复制给扩展 |
| `src/youtube.js` / `src/subtitles.js` | 解析字幕、断句、同步渲染双语字幕 |

## 数据与隐私

要翻译的文字只发给你选的翻译引擎：Google 翻译、OpenAI，或你填的 API 地址。API Key 只保存在本机浏览器里。扩展不收集任何数据。

## 还没做

- PDF 翻译、漫画（图片）翻译
- Netflix 等其他视频网站的字幕
- 只显示译文模式、输入框翻译、鼠标悬停翻译

## 许可

[MIT](LICENSE)
