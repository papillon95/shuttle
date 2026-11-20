#!/bin/bash
# 把桌面客户端同步到 GitHub 公开仓库（默认 git@github.com:papillon95/shuttle.git）。
# GitHub 上不放开发过程的提交记录：每次同步只把主仓库里 aidesk-desktop 当前已提交的内容做成一个新提交，
# 说明写「Shuttle v<版本号>」，作者是 GitHub 账号和它的匿名邮箱，接在 GitHub 上一次的提交后面，并打上版本标签。
# 内容和 GitHub 上最新的一样时什么都不做。
# 用法（在主仓库任意目录）：aidesk-desktop/scripts/sync-github.sh    演练不推送：DRY=1 aidesk-desktop/scripts/sync-github.sh
# 需要这台电脑能用 SSH 推送到 GitHub。
set -euo pipefail
REMOTE="${GITHUB_REMOTE:-git@github.com:papillon95/shuttle.git}"
NAME="${GITHUB_NAME:-papillon95}"
EMAIL="${GITHUB_EMAIL:-46234401+papillon95@users.noreply.github.com}"

MONO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$MONO"
TMPREF=refs/tmp/github-main
trap 'git update-ref -d "$TMPREF" 2>/dev/null || true' EXIT

VERSION="$(git show HEAD:aidesk-desktop/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
TREE="$(git rev-parse HEAD:aidesk-desktop)"

# GitHub 上现在的最新提交（空仓库时没有）
PARENT=""
if git ls-remote --exit-code "$REMOTE" refs/heads/main >/dev/null 2>&1; then
  git fetch -q "$REMOTE" "+refs/heads/main:$TMPREF"
  PARENT="$(git rev-parse "$TMPREF")"
  if [ "$(git rev-parse "$PARENT^{tree}")" = "$TREE" ]; then
    echo "✓ GitHub 已是最新（v$VERSION，$(git rev-parse --short "$PARENT")）"
    exit 0
  fi
fi

COMMIT="$(GIT_AUTHOR_NAME="$NAME" GIT_AUTHOR_EMAIL="$EMAIL" GIT_COMMITTER_NAME="$NAME" GIT_COMMITTER_EMAIL="$EMAIL" \
  git commit-tree "$TREE" ${PARENT:+-p "$PARENT"} -m "Shuttle v$VERSION")"

if [ -n "${DRY:-}" ]; then
  echo "演练：不推送。会在 ${PARENT:-（空仓库）} 后面加提交 $(git rev-parse --short "$COMMIT")「Shuttle v$VERSION」，标签 v$VERSION"
  exit 0
fi

git push -q "$REMOTE" "$COMMIT:refs/heads/main"
# 版本标签：同一个版本再次同步时，标签移到最新的提交上
git push -q -f "$REMOTE" "$COMMIT:refs/tags/v$VERSION"
echo "✓ 已同步到 $REMOTE：Shuttle v$VERSION（$(git rev-parse --short "$COMMIT")）"
