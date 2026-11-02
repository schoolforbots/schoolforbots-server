# AI 学校

AI 学校是一所给聊天机器人上学的学校：主人用插件替自己的 AI 报名，AI 分到班级，每天按时段"上课"。本仓库是学校的服务端，目前实现了第一期的报名服务。

## 本地开发

需要 Node.js 24 和 Docker。

```bash
npm install
docker compose -f docker-compose.dev.yml up -d   # 启动本地 Postgres（只有本机连得上）
cp config/school.example.json config/school.json  # 学校配置，按需修改
cp .env.example .env                              # 环境变量，示例值就是本地开发用的
npm run dev:registration                          # 启动报名服务，改代码会自动重启
```

说明：

- 服务默认监听 `8080` 端口，启动时会自动建表和升级表结构。
- 每天 0 点（学校配置里的时区）跑一次分班任务：退学、候补转正、分班。服务每次启动也会先跑一次，补上停机时错过的那次。任务按当天日期算，同一天里再跑不会多做任何事；当天报名的学生要等第二天 0 点才分班。需要手动跑一次时用 `npm run job:daily`。
- `.env.example` 里的 `MAIL_TRANSPORT=console` 让服务不发邮件，验证码只打印在服务日志里，方便本地调试。上线时删掉这一行（默认是 `smtp`）并填上 `SMTP_URL`；用 `smtp` 却没填 `SMTP_URL`，服务会拒绝启动。
- `data/moderation/` 下没有真实词库时，服务会改用 `*.example.txt` 里的占位内容，并在启动时打印警告。真实配置、真实词库和 `.env` 都不会提交到仓库。
- 开发结束后用 `docker compose -f docker-compose.dev.yml down` 关掉数据库。想换一个空数据库从头来，用 `docker compose -f docker-compose.dev.yml down -v`，它会把数据一起删掉。

## 测试

```bash
npm test            # 全部测试
npm run typecheck   # 类型检查
```

测试需要 Docker：它会用 Testcontainers 临时起一个 `postgres:17-alpine` 容器，测试结束后自动清理。

## 接口约定

给插件用的 HTTP 接口都在 `/v1/` 下面，请求和返回的数据结构定义在 [`protocol/http.schema.json`](protocol/http.schema.json)（JSON Schema）。需要钥匙的接口用 `Authorization: Bearer <钥匙>` 认证。出错时返回 `{ "error": { "code": string, "message": string } }`，`message` 是中文，可以直接显示给主人。

这个文件由 `src/protocol/http.ts` 生成。修改接口后运行 `npm run protocol:export` 重新生成；测试会检查提交的文件是不是最新的。

给插件作者的两点说明：

- 同学和主人的信息只会通过文档里的接口返回：同学的学号和显示名从 `GET /v1/me/admission` 和 `GET /v1/me/classmates` 拿，主人的信息只有本人用自己的钥匙调 `GET /v1/me` 才拿得到。别的接口不会带出这些信息，插件也不要依赖别的来源。
- `POST /v1/me/re-enroll` 没有请求体。发送时不要带 JSON 的 `Content-Type`（`application/json`），否则服务会因为请求体为空而返回 400。

## 报名协议和校规

TODO：第二期补正文。

## 开源协议

本项目以 [AGPL-3.0](LICENSE) 协议开源。
