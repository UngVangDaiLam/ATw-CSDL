#!/usr/bin/env bash
# =============================================================================
# quickstart.sh - Một lệnh từ lúc vừa clone/pull đến lúc nghiệm thu xong.
#
#   bash scripts/quickstart.sh          (hỏi xác nhận trước khi xóa dữ liệu cũ)
#   bash scripts/quickstart.sh --yes    (không hỏi)
#   bash scripts/quickstart.sh --no-verify   (chỉ dựng, bỏ qua verify.sh)
#
# Trên Windows có thể bấm đúp quickstart.bat ở gốc repo thay cho lệnh này.
#
# Làm lần lượt:
#   1. Kiểm tra Docker đang chạy.
#   2. Chưa có .env -> sinh từ .env.example, thay mọi mật khẩu mẫu bằng chuỗi
#      ngẫu nhiên. Đã có .env thì GIỮ NGUYÊN.
#   3. scripts/reset.sh  (dọn volume/WAL/log, sinh secrets/, build, chờ init xong)
#   4. scripts/verify.sh (129 phép thử)
#   5. In địa chỉ app/dashboard và tài khoản demo.
#
# Không cần cài Node trên máy: app, analyzer, dashboard đều chạy trong Docker.
# Luôn dựng lại từ số 0 vì sau một lần pull có thể đã đổi postgres/init/ - mà
# các file đó chỉ chạy khi volume còn trống (CLAUDE.md "Bẫy 1").
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

YES=""; VERIFY=1
for a in "$@"; do
    case "$a" in
        --yes|-y)    YES="--yes" ;;
        --no-verify) VERIFY="" ;;
        *) echo "Tham so khong hop le: $a"; exit 2 ;;
    esac
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die()  { printf '\n\033[1;31mLOI:\033[0m %s\n' "$1"; exit 1; }

# -----------------------------------------------------------------------------
step "1/4 Kiem tra Docker"
command -v docker >/dev/null 2>&1 || die "Khong tim thay lenh docker - cai Docker Desktop truoc."
docker info >/dev/null 2>&1 || die "Docker chua chay - mo Docker Desktop, doi bieu tuong chuyen xanh roi chay lai."
docker compose version >/dev/null 2>&1 || die "Thieu 'docker compose' (can Docker Desktop ban moi)."
echo "  Docker OK"

# -----------------------------------------------------------------------------
step "2/4 Chuan bi .env"
if [ -f .env ]; then
    echo "  .env da co - giu nguyen"
else
    [ -f .env.example ] || die "Khong tim thay .env.example."
    # Hex: không có ký tự đặc biệt nên an toàn trong URL kết nối postgresql://
    # mà verify.sh và các script khác tự ghép.
    rand_pw() {
        if command -v openssl >/dev/null 2>&1; then openssl rand -hex 16
        else head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
    }
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        case "$line" in
            *=doi_mat_khau_nay_*) printf '%s=%s\n' "${line%%=*}" "$(rand_pw)" ;;
            *)                    printf '%s\n' "$line" ;;
        esac
    done < .env.example > .env
    chmod 600 .env 2>/dev/null || true
    echo "  Da tao .env voi mat khau ngau nhien (xem trong file .env neu can)"
fi

# -----------------------------------------------------------------------------
step "3/4 Dung lab tu so 0 (mat 2-5 phut, lan dau build lau hon)"
bash scripts/reset.sh $YES || die "reset.sh that bai - xem thong bao phia tren."

# -----------------------------------------------------------------------------
VERIFY_RC=0
if [ -n "$VERIFY" ]; then
    step "4/4 Nghiem thu (scripts/verify.sh)"
    bash scripts/verify.sh; VERIFY_RC=$?
else
    step "4/4 Bo qua nghiem thu (--no-verify)"
fi

# -----------------------------------------------------------------------------
set -a; . ./.env; set +a
cat <<EOF

=============================================================
  App web     http://127.0.0.1:${APP_HOST_PORT:-3000}
              dang nhap: hn01 / dn01 / hcm01, mat khau Demo@123456
  Dashboard   http://127.0.0.1:${DASHBOARD_HOST_PORT:-4000}
  pgAdmin     http://localhost:8081   (${PGADMIN_EMAIL:-xem .env})

  Demo tan cong:  bash scripts/demo-attack.sh
  Demo PITR:      bash backup/scripts/full_backup.sh && bash backup/scripts/demo_pitr.sh
  Tat lab:        docker compose stop
=============================================================
EOF
[ "$VERIFY_RC" -eq 0 ] || { echo "verify.sh co phep thu TRUOT - xem output phia tren."; exit 1; }
