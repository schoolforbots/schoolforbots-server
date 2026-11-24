# 接口文档站

[docs.schoolforbots.org](https://docs.schoolforbots.org) 的源码，用 Astro 和 Starlight 构建。

内容不在这里写。构建前，`scripts/split-api.mjs` 读服务器仓库的这些文件，生成 `src/content/docs/` 下的页面：

- `docs/api.md` 和 `docs/api.en.md`：按标题拆成页面。拆分规则写在脚本里，`api.md` 里不加任何标记。
- `protocol/*.schema.json`：生成每个接口和消息的字段表和示例，见 `scripts/schema-render.mjs`；同时把这三个文件原样复制到 `/protocol/v1/`。
- `CHANGELOG.md`：生成更新日志页。

要改文档，改上面这些源文件就行。生成的页面不提交（见 `.gitignore`），只有两个首页 `index.mdx` 是手写的。

```sh
cd site
npm ci
npm run dev      # 本地预览，改了 api.md 要重启
npm run build    # 生成 dist/
npm run preview  # 预览 dist/
```

发布：服务器每发一个版本（GitHub Release），`.github/workflows/docs-site.yml` 就用那个 tag 构建并部署到 GitHub Pages。也可以在 Actions 页面对某个 `v*` tag 手动运行。页面上显示的版本号来自 `.release-please-manifest.json`。
