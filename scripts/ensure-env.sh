#!/usr/bin/env bash
# =============================================================================
# ensure-env.sh - Bảo đảm .env có đủ mọi biến mà .env.example khai báo.
#
#   bash scripts/ensure-env.sh
#
#   - Chưa có .env      -> sinh từ .env.example, mọi mật khẩu mẫu
#                          (doi_mat_khau_nay_*) thay bằng chuỗi ngẫu nhiên.
#   - Đã có .env        -> GIỮ NGUYÊN mọi giá trị đang có; chỉ THÊM những biến
#                          mới xuất hiện trong .env.example (vd. DEV_PASSWORD
#                          sau một lần pull), mật khẩu mẫu cũng thay bằng
#                          chuỗi ngẫu nhiên.
#
# Không bao giờ sửa hay ghi đè một dòng đã có trong .env: đổi mật khẩu của role
# đã tạo trong database mà không reset sẽ làm app/analyzer/dashboard không kết
# nối được nữa.
#
# reset.sh và quickstart.sh tự gọi script này, nên sau khi pull chỉ cần chạy
# một trong hai như mọi khi.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

[ -f .env.example ] || { echo "LOI: khong tim thay .env.example"; exit 1; }

# Hex: không có ký tự đặc biệt nên an toàn trong URL kết nối postgresql://
# mà verify.sh và các script khác tự ghép.
rand_pw() {
    if command -v openssl >/dev/null 2>&1; then openssl rand -hex 16
    else head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

# Một dòng của .env.example -> dòng đưa vào .env (mật khẩu mẫu -> ngẫu nhiên)
render() {
    case "$1" in
        *=doi_mat_khau_nay_*) printf '%s=%s\n' "${1%%=*}" "$(rand_pw)" ;;
        *)                    printf '%s\n' "$1" ;;
    esac
}

if [ ! -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        render "${line%$'\r'}"
    done < .env.example > .env
    chmod 600 .env 2>/dev/null || true
    echo "  Da tao .env tu .env.example, mat khau ngau nhien"
    exit 0
fi

# .env đã có: chỉ bổ sung biến còn thiếu.
added=""
while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
        ''|'#'*) continue ;;
        *=*) ;;
        *) continue ;;
    esac
    key="${line%%=*}"
    if ! grep -qE "^[[:space:]]*${key}=" .env; then
        # .env cũ có thể thiếu ký tự xuống dòng ở cuối -> dòng mới dính vào dòng trước
        [ -n "$(tail -c 1 .env)" ] && printf '\n' >> .env
        render "$line" >> .env
        added="$added $key"
    fi
done < .env.example

if [ -n "$added" ]; then
    echo "  Da bo sung vao .env:$added"
    echo "  (bien moi chi co tac dung voi role trong database sau khi dung lai: scripts/reset.sh)"
else
    echo "  .env da du bien - giu nguyen"
fi
