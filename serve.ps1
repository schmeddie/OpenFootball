# Serves this folder at http://localhost:8000/ (or the next free port) and
# opens it in your browser. Only this machine can connect, and only files
# inside this folder are served. Close the window or press Ctrl+C to stop.
# Uses only what ships with Windows (PowerShell 5.1+), no installs needed.
param([int]$Port = 8000)

$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$rootWithSep = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.csv'  = 'text/csv; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.md'   = 'text/plain; charset=utf-8'
  '.png'  = 'image/png'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
}

$listener = $null
for ($p = $Port; $p -lt $Port + 20; $p++) {
  $candidate = New-Object System.Net.HttpListener
  $candidate.Prefixes.Add("http://localhost:$p/")
  try {
    $candidate.Start()
    $listener = $candidate
    $Port = $p
    break
  } catch {
    $candidate.Close()
  }
}
if (-not $listener) {
  Write-Host "Couldn't start a local web server on ports $Port to $($Port + 19)."
  exit 1
}

$url = "http://localhost:$Port/"
Write-Host ''
Write-Host "  OpenFootball is running at $url"
Write-Host '  Keep this window open while you use it. Close it (or press Ctrl+C) to stop.'
Write-Host ''
try { Start-Process $url } catch { Write-Host "  Open $url in your browser." }

try {
  while ($listener.IsListening) {
    # Wait in short slices so Ctrl+C can stop the server.
    $pending = $listener.GetContextAsync()
    while (-not $pending.AsyncWaitHandle.WaitOne(250)) { }
    $ctx = $pending.GetAwaiter().GetResult()
    $res = $ctx.Response
    try {
      $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
      if ($rel -eq '') { $rel = 'index.html' }
      $path = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $rel))
      $inside = $path.StartsWith($rootWithSep, [System.StringComparison]::OrdinalIgnoreCase)
      if ($inside -and [System.IO.File]::Exists($path)) {
        $type = $types[[System.IO.Path]::GetExtension($path).ToLower()]
        if (-not $type) { $type = 'application/octet-stream' }
        $res.ContentType = $type
        $bytes = [System.IO.File]::ReadAllBytes($path)
      } else {
        $res.StatusCode = 404
        $res.ContentType = 'text/plain; charset=utf-8'
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('Not found')
      }
      $res.Headers.Add('Cache-Control', 'no-cache')
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      try { $res.StatusCode = 500 } catch { }
    } finally {
      $res.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
