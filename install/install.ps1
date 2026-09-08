<#
Cài TAD lên một máy Windows mới.

Chạy được nhiều lần: bước nào đã xong thì bỏ qua, file cấu hình đã có thì sao
lưu trước khi ghi đè. Không chạm tới credential thật bao giờ.

  .\install\install.ps1
  .\install\install.ps1 -Dir D:\tad-cli
  .\install\install.ps1 -SkipClone
#>
[CmdletBinding()]
param(
  [string] $Dir = (Join-Path $HOME 'tad-cli'),
  [switch] $SkipClone
)

$ErrorActionPreference = 'Stop'

# Console Windows mac dinh khong dung UTF-8, nen moi thong bao tieng Viet se hien
# vo neu khong dat. Chi doi encoding cua tien trinh nay, khong dong toi he thong.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$RepoUrl = 'https://github.com/anhquankcn/tad-cli.git'
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }

# Node 24 là NGƯỠNG CỨNG, không phải khuyến nghị: trên Node 22, tsdown rơi sang
# loader `unrun`, loader đó dịch config xuống node_modules\.unrun\ làm
# REPOSITORY_ROOT trỏ sai và build đổ với thông báo hoàn toàn lạc hướng
# ("no packages/*/*/package.json declares the name @deepseek-ai/dsh-api-remotes").
$NodeMinMajor = 24

function Say  ($m) { Write-Host "`n== $m" -ForegroundColor White }
function Ok   ($m) { Write-Host "   $([char]0x2713) $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "   ! $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "`n$([char]0x2717) $m" -ForegroundColor Red; exit 1 }

# ── 1. Tiền kiểm ────────────────────────────────────────────────────────────
Say 'Kiểm môi trường'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'Chưa có git.' }
Ok "git $((git --version) -replace '^git version ','')"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'Chưa có Node.' }
$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt $NodeMinMajor) {
  Die "Node $(node -v) quá cũ — cần >= $NodeMinMajor.
   Đây là ngưỡng cứng: Node 22 khiến build đổ với thông báo lạc hướng về
   '@deepseek-ai/dsh-api-remotes'. Cài Node 24 rồi chạy lại."
}
Ok "node $(node -v)"

if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) { Die 'Chưa có corepack (đi kèm Node).' }
# corepack gắn theo từng bản Node, nên đổi bản Node là phải bật lại.
try { corepack enable pnpm | Out-Null } catch { Warn 'corepack enable pnpm không chạy — thử tiếp' }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Die 'Không gọi được pnpm sau corepack enable.' }
Ok "pnpm $(pnpm --version)"

# ── 2. Mã nguồn ─────────────────────────────────────────────────────────────
Say 'Mã nguồn'

if ($SkipClone) {
  if (-not (Test-Path (Join-Path $Dir 'package.json'))) { Die "-SkipClone nhưng $Dir không phải kho mã." }
  Ok "dùng sẵn $Dir"
} elseif (Test-Path (Join-Path $Dir '.git')) {
  Ok "đã có $Dir, không clone lại"
} else {
  git clone $RepoUrl $Dir
  if ($LASTEXITCODE -ne 0) { Die 'git clone thất bại.' }
  Ok "clone vào $Dir"
}
Set-Location $Dir

# ── 3. Cài phụ thuộc và build ───────────────────────────────────────────────
Say 'Cài phụ thuộc'
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { Die 'pnpm install thất bại.' }
Ok 'pnpm install xong'

# Bản vá pi-tui được khai ở pnpm-workspace.yaml GỐC. Nếu ai đó gỡ dòng đó,
# TUI sẽ xoá trắng màn hình mỗi lần vẽ lại — hỏng theo kiểu khó truy.
$patched = Get-ChildItem 'node_modules\.pnpm' -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'pi-tui@[0-9.]+_' }
if ($patched) { Ok 'bản vá pi-tui đã áp' }
else {
  Warn 'KHÔNG thấy pi-tui đã vá — TUI có thể nhấp nháy/xoá màn hình.'
  Warn "Kiểm 'patchedDependencies' trong pnpm-workspace.yaml ở gốc kho."
}

Say 'Build'
pnpm build
if ($LASTEXITCODE -ne 0) { Die 'pnpm build thất bại.' }
if (-not (Test-Path 'apps\cli\lib\bin.js')) { Die 'Build xong nhưng không thấy apps\cli\lib\bin.js.' }
Ok 'build xong'

# ── 4. Lệnh tad ─────────────────────────────────────────────────────────────
Say 'Cài lệnh tad'

