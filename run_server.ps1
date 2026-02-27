# run_server.ps1
# Called by start.bat — handles encoding + logging separately
param(
  [string]$LogFile
)

# Force UTF-8 throughout the pipeline
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::InputEncoding  = [System.Text.UTF8Encoding]::new()
$OutputEncoding           = [System.Text.UTF8Encoding]::new()

# Run node and tee output to log file
node server.js 2>&1 | Tee-Object -Append -FilePath $LogFile

# Return node's exit code
exit $LASTEXITCODE
