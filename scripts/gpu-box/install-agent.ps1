# Install the TouchSphere AI power agent on a Windows GPU box, so the
# dashboard's Settings -> AI box card gets an On/Off switch for it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\gpu-box\install-agent.ps1 `
#       -Dir C:\ai\agent -Containers compose -ComposeDir C:\path\to\touchsphere-dashboard
#
#   -Dir         where the agent lives (agent.js, token.txt, agent.json, logs)
#   -Distro      the WSL distro the GPU containers run in (`wsl -l -v` lists them)
#   -Containers  wsl          the distro runs nothing else: on holds it open, off terminates it (lokloComputer)
#                wsl-compose  a shared distro: on/off is `docker compose up -d` / `stop` inside it
#                compose      Docker Desktop: `docker compose` straight from Windows; on starts Docker Desktop (loklo-pc)
#   -ComposeDir  the checkout inside the distro (wsl-compose) or on Windows (compose)
#   -Ollama      app (the Windows app, default) | systemd (inside the distro) | compose | none
#   -Token       the token; the dashboard has ONE for every box, so pass the
#                other box's when this is the second. Omitted: an existing
#                token.txt is kept, else a new one is written.
#
# Copies agent.js and start-agent.vbs beside this script into -Dir, writes
# agent.json from the switches, puts a "TouchSphere AI agent" shortcut in the
# Startup folder, starts the agent now (through WMI, so it does not belong to
# this shell's job — see the README) and asks it for its status. Afterwards:
#   tailscale serve --bg --tcp=8190 tcp://127.0.0.1:8190
# and on the dashboard host add this box to AI_BOX_AGENTS in .env.
param(
  [string]$Dir = 'E:\ai\agent',
  [string]$Distro = 'touchsphere-ai',
  [ValidateSet('wsl', 'wsl-compose', 'compose')][string]$Containers = 'wsl',
  [string]$ComposeDir = '',
  [ValidateSet('app', 'systemd', 'compose', 'none')][string]$Ollama = 'app',
  [string]$Token = ''
)
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'node is not installed - https://nodejs.org (start-agent.vbs expects C:\Program Files\nodejs\node.exe)' }
if ($Containers -ne 'compose' -and -not ((wsl -l -q) -replace "`0", '' | Where-Object { $_.Trim() -eq $Distro })) {
  throw "no WSL distro called '$Distro' - `wsl -l -v` lists them"
}

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Copy-Item (Join-Path $src 'agent.js'), (Join-Path $src 'start-agent.vbs') -Destination $Dir -Force

$tokenFile = Join-Path $Dir 'token.txt'
if ($Token) {
  Set-Content -NoNewline -Path $tokenFile -Value $Token
} elseif (-not (Test-Path $tokenFile)) {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  Set-Content -NoNewline -Path $tokenFile -Value (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
  Write-Host "wrote a new token to $tokenFile - if another box already has an agent, re-run with -Token <its token.txt>"
}

$cfg = [ordered]@{ containers = $Containers; distro = $Distro; ollama = $Ollama }
if ($ComposeDir) { $cfg.compose = [ordered]@{ dir = $ComposeDir; file = 'docker-compose.voice.yml'; profile = 'gpu' } }
$cfg | ConvertTo-Json -Depth 3 | Set-Content -Path (Join-Path $Dir 'agent.json')

# The Startup shortcut: what starts the agent at every sign-in.
$startup = [Environment]::GetFolderPath('Startup')
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $startup 'TouchSphere AI agent.lnk'))
$lnk.TargetPath = 'wscript.exe'
$lnk.Arguments = "`"$Dir\start-agent.vbs`""
$lnk.WorkingDirectory = $Dir
$lnk.Save()

# Start it now the same way the shortcut does, but through WMI: a child of
# this PowerShell would die with whatever window or app owns it.
$running = Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" | Where-Object { $_.CommandLine -like "*start-agent.vbs*" }
if (-not $running) {
  Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "wscript.exe `"$Dir\start-agent.vbs`"" } | Out-Null
  Start-Sleep -Seconds 4
} else {
  # A supervisor is already up: it starts the new agent.js once the old one
  # exits. Stop the old one so that happens now.
  Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine -like '*agent.js*' } | Stop-Process -Force
  Start-Sleep -Seconds 14
}

$tok = (Get-Content $tokenFile -Raw).Trim()
try {
  $st = Invoke-RestMethod -Uri 'http://127.0.0.1:8190/status' -Headers @{ Authorization = "Bearer $tok" } -TimeoutSec 20
  Write-Host "agent up: phase $($st.phase), containers $($st.containers) ($(if ($st.containersRunning) { 'running' } else { 'not running' })), ollama $(if ($st.ollamaRunning) { 'running' } else { 'not running' })"
} catch {
  Write-Host "agent not answering yet: $_  (see $Dir\agent.log and supervisor.log)"
}
Write-Host ''
Write-Host 'Next:'
Write-Host '  1. tailscale serve --bg --tcp=8190 tcp://127.0.0.1:8190   (once; tailnet-only)'
Write-Host '  2. On the dashboard host, in .env, add this box to AI_BOX_AGENTS, e.g.'
Write-Host '       AI_BOX_AGENTS=loklo-pc=http://100.98.235.63:8190, lokloComputer=http://100.112.40.40:8190'
Write-Host "     with AI_BOX_AGENT_TOKEN=$tok  (the same token on every box), then: docker compose up -d app"
