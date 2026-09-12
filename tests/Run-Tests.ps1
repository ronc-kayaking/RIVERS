param(
  [string]$BrowserPath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
)

if (-not (Test-Path -LiteralPath $BrowserPath)) {
  throw "A Chromium browser was not found at '$BrowserPath'."
}

$testPage = (Resolve-Path (Join-Path $PSScriptRoot "test.html")).Path
$testUrl = ([System.Uri]$testPage).AbsoluteUri
$id = [Guid]::NewGuid().ToString("N")
$profile = Join-Path ([System.IO.Path]::GetTempPath()) "rivers-tests-$id"
$stdout = Join-Path ([System.IO.Path]::GetTempPath()) "rivers-tests-$id.out"
$stderr = Join-Path ([System.IO.Path]::GetTempPath()) "rivers-tests-$id.err"

try {
  $process = Start-Process -FilePath $BrowserPath -ArgumentList @(
    "--headless",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=$profile",
    "--virtual-time-budget=5000",
    "--dump-dom",
    $testUrl
  ) -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr

  if ($process.ExitCode -ne 0) {
    throw "Headless browser exited with code $($process.ExitCode).`n$(Get-Content -Raw $stderr)"
  }

  $html = Get-Content -Raw $stdout
  if ($html -notmatch 'data-failures="0"') {
    throw "Automated browser tests failed.`n$html"
  }

  if ($html -match '<pre id="results"[^>]*>([^<]+)</pre>') {
    Write-Host $Matches[1]
  } else {
    Write-Host "Automated browser tests passed."
  }
} finally {
  foreach ($path in @($stdout, $stderr, $profile)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Recurse -Force
    }
  }
}
