#!/usr/bin/env bash
# Commit everything in this folder and push to GitHub; Vercel redeploys automatically.
set -e
cd "$(dirname "$0")"

git add -A
if git diff --cached --quiet; then
  echo "Nothing new to commit - pushing anyway in case a commit is unpushed."
else
  git commit -m "deploy $(date '+%Y-%m-%d %H:%M:%S')"
fi

git push origin main

echo
echo "Pushed to GitHub. Vercel is building now (~15s)."
echo "  Build log: https://vercel.com/raghav-dagas-projects/plecathon-agent/deployments"
echo "  Live site: https://plecathon-agent.vercel.app"
