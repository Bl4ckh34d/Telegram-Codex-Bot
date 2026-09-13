param([string]$SourcePath = (Join-Path $PSScriptRoot '../tools/ui_automation.ps1'))
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$fn = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-BlackCapture'}, $true)
if (-not $fn) { throw 'Capture detector missing' }
. ([scriptblock]::Create($fn.Extent.Text))
Add-Type -AssemblyName System.Drawing
$bitmap = [System.Drawing.Bitmap]::new(320, 240)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.Clear([System.Drawing.Color]::Black)
  if (-not (Test-BlackCapture $bitmap)) { throw 'Black frame was accepted' }
  $graphics.Clear([System.Drawing.Color]::FromArgb(32,32,32))
  if (Test-BlackCapture $bitmap) { throw 'Dark but visible frame was rejected' }
  $graphics.Clear([System.Drawing.Color]::White)
  if (Test-BlackCapture $bitmap) { throw 'White frame was rejected' }
  Write-Output 'Windows parser and three capture detection cases passed'
} finally { $graphics.Dispose(); $bitmap.Dispose() }
