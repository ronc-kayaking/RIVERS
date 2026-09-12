param(
  [string]$Url = "https://rivers-and-seas.naturalresources.wales/map/GetStations",
  [string]$JsonOutputPath = "data\nrw-stations.json",
  [string]$ScriptOutputPath = "data\nrw-stations.js"
)

$headers = @{
  "Accept" = "application/json"
  "User-Agent" = "RiverLevelsLocalPreview/1.0"
}

New-Item -ItemType Directory -Force -Path (Split-Path $JsonOutputPath -Parent) | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $JsonOutputPath -TimeoutSec 60 -Headers $headers

$json = Get-Content -Raw -LiteralPath $JsonOutputPath
$fetchedAt = (Get-Date).ToUniversalTime().ToString("o")
$script = @"
window.NRW_STATIONS_FETCHED_AT = "$fetchedAt";
window.NRW_STATIONS = $json;
"@

$script | Set-Content -LiteralPath $ScriptOutputPath -Encoding UTF8
Write-Host "Wrote NRW station snapshot to $ScriptOutputPath"
