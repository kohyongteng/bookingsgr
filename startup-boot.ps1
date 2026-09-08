# Boot/logon startup for the Swiss Garden operations stack.
#
# Nothing on this machine used to start automatically after a Windows restart -
# not pm2 (the 5 services) and not Chrome (the Booking.com scraper's dependency).
# A reboot from a Windows update or power cut left the whole operation down until
# someone manually started it. This script is run by a scheduled task at logon.
#
# Everything is logged to startup-boot.log so a failed restart can be diagnosed
# after the fact instead of silently staying down.

$ErrorActionPreference = 'Continue'
$logPath = 'C:\apps\startup-boot.log'
$pm2Cmd = 'C:\Users\scada\AppData\Roaming\npm\pm2.cmd'
$chromeExe = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$chromeProfile = 'C:\Users\scada\booking-chrome-profile'

function Write-Log($message) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    Add-Content -Path $logPath -Value $line -Encoding utf8
}

# pm2 draws its status table with UTF-8 box-drawing characters. Without this,
# PowerShell reads that output as the OEM codepage and the log fills with
# mojibake - readable, but a mess to scan when diagnosing a failed restart.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Write-Log '--- startup-boot.ps1 starting ---'

# Give Windows a moment to finish bringing up networking/disks before pm2 starts
# services that immediately hit Gmail, the database and WhatsApp.
Start-Sleep -Seconds 20

# --- 1. pm2 services -------------------------------------------------------
# `pm2 resurrect` restores exactly the process list saved by `pm2 save`
# (C:\Users\scada\.pm2\dump.pm2) - all 5 services with their -v2 names.
try {
    $pm2Out = & $pm2Cmd resurrect 2>&1 | Out-String
    Write-Log "pm2 resurrect output: $($pm2Out.Trim())"

    Start-Sleep -Seconds 5
    # Log `pm2 list` as plain text rather than parsing `pm2 jlist`: pm2's JSON
    # embeds the process env, which on Windows contains both 'username' and
    # 'USERNAME', and ConvertFrom-Json rejects the duplicate key outright. The
    # text table carries the same status information and can't fail to parse.
    $pm2List = & $pm2Cmd list 2>&1 | Out-String
    foreach ($line in ($pm2List -split "`r?`n")) {
        if ($line.Trim()) { Write-Log "  $line" }
    }
} catch {
    Write-Log "ERROR running pm2 resurrect: $_"
}

# --- 2. Chrome (Booking.com scraper dependency) ----------------------------
# scraper-service connects to this Chrome over the DevTools port on localhost.
# The profile keeps the Booking.com login session, so this must be the same
# --user-data-dir every time. Port stays bound to localhost only.
try {
    $existing = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -match 'remote-debugging-port=9222' }
    if ($existing) {
        Write-Log 'Chrome with debug port already running - not starting a second instance.'
    } else {
        $chromeArgs = '--remote-debugging-port=9222 --user-data-dir="{0}"' -f $chromeProfile
        Start-Process -FilePath $chromeExe -ArgumentList $chromeArgs
        Start-Sleep -Seconds 8
        try {
            $ver = (Invoke-WebRequest -Uri 'http://localhost:9222/json/version' -UseBasicParsing -TimeoutSec 10).Content
            Write-Log "Chrome debug port reachable. $($ver -replace '\s+', ' ')"
        } catch {
            Write-Log "WARNING: Chrome started but debug port not reachable: $_"
        }
    }
} catch {
    Write-Log "ERROR starting Chrome: $_"
}

Write-Log '--- startup-boot.ps1 finished ---'
