param(
  [string]$Url = "https://rivers-and-seas.naturalresources.wales/map/GetStations",
  [string]$ScriptOutputPath = "data\nrw-stations.js"
)

$headers = @{
  "Accept" = "application/json"
  "User-Agent" = "RiverLevelsLocalPreview/1.0"
}

New-Item -ItemType Directory -Force -Path (Split-Path $ScriptOutputPath -Parent) | Out-Null
$response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 60 -Headers $headers
$json = $response.Content
$stations = $json | ConvertFrom-Json
if (-not ($stations -is [array]) -or $stations.Count -eq 0) {
  throw "NRW returned an empty or unexpected station response."
}

$json = $json.Replace("&", "\u0026").Replace("<", "\u003c").Replace(">", "\u003e")
$json = $json.Replace([string][char]0x2028, "\u2028").Replace([string][char]0x2029, "\u2029")
$fetchedAt = (Get-Date).ToUniversalTime().ToString("o")
$script = @"
window.NRW_STATIONS_FETCHED_AT = "$fetchedAt";
window.NRW_STATIONS = $json;
"@

$script | Set-Content -LiteralPath $ScriptOutputPath -Encoding UTF8
Write-Host "Wrote $($stations.Count) NRW stations to $ScriptOutputPath at $fetchedAt"
