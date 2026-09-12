param(
  [int]$Port = 5173
)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootWithSeparator = $Root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$MimeTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".css" = "text/css; charset=utf-8"
  ".js" = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".svg" = "image/svg+xml"
  ".png" = "image/png"
  ".jpg" = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".ico" = "image/x-icon"
}

function Send-Response {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [string]$Status,
    [string]$ContentType,
    [byte[]]$Body
  )

  $Headers = "HTTP/1.1 $Status`r`nContent-Length: $($Body.Length)`r`nContent-Type: $ContentType`r`nConnection: close`r`nCache-Control: no-store`r`n`r`n"
  $HeaderBytes = [System.Text.Encoding]::ASCII.GetBytes($Headers)
  $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
  if ($Body.Length -gt 0) {
    $Stream.Write($Body, 0, $Body.Length)
  }
}

function Send-Text {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [string]$Status,
    [string]$Text
  )

  $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  Send-Response -Stream $Stream -Status $Status -ContentType "text/plain; charset=utf-8" -Body $Bytes
}

$Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$Listener.Start()
Write-Host "Serving $Root at http://localhost:$Port/"

try {
  while ($true) {
    $Client = $Listener.AcceptTcpClient()
    try {
      $Client.ReceiveTimeout = 3000
      $Client.SendTimeout = 3000
      $Stream = $Client.GetStream()
      $Stream.ReadTimeout = 3000
      $Stream.WriteTimeout = 3000
      $Reader = [System.IO.StreamReader]::new($Stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
      $RequestLine = $Reader.ReadLine()

      while ($true) {
        $Line = $Reader.ReadLine()
        if ($null -eq $Line -or $Line -eq "") { break }
      }

      if ([string]::IsNullOrWhiteSpace($RequestLine)) {
        continue
      }

      $Parts = $RequestLine.Split(" ")
      if ($Parts.Length -lt 2 -or $Parts[0] -ne "GET") {
        Send-Text -Stream $Stream -Status "405 Method Not Allowed" -Text "Only GET is supported."
        continue
      }

      $RequestPath = [System.Uri]::UnescapeDataString(($Parts[1] -split "\?")[0])
      if ($RequestPath -eq "/") {
        $RequestPath = "/index.html"
      }

      $RelativePath = $RequestPath.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)
      $FullPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($Root, $RelativePath))

      if ($FullPath -ne $Root -and -not $FullPath.StartsWith($RootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
        Send-Text -Stream $Stream -Status "403 Forbidden" -Text "Forbidden"
        continue
      }

      if (-not [System.IO.File]::Exists($FullPath)) {
        Send-Text -Stream $Stream -Status "404 Not Found" -Text "Not found"
        continue
      }

      $Extension = [System.IO.Path]::GetExtension($FullPath).ToLowerInvariant()
      $ContentType = $MimeTypes[$Extension]
      if (-not $ContentType) {
        $ContentType = "application/octet-stream"
      }

      $Bytes = [System.IO.File]::ReadAllBytes($FullPath)
      Send-Response -Stream $Stream -Status "200 OK" -ContentType $ContentType -Body $Bytes
    } catch {
      try {
        Send-Text -Stream $Stream -Status "500 Internal Server Error" -Text $_.Exception.Message
      } catch {
        Write-Warning "Unable to send an error response: $($_.Exception.Message)"
      }
    } finally {
      $Client.Close()
    }
  }
} finally {
  $Listener.Stop()
}
