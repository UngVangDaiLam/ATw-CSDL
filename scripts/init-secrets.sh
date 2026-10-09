#!/usr/bin/env bash
# =============================================================================
# init-secrets.sh - Sinh khóa mã hóa và pepper cho lớp 2.
#
#   bash scripts/init-secrets.sh          (không ghi đè nếu đã có)
#   bash scripts/init-secrets.sh --force  (sinh khóa mới - xem cảnh báo dưới)
#   bash scripts/init-secrets.sh --force-tls  (chỉ cấp lại chứng chỉ TLS, an toàn
#                                              với dữ liệu - xem cuối file)
#
# Ngoài khóa mã hóa còn sinh bộ chứng chỉ TLS cho kết nối tới database.
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
# Khoa ky cookie phien cua app/. Doi khoa nay chi lam moi nguoi phai dang nhap
# lai - khong anh huong du lieu, khac voi hai khoa tren.
make_secret secrets/session_secret "khoa ky cookie phien cua app/"
# Khoa ma hoa ban sao luu + WAL archive (postgres/backup-crypt.sh). RIENG voi
# pgcrypto_key: lo mot khoa khong mo duoc ca hai lop. --force sinh khoa moi thi
# MOI ban sao luu va segment WAL cu khong giai ma duoc nua - cung nhu pgcrypto_key,
# chi doi kem reset.sh. Ngoai lab phai cat mot ban khoa nay o noi khac may chu.
make_secret secrets/backup_key "khoa ma hoa ban sao luu va WAL archive"

# -----------------------------------------------------------------------------
# TLS giữa client và database (lớp 1a). Một CA riêng của lab ký chứng chỉ cho
# server; client tin ĐÚNG CA này (tương đương sslmode=verify-full), nên kẻ xen
# giữa tự ký chứng chỉ khác sẽ bị từ chối chứ không chỉ "có mã hóa".
#
#   tls_ca.crt      - công khai, mount cho app/analyzer/dashboard
#   tls_server.crt  - chứng chỉ server, SAN gồm mọi tên client dùng để gọi
#   tls_server.key  - CHỈ mount vào container postgres
#
# Khóa CA bị XÓA ngay sau khi ký: không có nó thì kể cả ai đọc được secrets/
# cũng không ký thêm được chứng chỉ giả mà client tin. Cần cấp lại thì sinh
# lại cả bộ (đổi CA không ảnh hưởng dữ liệu - khác với pgcrypto_key).
#
# Đổi chứng chỉ không cần reset.sh, chỉ cần tạo lại container:
#   bash scripts/init-secrets.sh --force-tls && docker compose up -d --force-recreate
# -----------------------------------------------------------------------------
# Git Bash đổi "/CN=..." thành đường dẫn Windows trước khi gọi openssl.exe.
export MSYS_NO_PATHCONV=1
TLS_FILES="secrets/tls_ca.crt secrets/tls_server.crt secrets/tls_server.key"

tls_complete() { for f in $TLS_FILES; do [ -s "$f" ] || return 1; done; }

if tls_complete && [ "$FORCE" != "--force" ] && [ "$FORCE" != "--force-tls" ]; then
    echo "  giu nguyen  chung chi TLS (da ton tai)"
else
    command -v openssl >/dev/null 2>&1 || { echo "LOI: can openssl de sinh chung chi TLS (co san trong Git Bash)."; exit 1; }
    echo "  tao moi     chung chi TLS (CA rieng cua lab + chung chi server)"
    # Đường dẫn TƯƠNG ĐỐI, không dùng mktemp: openssl.exe trên Windows không
    # hiểu /tmp của Git Bash (MSYS_NO_PATHCONV ở trên đã tắt việc chuyển đổi).
    work="secrets/.tls-work"
    rm -rf "$work"; mkdir -p "$work"
    trap 'rm -rf "$work"' EXIT
    # EC P-256: nhỏ, nhanh, mọi client TLS 1.3 đều hỗ trợ.
    openssl req -x509 -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
        -keyout "$work/ca.key" -out secrets/tls_ca.crt -days 3650 \
        -subj "/O=SecDB Lab/CN=SecDB Lab CA" \
        -addext "basicConstraints=critical,CA:TRUE" \
        -addext "keyUsage=critical,keyCertSign,cRLSign"
    openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
        -keyout secrets/tls_server.key -out "$work/server.csr" \
        -subj "/O=SecDB Lab/CN=secdb-postgres"
    # SAN phải phủ mọi cách client gọi tới server: IP dbnet (app/analyzer/
    # dashboard trong Docker), tên service, và localhost khi chạy tay trên host
    # qua cổng 15432. Thiếu tên nào thì client verify-full đi bằng tên đó bị từ chối.
    cat > "$work/server.ext" <<'EOF'
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:secdb-postgres,DNS:postgres,DNS:localhost,IP:172.28.0.10,IP:127.0.0.1,IP:::1
EOF
    openssl x509 -req -in "$work/server.csr" -CA secrets/tls_ca.crt -CAkey "$work/ca.key" \
        -set_serial "0x$(openssl rand -hex 16)" \
        -out secrets/tls_server.crt -days 825 -extfile "$work/server.ext"
    rm -rf "$work"; trap - EXIT
    chmod 600 secrets/tls_server.key 2>/dev/null || true
    openssl verify -CAfile secrets/tls_ca.crt secrets/tls_server.crt >/dev/null \
        || { echo "LOI: chung chi server khong xac minh duoc bang CA vua sinh."; exit 1; }
fi

echo
echo "Xong. Kiem tra (KHONG in ra noi dung khoa):"
for f in secrets/pgcrypto_key secrets/cccd_pepper secrets/session_secret secrets/backup_key $TLS_FILES; do
    printf '  %-26s %s byte\n' "$f" "$(wc -c < "$f" | tr -d ' ')"
done
