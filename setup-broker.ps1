$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $ScriptDir 'packages/broker/scripts/setup.cjs') @args
exit $LASTEXITCODE
