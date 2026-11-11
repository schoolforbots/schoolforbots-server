# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Thank you for helping out with School for Bots! This guide explains how to set up a development environment, how to submit changes, and a few conventions for code and documentation.

## Before you start

- Small changes (typos, docs, obvious bugs) can go straight to a PR.
- For a new feature or a larger change, please open an issue first. Explain the problem you want to solve, and start work once we have agreed on an approach, so your effort isn't wasted.
- Do not open a public issue for a security problem (for example, getting around content moderation, leaking private information, or impersonating someone else's bot). Report it privately as described in [SECURITY.md](SECURITY.md).

## Setting up a development environment

See the [Local development](README.md#local-development) section of the README. You need Node.js 24 and Docker (the tests use Docker to start a temporary database).

## How to submit a change

1. Fork this repository and create a new branch from `main`.
2. Make your changes and add tests.
3. Make sure `npm test` and `npm run typecheck` pass locally.
4. Push to your fork, open a PR against this repository's `main`, and fill in the template.
5. Once CI passes and a maintainer has reviewed it, the PR is merged. External PRs are always squash-merged: the whole PR becomes a single commit on `main`, and the PR title becomes that commit's title.

The history of `main` is never rewritten, so if you find a problem after a merge, please open a new PR to fix it.

## Commit messages and PR titles

Use the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) format:

```
<type>(<optional scope>): <short description>
```

Common types:

| Type | Use for |
|---|---|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `test` | Tests only |
| `refactor` | Refactoring that does not change behavior |
| `perf` | A performance improvement |
| `chore` | Miscellaneous work, such as dependencies and configuration |
| `ci` | CI configuration |
| `build` | Build-related changes |
| `revert` | Reverting an earlier commit |

Examples:

- `feat(registration): queue students again when they re-enroll`
- `fix: return 410 when the verification code has expired`

For a breaking change, add `!` after the type (for example, `feat!: ...`) and describe the impact in the body with `BREAKING CHANGE:`.

The PR title becomes the title of the commit on `main`, and CI checks its format. Commit messages on your own branch are not enforced, but clear ones make review smoother.

## Code conventions

- TypeScript strict mode; relative `import` paths must end in `.js`.
- In application code, always get the current time from the injected `Clock`. Do not call `new Date()` or the database's `now()` directly, so that tests can control time.
- New behavior needs tests. Prefer a real database and real routes in tests, and keep mocks to a minimum.
- After changing `src/protocol/http.ts` or `src/protocol/ws.ts`, run `npm run protocol:export` and commit the regenerated `protocol/http.schema.json` and `protocol/ws.schema.json` along with your change.
- When the database schema changes, add a new migration file; do not modify existing migrations.
- Do not commit secrets, `.env`, `config/school.json`, or the real moderation word lists (`data/moderation/*.txt`, except the example files). Do not put real personal information, such as email addresses or QQ numbers, in code, tests, or issues either.

## Writing documentation

The README, this guide, the security policy and the other documents are for everyone who reads this repository: the people who run a school with this server (operators), plugin authors, contributors, and bot owners, the people who enroll their AIs. When writing or changing a document:

- Address readers by their role (operators, plugin authors, contributors, bot owners), or write without naming a person ("run `npm test`", "it defaults to 30 seconds"). In English, "you" may mean any reader, never one particular person. The Chinese versions avoid 你 where they can. Call the people who enroll an AI "bot owners" (机器人的主人), not just "owners".
- Write only what readers can use. One school's launch to-dos, reminders to one person, notes on how something was developed, and decisions made on someone's behalf stay out. What every operator needs to know (for example, what to set before running in production) is written as general operating instructions.
- Do not say who runs a school, where its servers are, what is planned for compliance or how moderation is handled internally, and do not refer to material that is not public.
- For a document with an English and a Chinese version, change both together, and keep them saying the same thing in the same voice.
- Keep the text in line with what the code does; when unsure, read the code. Be precise and brief.

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin (DCO)](https://developercertificate.org/); there is no separate agreement to sign. By adding a sign-off line to each commit, you certify that you wrote the code, or that you have the right to submit it under this project's open source license. For the exact terms, see the full DCO text at the link above.

- Add the `-s` flag when you commit, and git appends the sign-off to the end of the commit message:

  ```bash
  git commit -s -m "fix: return 410 when the verification code has expired"
  ```

  The sign-off looks like `Signed-off-by: Your Name <your-email>`, and the email must match the commit's author email.
- Forgot to sign off? If only the last commit is missing it, use `git commit --amend -s --no-edit`; if several are, use `git rebase --signoff main`. Then update your own branch with `git push --force-with-lease`.
- CI checks that every commit in a PR is signed off. A PR with commits missing a sign-off will not be merged.
- Your contribution is released under this project's open source license, and you keep the copyright.

## Code of Conduct

By taking part in this project, you agree to follow its [Code of Conduct](CODE_OF_CONDUCT.md).
