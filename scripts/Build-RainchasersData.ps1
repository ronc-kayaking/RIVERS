param(
  [string]$SourceDir = "data\rainchasers-source\rivers",
  [string]$ScriptOutputPath = "data\rainchasers-sections.js"
)

function Convert-YamlScalar {
  param([string]$Value)

  $text = ""
  if ($null -ne $Value) {
    $text = $Value.Trim()
  }
  if ($text -in @("null", "~")) {
    return $null
  }
  if ($text.Length -ge 2 -and $text.StartsWith("'") -and $text.EndsWith("'")) {
    return $text.Substring(1, $text.Length - 2).Replace("''", "'")
  }
  if ($text.Length -ge 2 -and $text.StartsWith('"') -and $text.EndsWith('"')) {
    return $text.Substring(1, $text.Length - 2).Replace('\"', '"')
  }
  if ($text -match '^-?\d+(\.\d+)?$') {
    return [double]::Parse($text, [Globalization.CultureInfo]::InvariantCulture)
  }
  return $text
}

function Read-RainchasersYaml {
  param([string]$Path)

  $section = [ordered]@{
    file = (Split-Path $Path -Leaf)
    measures = @()
  }
  $context = ""
  $currentMeasure = $null

  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    if ($line -match '^([A-Za-z_]+):\s*(.*)$') {
      $key = $Matches[1]
      $value = $Matches[2]

      if ($key -in @("grade", "putin", "takeout")) {
        $section[$key] = [ordered]@{}
        $context = $key
      } elseif ($key -eq "measures") {
        $section[$key] = @()
        $context = $key
      } else {
        $section[$key] = Convert-YamlScalar $value
        $context = ""
      }
      continue
    }

    if ($context -in @("grade", "putin", "takeout") -and $line -match '^\s{2}([A-Za-z_]+):\s*(.*)$') {
      $section[$context][$Matches[1]] = Convert-YamlScalar $Matches[2]
      continue
    }

    if ($context -eq "measures" -and $line -match '^\s{2}-\s*([A-Za-z_]+)?:?\s*(.*)$') {
      $currentMeasure = [ordered]@{}
      $section.measures += $currentMeasure
      if ($Matches[1]) {
        $currentMeasure[$Matches[1]] = Convert-YamlScalar $Matches[2]
      }
      continue
    }

    if ($context -eq "measures" -and $currentMeasure -and $line -match '^\s{4}([A-Za-z_]+):\s*(.*)$') {
      $currentMeasure[$Matches[1]] = Convert-YamlScalar $Matches[2]
    }
  }

  return $section
}

function New-Point {
  param(
    [string]$Type,
    [hashtable]$Coords
  )

  if (-not $Coords -or -not $Coords.Contains("lat") -or -not $Coords.Contains("lng")) {
    return $null
  }

  return [ordered]@{
    type = $Type
    label = $(if ($Type -eq "put-in") { "Put in" } else { "Get out" })
    lat = [double]$Coords.lat
    lng = [double]$Coords.lng
  }
}

$sourcePath = Resolve-Path -LiteralPath $SourceDir -ErrorAction SilentlyContinue
if (-not $sourcePath) {
  throw "Rainchasers source was not found at '$SourceDir'. Run scripts\Initialize-ProjectData.ps1 first."
}

$sections = foreach ($file in Get-ChildItem -LiteralPath $sourcePath -Filter *.yaml | Sort-Object Name) {
  $raw = Read-RainchasersYaml $file.FullName
  if (-not $raw.river) { continue }

  $points = @()
  $putin = New-Point "put-in" $raw.putin
  $takeout = New-Point "get-out" $raw.takeout
  if ($putin) { $points += $putin }
  if ($takeout) { $points += $takeout }
  if (-not $points.Count) { continue }

  $gradeText = ""
  if ($raw.grade -and $raw.grade.Contains("text")) {
    $gradeText = [string]$raw.grade.text
  } elseif ($raw.grade -and $raw.grade.Contains("value")) {
    $gradeText = [string]$raw.grade.value
  }

  [ordered]@{
    id = $raw.uuid
    riverName = $raw.river
    name = "$($raw.river) - $($raw.section)"
    sectionName = $raw.section
    km = $raw.km
    grade = $gradeText
    notes = (@($raw.desc, $raw.directions) | Where-Object { $_ }) -join " "
    measures = $raw.measures
    sourceName = "Rainchasers"
    sourceUrl = "https://github.com/robtuley/rainchasers"
    license = "MIT"
    points = $points
  }
}

if (-not $sections.Count) {
  throw "No Rainchasers sections were generated from '$SourceDir'."
}

New-Item -ItemType Directory -Force -Path (Split-Path $ScriptOutputPath -Parent) | Out-Null
$json = $sections | ConvertTo-Json -Depth 12
$json = $json.Replace("&", "\u0026").Replace("<", "\u003c").Replace(">", "\u003e")
$json = $json.Replace([string][char]0x2028, "\u2028").Replace([string][char]0x2029, "\u2029")
"window.RAINCHASERS_SECTIONS = $json;" | Set-Content -LiteralPath $ScriptOutputPath -Encoding UTF8
Write-Host "Wrote browser data script to $ScriptOutputPath"
