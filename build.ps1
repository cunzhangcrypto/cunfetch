# CunFetch 打包脚本（Windows）
# 用 PyInstaller 生成单文件 CunFetch.exe，免安装 Python 即可运行。
# 用法：powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = "Stop"

Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "==> 安装依赖..."
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install pyinstaller

Write-Host "==> 清理旧产物..."
if (Test-Path "dist") { Remove-Item "dist" -Recurse -Force }
if (Test-Path "build") { Remove-Item "build" -Recurse -Force }

Write-Host "==> 打包 CunFetch.exe..."
pyinstaller `
    --onefile `
    --name CunFetch `
    --clean `
    --noconfirm `
    --console `
    --paths src `
    src/main.py

Write-Host "==> 完成。产物：dist\CunFetch.exe"
Write-Host "    提示：运行时在 exe 同级目录放置 config.yaml（参考 config.example.yaml）。"