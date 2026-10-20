param([string]$NodePath = '', [switch]$Stop)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localFolder = Join-Path $projectRoot '.vmv/local'
New-Item -ItemType Directory -Path $localFolder -Force | Out-Null
$runtimeFile = Join-Path $localFolder 'runtime.json'
if (-not $NodePath -and (Test-Path -LiteralPath $runtimeFile)) {
    $NodePath = (Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json).nodePath
}
if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
@{ nodePath = $NodePath } | ConvertTo-Json | Set-Content -LiteralPath $runtimeFile -Encoding UTF8
$scriptPath = Join-Path $PSScriptRoot 'share-local.mjs'
if ($Stop) {
    & $NodePath $scriptPath --stop
    exit $LASTEXITCODE
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist/index.html'))) {
    throw 'Build the viewer first: pnpm build'
}
$connectionFile = Join-Path $localFolder 'connection.json'
if (Test-Path -LiteralPath $connectionFile) {
    $session = Get-Content -LiteralPath $connectionFile -Raw | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$session.pid)"
    if ($existing -and $existing.CommandLine -and $existing.CommandLine.Contains($scriptPath)) {
        Write-Host 'PC sharing is already running.'
        Write-Host $session.serverUrl
        exit 0
    }
}
# Start-Process on Windows creates an independent process. The sharing server
# must survive closing this launcher and the assistant's command session.
$child = Start-Process -FilePath $NodePath -ArgumentList @(('"' + $scriptPath + '"')) `
    -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $localFolder 'sharing.log') `
    -RedirectStandardError (Join-Path $localFolder 'sharing-error.log')
for ($attempt = 0; $attempt -lt 90; $attempt++) {
    Start-Sleep -Milliseconds 1000
    $child.Refresh()
    if ($child.HasExited) { throw 'PC sharing could not start. See .vmv/local/sharing-error.log' }
    if (Test-Path -LiteralPath $connectionFile) {
        $session = Get-Content -LiteralPath $connectionFile -Raw | ConvertFrom-Json
        if ($session.pid -eq $child.Id) {
            Write-Host 'PC sharing started. Keep the PC awake and connected to the Internet.'
            Write-Host $session.serverUrl
            Write-Host 'Use Stop-PC-Sharing.cmd to stop.'
            exit 0
        }
    }
}
throw 'Startup is taking longer than expected. Check .vmv/local/sharing-error.log'
