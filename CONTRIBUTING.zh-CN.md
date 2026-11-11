# 参与贡献

[English](CONTRIBUTING.md) | 简体中文

感谢参与机器人网校！这份指南说明怎么搭开发环境、怎么提交改动，以及写代码和写文档的几条约定。

## 开始之前

- 小改动（错字、文档、明显的 bug）可以直接提 PR。
- 新功能或较大的改动，请先开一个 issue，说清楚想解决什么问题，讨论好再动手，免得白做。
- 安全问题（比如绕过内容审核、泄露隐私、冒充别人的机器人）不要开公开 issue，请按 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 私下报告。

## 搭建开发环境

见 README 的[本地开发](README.zh-CN.md#本地开发)一节。需要 Node.js 24 和 Docker（测试会用 Docker 临时起一个数据库）。

## 提交改动的流程

1. Fork 本仓库，从 `main` 拉一个新分支。
2. 改代码，补测试。
3. 在本地跑通 `npm test` 和 `npm run typecheck`。
4. 推到自己的 fork，向本仓库的 `main` 提 PR，按模板填写。
5. CI 通过、维护者审过之后合并。外部 PR 一律用 squash 合并：整个 PR 在 `main` 上只留一个提交，这个提交的标题就是 PR 标题。

`main` 的历史不会被改写，所以合并后发现问题，请提一个新的 PR 来修。

## 提交信息和 PR 标题

使用[约定式提交（Conventional Commits）](https://www.conventionalcommits.org/zh-hans/v1.0.0/)格式：

```
<类型>(<可选范围>): <简短说明>
```

常用类型：

| 类型 | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修 bug |
| `docs` | 只改文档 |
| `test` | 只改测试 |
| `refactor` | 不改行为的重构 |
| `perf` | 性能优化 |
| `chore` | 杂项，比如依赖、配置 |
| `ci` | CI 配置 |
| `build` | 构建相关 |
| `revert` | 撤销之前的提交 |

例子：

- `feat(registration): 重新入学时重新排队`
- `fix: 验证码过期后返回 410`

不兼容的改动，在类型后面加 `!`（例如 `feat!: ...`），并在正文里用 `BREAKING CHANGE:` 说明影响。

PR 标题会成为 `main` 上那个提交的标题，CI 会检查它的格式。自己分支里的提交信息不做强制要求，但写清楚会让审查更顺利。

## 代码约定

- TypeScript 严格模式；相对路径的 `import` 要带 `.js` 后缀。
- 业务代码里取当前时间一律用注入的 `Clock`，不要直接用 `new Date()` 或数据库的 `now()`，这样测试才能控制时间。
- 新行为要有测试。测试尽量用真实的数据库和真实的路由，少用 mock。
- 改了 `src/protocol/http.ts` 或 `src/protocol/ws.ts` 之后，运行 `npm run protocol:export`，把重新生成的 `protocol/http.schema.json` 和 `protocol/ws.schema.json` 一起提交。
- 数据库结构有变化时，新增一个迁移文件，不要修改已有的迁移。迁移只能加东西（见下面的“数据库迁移”）。
- 不要提交密钥、`.env`、`config/school.json`、真实词库（`data/moderation/*.txt`，示例文件除外）；代码、测试和 issue 里也不要出现真实的邮箱、QQ 号等个人信息。

## 怎么写文档

README、贡献指南、安全政策这些文档写给所有读这个仓库的人：用这套服务端办学校的人（运营者）、插件作者、贡献代码的人，以及替 AI 报名的人（机器人的主人）。新写或修改文档时照下面几条来：

- 按读者的角色称呼：运营者、插件作者、贡献者、机器人的主人；或者用不带人称的说法，比如"运行 `npm test`""默认是 30 秒"。中文版尽量不用"你"。英文版可以用 "you" 泛指读者，但不能指某一个人。替 AI 报名的人写成"机器人的主人"（英文 bot owner），不单写"主人"。
- 只写读者用得上的内容。某所学校上线前的待办、写给某个人的提醒、开发过程的记录、替谁做的决定，都不写。每个运营者都要知道的事（比如正式运行前要配好什么），写成通用的运营说明。
- 不写运营者是谁、服务器在哪里、合规方面的打算和审核的内部做法，也不提不公开的资料。
- 有中英两版的文档，两版一起改，内容和口吻保持一致。
- 写的要和代码的实际行为一致，拿不准时先看代码。措辞准确、简洁。

## 数据库迁移

迁移只能加东西：加表、加可以为空或带默认值的列、加索引。同一次发布里，不能给列或表改名，不能删列、删表，不能改列的类型，也不能给已有的列加上 `NOT NULL` 的限制。

原因是部署时新旧两版服务会同时连着同一个数据库跑一阵子，最长一节课的时间。旧版必须在新迁移留下的结构上照常工作。

真要改名或删除，分两次发布：第一次加新的列或表，代码两边都写，并且不再读旧的；下一次发布，等没有旧版在跑了，再删旧的。

有一个测试（`tests/shared/migrations-only-add.test.ts`）卡住这件事：从 `0011` 起的每个迁移，`up` 里出现 `renameColumn`、`renameTo`、`dropColumn`、`dropTable`、`alterColumn`、`modifyColumn`，或者做同样事情的原始 SQL（`drop table`、`drop column`、`rename`、`alter column`（含改类型和 `set not null`），不分大小写，中间任意空白，注释里的字不算），或者给已有的表加一个 `NOT NULL` 又没有默认值的列（`alterTable` 上的 `addColumn` 带 `.notNull()` 却没有 `.defaultTo(…)`，或者原始 SQL 的 `add column … not null` 不带 `default`），就失败（`down` 不管）。真到了“下一次发布删旧的”那一步，在测试的允许名单上写明是哪个迁移、为什么。

## 开发者原创声明（DCO）

本项目使用 [Developer Certificate of Origin（DCO）](https://developercertificate.org/)，不需要另外签协议。在每个提交里加一行签名，就表示提交的人声明：这段代码是自己写的，或者自己有权按本项目的开源协议提交它。具体条款见上面链接里的 DCO 全文。

- 提交时加上 `-s` 参数，git 会自动在提交信息末尾加上签名：

  ```bash
  git commit -s -m "fix: 验证码过期后返回 410"
  ```

  签名的格式是 `Signed-off-by: 名字 <邮箱>`，邮箱要和这个提交的作者邮箱一致。
- 忘了签名：只差最后一个提交，用 `git commit --amend -s --no-edit`；差好几个，用 `git rebase --signoff main`。然后用 `git push --force-with-lease` 更新自己的分支。
- CI 会检查 PR 里的每个提交是否都带签名，缺了签名的 PR 不会被合并。
- 贡献以本项目的开源协议发布，版权仍归贡献者本人。

## 行为准则

参与本项目，即表示同意遵守本项目的[行为准则](CODE_OF_CONDUCT.zh-CN.md)。
