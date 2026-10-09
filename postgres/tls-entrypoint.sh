#!/usr/bin/env bash
# =============================================================================
# tls-entrypoint.sh - Chép chứng chỉ TLS vào chỗ PostgreSQL chịu đọc, rồi
# chuyển cho docker-entrypoint.sh gốc của image.
#
# VÌ SAO KHÔNG trỏ ssl_key_file thẳng vào /run/secrets/:
# PostgreSQL từ chối khởi động nếu file khóa riêng không thuộc chủ postgres với
# quyền 0600 (hoặc thuộc root với 0640) - "private key file has group or world
# access". Docker secret ngoài Swarm là bind mount, mang nguyên quyền của file
# trên host; trên Docker Desktop/Windows nó hiện ra là root 0777. Nên phải chép
# sang một chỗ khác và tự đặt quyền.
#
# Chạy bằng root (mặc định của image postgres) mỗi lần container khởi động,
# trước cả temp server của init: ssl = on có hiệu lực ngay từ lần đầu.
# =============================================================================
set -euo pipefail

SRC_CRT=/run/secrets/pg_server_crt
SRC_KEY=/run/secrets/pg_server_key
DST=/etc/postgresql/tls

for f in "$SRC_CRT" "$SRC_KEY"; do
    if [ ! -s "$f" ]; then
        echo "FATAL: thieu $f - chay 'bash scripts/init-secrets.sh' tren host roi tao lai container." >&2
        exit 1
    fi
done

install -d -o postgres -g postgres -m 0700 "$DST"
install -o postgres -g postgres -m 0644 "$SRC_CRT" "$DST/server.crt"
install -o postgres -g postgres -m 0600 "$SRC_KEY" "$DST/server.key"

exec docker-entrypoint.sh "$@"