$binDir = Join-Path $env:APPDATA 'npm'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$binJs = (Join-Path $Dir 'apps\cli\lib\bin.js')

# .cmd cho PowerShell/cmd, và một shim sh cho Git Bash — máy dev thường dùng cả hai.
@"
@echo off
REM Shim goi TAD CLI tu ban da build. Sua ma nguon xong phai chay 'pnpm build'.
node "$binJs" %*
"@ | Set-Content -Path (Join-Path $binDir 'tad.cmd') -Encoding ASCII

$posix = $binJs -replace '\\', '/'
@"
#!/bin/sh
exec node "$posix" "`$@"
"@ | Set-Content -Path (Join-Path $binDir 'tad') -Encoding ASCII -NoNewline:$false

Ok "đã ghi $binDir\tad.cmd và \tad"
if ($env:PATH -split ';' -contains $binDir) { Ok "$binDir đã có trên PATH" }
else { Warn "$binDir CHƯA có trên PATH — thêm vào biến môi trường người dùng." }

# ── 5. Profile ──────────────────────────────────────────────────────────────
Say 'Dựng profile'

function Write-Profile ($Name, $Manifest) {
  $dir = Join-Path $DshHome "profiles\$Name"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $pkg = Join-Path $dir 'package.json'
  if (Test-Path $pkg) {
    Copy-Item $pkg "$pkg.bak-$([int][double]::Parse((Get-Date -UFormat %s)))"
    Warn "profile $Name đã có — đã sao lưu package.json cũ"
  }
  $Manifest | Set-Content -Path $pkg -Encoding UTF8
  Push-Location $dir
  # PHAI dung pnpm, khong phai npm: `link:` la cu phap cua pnpm va npm tu choi
  # thang voi EUNSUPPORTEDPROTOCOL.
  try { pnpm install --silent 2>&1 | Out-Null } catch { Warn "pnpm install trong profile $Name that bai" }
  Pop-Location
  Ok "profile $Name"
}

Write-Profile 'headless' @"
{
  "name": "dsh-profile-headless",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } }
}
"@

# TUI dùng gói seekarkan NẰM TRONG kho này (link:), nên sửa nguồn là thấy ngay
# sau khi build lại, không phải đóng gói tarball.
$linkPath = ($Dir -replace '\\', '/') + '/tui/seekarkan'
Write-Profile 'tui' @"
{
  "name": "dsh-profile-tui",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "seekarkan"] } },
  "dependencies": { "seekarkan": "link:$linkPath" }
}
"@

# ── 6. Khung credential ─────────────────────────────────────────────────────
Say 'Khung credential'

$cred = Join-Path $DshHome '.credentials.yaml'
if (Test-Path $cred) { Ok "đã có $cred, không đụng tới" }
else {
  @"
version: 1
refs:
  # Điền khoá thật vào đây. Tệp này KHÔNG bao giờ nên đi vào git.
  # VERTEX_KEY_API_KEY: <khoá của bạn>
"@ | Set-Content -Path $cred -Encoding UTF8
  Ok "đã tạo $cred (rỗng)"
}

# ── 7. Kiểm chứng ───────────────────────────────────────────────────────────
Say 'Kiểm chứng'

$version = & node $binJs --version 2>&1 | Select-Object -First 1
if ($LASTEXITCODE -ne 0) { Die 'tad --version không chạy.' }
Ok "tad --version -> $version"

foreach ($p in @('headless', 'tui')) {
  $err = & node $binJs --profile $p --dump-config 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) { Ok "profile $p compose được" }
  else {
    # In nguyên văn lỗi. Đoán nguyên nhân ở đây chỉ khiến người ta đi sai hướng.
    Warn "profile $p chưa compose được:"
    ($err -split "`n" | Where-Object { $_ -match 'Error' } | Select-Object -First 1) |
      ForEach-Object { Write-Host "       $($_.Trim())" -ForegroundColor Yellow }
  }
}

Say 'Xong'
Write-Host @"
   Còn hai việc phải làm bằng tay, vì chúng cần quyết định của bạn:

   1. Thêm route model vào $DshHome\profiles\<tên>\cordis.patch.yml
      Chưa có route thì tad không gọi được model nào. Xem
      install\README.md để biết khuôn tối thiểu.

   2. Điền khoá vào $cred

   Mở TUI:   `$env:SEEKARKAN_LANG='vi'; tad --profile tui
   Lưu ý biến ngôn ngữ KHÔNG phải TAD_LANG dù giao diện tên là TAD.
   Không đặt thì giao diện ra tiếng Trung.
"@
