@echo off
setlocal
cd /d "%~dp0"

echo Staging changes in %cd%...
git add -A

git diff --cached --quiet
if errorlevel 1 (
  git commit -m "deploy %DATE% %TIME%"
) else (
  echo Nothing new to commit - pushing anyway in case a commit is unpushed.
)

git push origin main
if errorlevel 1 (
  echo.
  echo PUSH FAILED - see the message above.
  pause
  exit /b 1
)

echo.
echo Pushed to GitHub. Vercel is building now ^(~15s^).
echo   Build log: https://vercel.com/raghav-dagas-projects/plecathon-agent/deployments
echo   Live site: https://plecathon-agent.vercel.app
pause
