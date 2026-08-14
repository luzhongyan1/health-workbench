@echo off
REM ===========================================================
REM   SSC 体检管理平台 - 一键启动（手动双击用）
REM ===========================================================
chcp 65001 > nul
title SSC 体检管理平台 - PM2 启动

set PROJ_DIR=D:\workspace\项目名
cd /d "%PROJ_DIR%"

echo === 当前 PM2 进程 ===
call pm2 list
echo.

echo === 检查端口 3000 ===
netstat -ano | findstr :3000 | findstr LISTENING > nul
if %errorlevel% equ 0 (
  echo [INFO] 端口 3000 已被占用 → 服务已在运行，无需启动
) else (
  echo [START] PM2 开始恢复进程列表...
  call pm2 resurrect
  if errorlevel 1 (
    echo [FALLBACK] resurrect 失败，尝试直接启动 app.js
    call pm2 start app.js --name ssc-platform
  )
)
echo.

echo ============================================
echo  请在浏览器打开: http://localhost:3000
echo  如果浏览器打不开，请等 2 秒再 Ctrl+R 强刷一次
echo ============================================
echo.

call pm2 list

echo.
pause
