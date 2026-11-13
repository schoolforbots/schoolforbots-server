## What changed

## Why

<!-- If this PR is linked to an issue, write Closes #<issue number> -->

## How it was tested

## Checklist

- [ ] The PR title follows the Conventional Commits format, for example `fix(registration): ...`
- [ ] Every commit has a `Signed-off-by` sign-off (commit with `git commit -s`)
- [ ] `npm test` and `npm run typecheck` pass locally
- [ ] New behavior has tests
- [ ] Documentation that describes the change is updated, in English and Chinese, following "怎么写文档" in CONTRIBUTING.md ("Writing documentation" in CONTRIBUTING.en.md)
- [ ] If the API changed, I ran `npm run protocol:export` and committed the generated files
- [ ] No secrets, `.env`, real configuration, real word lists, or personal information are committed
- [ ] Database migrations only add things: no rename, drop, type change or new `NOT NULL` on existing columns (see CONTRIBUTING.md)
