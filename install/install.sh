#!/usr/bin/env bash
# Cài TAD (arkan-dsh) lên một máy Linux/macOS mới.
#
# Chạy được nhiều lần: bước nào đã xong thì bỏ qua, file cấu hình đã có thì
# sao lưu trước khi ghi đè. Không chạm tới credential thật bao giờ.
#
#   ./install/install.sh                      # cài vào ~/arkan-dsh
#   ./install/install.sh --dir /opt/arkan-dsh # chọn chỗ khác
#   ./install/install.sh --skip-clone         # đã có mã nguồn sẵn
set -euo pipefail

REPO_URL="https://github.com/anhquankcn/tad-cli.git"
INSTALL_DIR="${HOME}/arkan-dsh"
DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"
SKIP_CLONE=0
# Node 24 là NGƯỠNG CỨNG, không phải khuyến nghị: trên Node 22, tsdown rơi sang
# loader `unrun`, loader đó dịch config xuống node_modules/.unrun/ làm
# REPOSITORY_ROOT trỏ sai và build đổ với thông báo hoàn toàn lạc hướng
# ("no packages/*/*/package.json declares the name @deepseek-ai/dsh-api-remotes").
NODE_MIN_MAJOR=24

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --skip-clone) SKIP_CLONE=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Tham số lạ: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ── 1. Tiền kiểm ────────────────────────────────────────────────────────────
say "Kiểm môi trường"

case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*)
    die "Đang chạy trong Git Bash trên Windows. Dùng install\install.ps1 —
   script này sinh đường dẫn kiểu /c/... mà Node và pnpm trên Windows không hiểu." ;;
esac

command -v git >/dev/null 2>&1 || die "Chưa có git."
ok "git $(git --version | awk '{print $3}')"

command -v node >/dev/null 2>&1 || die "Chưa có Node."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]; then
  die "Node $(node -v) quá cũ — cần >= ${NODE_MIN_MAJOR}.
   Đây là ngưỡng cứng: Node 22 khiến build đổ với thông báo lạc hướng về
   '@deepseek-ai/dsh-api-remotes'. Cài Node 24 (nvm install 24) rồi chạy lại."
fi
ok "node $(node -v)"

command -v corepack >/dev/null 2>&1 || die "Chưa có corepack (đi kèm Node)."
# corepack gắn theo từng bản Node, nên đổi bản Node là phải bật lại.
corepack enable pnpm >/dev/null 2>&1 || warn "corepack enable pnpm không chạy — thử tiếp"
command -v pnpm >/dev/null 2>&1 || die "Không gọi được pnpm sau corepack enable."
ok "pnpm $(pnpm --version)"

# ── 2. Mã nguồn ─────────────────────────────────────────────────────────────
say "Mã nguồn"

if [ "$SKIP_CLONE" -eq 1 ]; then
  [ -f "${INSTALL_DIR}/package.json" ] || die "--skip-clone nhưng ${INSTALL_DIR} không phải kho mã."
  ok "dùng sẵn ${INSTALL_DIR}"
elif [ -d "${INSTALL_DIR}/.git" ]; then
  ok "đã có ${INSTALL_DIR}, không clone lại"
else
  git clone "$REPO_URL" "$INSTALL_DIR"
  ok "clone vào ${INSTALL_DIR}"
fi
cd "$INSTALL_DIR"

# ── 3. Cài phụ thuộc và build ───────────────────────────────────────────────
say "Cài phụ thuộc"
pnpm install --frozen-lockfile
ok "pnpm install xong"

# Bản vá pi-tui được khai ở pnpm-workspace.yaml GỐC. Nếu ai đó gỡ dòng đó,
# TUI sẽ xoá trắng màn hình mỗi lần vẽ lại — hỏng theo kiểu khó truy.
if ls node_modules/.pnpm 2>/dev/null | grep -q 'pi-tui@[0-9.]*_'; then
  ok "bản vá pi-tui đã áp"
else
  warn "KHÔNG thấy pi-tui đã vá — TUI có thể nhấp nháy/xoá màn hình."
  warn "Kiểm 'patchedDependencies' trong pnpm-workspace.yaml ở gốc kho."
fi

say "Build"
pnpm build
[ -f apps/cli/lib/bin.js ] || die "Build xong nhưng không thấy apps/cli/lib/bin.js."
ok "build xong"

