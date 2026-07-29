[CmdletBinding()]
param(
  [string]$BaseUrl = "http://localhost:8787",
  [string]$AdminToken = $env:PUBLIC_SEARCH_ADMIN_TOKEN
)

$ErrorActionPreference = "Stop"
$base = $BaseUrl.TrimEnd("/")

function Assert-Status([string]$Name, [int]$Expected, [scriptblock]$Request) {
  try {
    $response = & $Request
    if ($response.StatusCode -ne $Expected) { throw "expected HTTP $Expected, got HTTP $($response.StatusCode)" }
    "${Name}: HTTP $Expected"
  } catch { throw "Smoke check failed for ${Name}: $($_.Exception.Message)" }
}

Assert-Status "health" 200 { Invoke-WebRequest -UseBasicParsing "$base/health" }
Assert-Status "ready" 200 { Invoke-WebRequest -UseBasicParsing "$base/ready" }
Assert-Status "public search" 200 { Invoke-WebRequest -UseBasicParsing "$base/v1/search?q=atlas" }

if ($AdminToken) {
  $headers = @{ Authorization = "Bearer $AdminToken" }
  Assert-Status "admin stats" 200 { Invoke-WebRequest -UseBasicParsing "$base/v1/admin/stats" -Headers $headers }
} else {
  "admin stats: skipped (set PUBLIC_SEARCH_ADMIN_TOKEN to verify authenticated endpoints)"
}
