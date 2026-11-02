## 改了什么

## 为什么

<!-- 如果关联了 issue，写上 Closes #编号 -->

## 怎么验证的

## 检查清单

- [ ] PR 标题符合约定式提交格式，例如 `fix(registration): ...`
- [ ] 每个提交都带 `Signed-off-by` 签名（用 `git commit -s` 提交）
- [ ] 本地跑过 `npm test` 和 `npm run typecheck`
- [ ] 新的行为有对应的测试
- [ ] 改了接口的话，已经运行 `npm run protocol:export` 并提交了生成的文件
- [ ] 没有提交密钥、`.env`、真实配置、真实词库或任何个人信息
