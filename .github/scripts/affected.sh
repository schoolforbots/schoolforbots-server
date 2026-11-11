#!/usr/bin/env bash
# Which parts of CI a pull request's changes can affect, so that the workflows skip the others. ci.yml and image.yml
# run it right after actions/checkout with fetch-depth: 2. It prints one line per part, each true or false, and writes
# them to $GITHUB_OUTPUT:
#   backend  the server's typecheck and tests
#   admin    the admin pages' tests and build
#   worker   the status Worker's typecheck and tests
#   image    the image: deploy/smoke-test.sh and the restore drill (deploy/backup/drill.sh)
# The changed files are those between the merge commit GitHub makes for a pull request and its first parent, the tip
# of the base branch. Any other event, such as a push to main, runs everything: every commit on main is fully checked
# and gets its sha- image. When in doubt a part runs: a path not named below, or changes that cannot be told, run
# everything.
set -euo pipefail

backend=false admin=false worker=false image=false
everything() { backend=true admin=true worker=true image=true; }

if [ "${GITHUB_EVENT_NAME:-}" != pull_request ]; then
  echo "affected: not a pull request (${GITHUB_EVENT_NAME:-run by hand}), so everything runs"
  everything
elif ! git rev-parse -q --verify 'HEAD^2' >/dev/null; then
  echo "::warning::HEAD is not the merge commit of a pull request, so the changes cannot be told and everything runs"
  everything
# --no-renames: a file moved out of src/ counts as changed in src/ too.
elif ! files="$(git -c core.quotePath=false diff --name-only --no-renames 'HEAD^1' HEAD)"; then
  echo "::warning::git diff failed, so the changes cannot be told and everything runs"
  everything
elif [ -z "$files" ]; then
  echo "affected: the pull request changes no file, so everything runs"
  everything
else
  echo "affected: the pull request changes these files:"
  while IFS= read -r f; do
    echo "  $f"
    # In a case pattern, * matches / too: src/* is everything under src/.
    case "$f" in
      # The workflows and this script.
      .github/workflows/* | .github/scripts/*) everything ;;
      # Read by nothing in CI.
      .github/ISSUE_TEMPLATE/* | .github/pull_request_template.md | .github/CODEOWNERS | .github/dependabot.yml) ;;
      LICENSE | .env.example | admin/DESIGN.md) ;;
      # Tested, and built into the image. The drill also seeds its database with src/tools/dev-seed.ts.
      src/*) backend=true image=true ;;
      # Read by the typecheck or the tests only: the tests compare protocol/ with the schemas the code exports, and
      # docs/api*.md with the routes and error codes.
      tests/* | scripts/* | protocol/* | docs/* | vitest.config.ts) backend=true ;;
      # Read by the tests, and copied into the image or used to build it.
      school-rules/* | data/* | config/* | tsconfig*.json) backend=true image=true ;;
      # The admin pages are built into the image.
      admin/*) admin=true image=true ;;
      # The Worker is a package of its own, not in the image.
      ops/*) worker=true ;;
      deploy/* | Dockerfile | .dockerignore) image=true ;;
      # The root package.json also holds the scripts the admin steps run.
      package.json | package-lock.json) everything ;;
      # Anything else in a folder is not known here.
      */*) everything ;;
      # Markdown at the top: the README, the contributing guide and the like.
      *.md) ;;
      *) everything ;;
    esac
  done <<<"$files"
fi

describe() { if [ "$2" = true ]; then echo "| $1 | runs |"; else echo "| $1 | skipped |"; fi; }
{
  echo "### What this change can affect"
  echo
  echo "| Part | |"
  echo "| --- | --- |"
  describe "Server: typecheck and tests" "$backend"
  describe "Admin pages: tests and build" "$admin"
  describe "Status Worker: typecheck and tests" "$worker"
  describe "Image: smoke test and restore drill" "$image"
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"

{
  echo "backend=$backend"
  echo "admin=$admin"
  echo "worker=$worker"
  echo "image=$image"
} | tee -a "${GITHUB_OUTPUT:-/dev/null}"