# ── 4. Lệnh dsh ─────────────────────────────────────────────────────────────
say "Cài lệnh dsh"

BIN_DIR="${HOME}/.local/bin"
mkdir -p "$BIN_DIR"
cat > "${BIN_DIR}/dsh" <<EOF
#!/bin/sh
# Shim gọi TAD CLI từ bản đã build. Sửa mã nguồn xong phải chạy 'pnpm build'.
exec node "${INSTALL_DIR}/apps/cli/lib/bin.js" "\$@"
EOF
chmod +x "${BIN_DIR}/dsh"
ok "đã ghi ${BIN_DIR}/dsh"
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ok "${BIN_DIR} đã có trên PATH" ;;
  *) warn "${BIN_DIR} CHƯA có trên PATH — thêm vào ~/.profile hoặc ~/.bashrc:"
     warn "  export PATH=\"\${HOME}/.local/bin:\${PATH}\"" ;;
esac

# ── 5. Profile ──────────────────────────────────────────────────────────────
say "Dựng profile"

write_profile() {
  local name="$1" manifest="$2" dir="${DSH_HOME}/profiles/$1"
  mkdir -p "$dir"
  if [ -f "${dir}/package.json" ]; then
    cp "${dir}/package.json" "${dir}/package.json.bak-$(date +%s)"
    warn "profile ${name} đã có — đã sao lưu package.json cũ"
  fi
  printf '%s\n' "$manifest" > "${dir}/package.json"
  # PHẢI dùng pnpm, không phải npm: `link:` là cú pháp của pnpm và npm từ chối
  # thẳng với EUNSUPPORTEDPROTOCOL. `dsh plugin` cũng chuyển tiếp sang pnpm.
  ( cd "$dir" && pnpm install --silent >/dev/null 2>&1 ) \
    || warn "pnpm install trong profile ${name} thất bại"
  ok "profile ${name}"
}

write_profile headless "$(cat <<EOF
{
  "name": "dsh-profile-headless",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } }
}
EOF
)"

# TUI dùng gói seekarkan NẰM TRONG kho này (link:), nên sửa nguồn là thấy ngay
# sau khi build lại, không phải đóng gói tarball.
write_profile tui "$(cat <<EOF
{
  "name": "dsh-profile-tui",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "seekarkan"] } },
  "dependencies": { "seekarkan": "link:${INSTALL_DIR}/tui/seekarkan" }
}
EOF
)"

# ── 6. Khung credential ─────────────────────────────────────────────────────
say "Khung credential"

CRED="${DSH_HOME}/.credentials.yaml"
if [ -f "$CRED" ]; then
  ok "đã có ${CRED}, không đụng tới"
else
  cat > "$CRED" <<'EOF'
version: 1
refs:
  # Điền khoá thật vào đây. Tệp này KHÔNG bao giờ nên đi vào git.
  # VERTEX_KEY_API_KEY: <khoá của bạn>
EOF
  chmod 600 "$CRED"
  ok "đã tạo ${CRED} (rỗng, quyền 600)"
fi

# ── 7. Kiểm chứng ───────────────────────────────────────────────────────────
say "Kiểm chứng"

VERSION="$("${BIN_DIR}/dsh" --version 2>&1 | head -1)" || die "dsh --version không chạy."
ok "dsh --version -> ${VERSION}"

for p in headless tui; do
  if err="$("${BIN_DIR}/dsh" --profile "$p" --dump-config 2>&1 >/dev/null)"; then
    ok "profile ${p} compose được"
  else
    # In nguyên văn lỗi. Đoán nguyên nhân ở đây chỉ khiến người ta đi sai hướng.
    warn "profile ${p} chưa compose được:"
    echo "$err" | grep -m1 -E 'Error|error' | sed 's/^/       /'
  fi
done

say "Xong"
cat <<EOF
   Còn hai việc phải làm bằng tay, vì chúng cần quyết định của bạn:

   1. Thêm route model vào ${DSH_HOME}/profiles/<tên>/cordis.patch.yml
      Chưa có route thì dsh không gọi được model nào. Xem
      install/README.md để biết khuôn tối thiểu.

   2. Điền khoá vào ${CRED}

   Mở TUI:   SEEKARKAN_LANG=vi dsh --profile tui
   Lưu ý biến ngôn ngữ KHÔNG phải TAD_LANG dù giao diện tên là TAD.
   Không đặt thì giao diện ra tiếng Trung.
EOF
