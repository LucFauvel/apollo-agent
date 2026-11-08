# Builds Apollo's desktop tailnet addon on Windows: the Go tsnet node (tailnet.go) as a
# static C archive, linked into the Rust Node-API crate (addon/) as
# build\win-<arch>\apollo_tailnet.node. napi-rs finds Node's functions in the running app
# when the addon loads, so the same file works in node.exe and in Electron (apollo.exe).
#
#   powershell -File apps\server\native\tailnet\build.ps1 [-Arch x64|arm64|all]
#
# Needs Go, Rust (with the *-pc-windows-gnullvm targets) and llvm-mingw
# (https://github.com/mstorsjo/llvm-mingw), found on PATH or through GO, CARGO and
# LLVM_MINGW. Works on x64 and ARM64 Windows, for either architecture.
param([ValidateSet("x64", "arm64", "all")][string]$Arch = "all")
$ErrorActionPreference = "Stop"

$Here = $PSScriptRoot
$Go = if ($env:GO) { $env:GO } else { (Get-Command go).Source }
$Cargo = if ($env:CARGO) { $env:CARGO } else { (Get-Command cargo).Source }
if ($env:LLVM_MINGW) { $env:PATH = "$env:LLVM_MINGW\bin;$env:PATH" }
# Go and Cargo work on a local folder: builds on a shared (network) drive are slow and flaky.
$Work = if ($env:APOLLO_TAILNET_WORK) { $env:APOLLO_TAILNET_WORK } else { Join-Path $env:TEMP "apollo-tailnet" }

$Targets = @{
  x64   = @{ GoArch = "amd64"; Clang = "x86_64-w64-mingw32-clang"; Rust = "x86_64-pc-windows-gnullvm" }
  arm64 = @{ GoArch = "arm64"; Clang = "aarch64-w64-mingw32-clang"; Rust = "aarch64-pc-windows-gnullvm" }
}
$Archs = if ($Arch -eq "all") { @("x64", "arm64") } else { @($Arch) }

# napi-rs's build script insists on a libnode.dll to link against on GNU-style Windows
# targets, although with its default dyn-symbols it never uses one (Node's functions are
# looked up in the running app). An empty stand-in satisfies the check and links nothing.
$Stub = Join-Path $Work "libnode-stub"
New-Item -ItemType Directory -Force $Stub | Out-Null
New-Item -ItemType File -Force (Join-Path $Stub "libnode.dll") | Out-Null
Set-Content -Path (Join-Path $Stub "libnode.a") -Value "!<arch>`n" -NoNewline -Encoding ascii
$env:LIBNODE_PATH = $Stub

foreach ($a in $Archs) {
  $t = $Targets[$a]
  $Lib = Join-Path $Work "lib-$a"
  New-Item -ItemType Directory -Force $Lib | Out-Null

  Write-Host "> Go c-archive ($a)"
  Push-Location $Here
  $env:GOOS = "windows"; $env:GOARCH = $t.GoArch; $env:CGO_ENABLED = "1"; $env:CC = $t.Clang
  & $Go build -trimpath -buildmode=c-archive -ldflags "-s -w" -o (Join-Path $Lib "libapollotailnet.a") .
  if ($LASTEXITCODE -ne 0) { throw "go build failed" }
  Pop-Location

  Write-Host "> Node-API addon (Rust, $($t.Rust))"
  $env:APOLLO_TAILNET_LIB_DIR = $Lib
  $linkerVar = "CARGO_TARGET_$($t.Rust.ToUpper().Replace('-', '_'))_LINKER"
  Set-Item "env:$linkerVar" $t.Clang
  # Static runtime: llvm-mingw's libunwind.dll is not on other machines.
  $env:RUSTFLAGS = "-C target-feature=+crt-static"
  & $Cargo build --release --manifest-path (Join-Path $Here "addon\Cargo.toml") --target $t.Rust --target-dir (Join-Path $Work "cargo")
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

  $Out = Join-Path $Here "build\win-$a"
  New-Item -ItemType Directory -Force $Out | Out-Null
  Copy-Item (Join-Path $Work "cargo\$($t.Rust)\release\apollo_tailnet.dll") (Join-Path $Out "apollo_tailnet.node") -Force
  Write-Host "ok $Out\apollo_tailnet.node ($([math]::Round((Get-Item (Join-Path $Out 'apollo_tailnet.node')).Length / 1MB, 1)) MB)"
}
