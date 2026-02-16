Set-Location $PSScriptRoot

# 启动动画程序 (异步启动，不阻塞加载)
if (Test-Path "NativeSplash.exe") {
    Start-Process -FilePath "NativeSplash.exe"
}

# 获取 fnm 环境
$fnmPath = "D:/Scoop/shims/fnm.exe"
if (Test-Path $fnmPath) {
    & $fnmPath env --use-on-cd | Out-String | Invoke-Expression
}

# 启动程序
$electron = Join-Path $PSScriptRoot "node_modules/.bin/electron.cmd"
if (Test-Path $electron) {
    & $electron .
} else {
    Write-Host "Error: node_modules/.bin/electron.cmd not found!" -ForegroundColor Red
    pause
}
