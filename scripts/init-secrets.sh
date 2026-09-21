#!/usr/bin/env bash
# =============================================================================
# init-secrets.sh - Sinh khóa mã hóa và pepper cho lớp 2.
#
#   bash scripts/init-secrets.sh          (không ghi đè nếu đã có)
#   bash scripts/init-secrets.sh --force  (sinh khóa mới - xem cảnh báo dưới)
#
# Hai file được tạo trong ./secrets/ và mount vào container database qua khối
# `secrets:` của docker-compose.yml, xuất hiện ở /run/secrets/ bên trong
# container. Thư mục ./secrets/ đã nằm trong .gitignore.
#
# VÌ SAO KHÔNG ĐỂ TRONG .env:
# biến trong .env được nạp thành environment của container, nên `docker inspect`
# hay /proc/<pid>/environ đều đọc được. Docker secret là file riêng, không nằm
# trong environment, và trong môi trường Swarm thì nằm hẳn trên tmpfs.
#
# VÌ SAO KHÔNG ĐỂ TRONG DATABASE:
# khóa nằm cùng chỗ với dữ liệu đã mã hóa thì việc mã hóa mất hết ý nghĩa -
# ai lấy được bản dump là có luôn khóa để giải mã.
#
# CẢNH BÁO VỀ --force:
# pgp_sym_encrypt gắn chặt với khóa đang dùng. Sinh khóa mới mà dữ liệu cũ vẫn
# còn thì toàn bộ cccd và card_token cũ KHÔNG giải mã được nữa, và blind index
# cũ cũng không tra cứu được. Đổi khóa phải đi kèm dựng lại lab
# (bash scripts/reset.sh) hoặc một quy trình mã hóa lại toàn bộ dữ liệu.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

FORCE="${1:-}"
mkdir -p secrets

# openssl có sẵn trong Git Bash trên Windows; nếu không thì dùng /dev/urandom.
gen_key() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 48 | tr -d '\n='
    else
        head -c 48 /dev/urandom | base64 | tr -d '\n='
    fi
}

make_secret() {
    local path="$1" desc="$2"
    if [ -s "$path" ] && [ "$FORCE" != "--force" ]; then
        echo "  giu nguyen  $path ($desc - da ton tai)"
        return
    fi
    if [ -s "$path" ]; then
        echo "  GHI DE      $path ($desc)"
    else
        echo "  tao moi     $path ($desc)"
    fi
    # printf chứ không phải echo: KHÔNG được có ký tự xuống dòng ở cuối.
    # Thừa một '\n' là ra một khóa khác và dữ liệu cũ không giải mã được.
    printf '%s' "$(gen_key)" > "$path"
    chmod 600 "$path" 2>/dev/null || true
}

echo "==> Sinh secret vao ./secrets/"
make_secret secrets/pgcrypto_key "khoa ma hoa pgp_sym_encrypt"
make_secret secrets/cccd_pepper  "pepper cho blind index HMAC"

echo
echo "Xong. Kiem tra (KHONG in ra noi dung khoa):"
for f in secrets/pgcrypto_key secrets/cccd_pepper; do
    printf '  %-26s %s byte\n' "$f" "$(wc -c < "$f" | tr -d ' ')"
done
