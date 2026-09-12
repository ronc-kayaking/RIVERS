param(
  [switch]$RefreshNrw
)

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Push-Location $root
try {
  git submodule sync -- data/rainchasers-source
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to synchronize the Rainchasers submodule."
  }

  git submodule update --init --recursive -- data/rainchasers-source
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to initialize the Rainchasers submodule."
  }

  & "$PSScriptRoot\Build-RainchasersData.ps1"
  if (-not $?) {
    throw "Unable to build Rainchasers browser data."
  }

  if ($RefreshNrw) {
    & "$PSScriptRoot\Refresh-NrwData.ps1"
    if (-not $?) {
      throw "Unable to refresh NRW browser data."
    }
  }
} finally {
  Pop-Location
}
