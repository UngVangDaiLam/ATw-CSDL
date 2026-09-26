#!/usr/bin/env bash
# =============================================================================
# full_backup.sh - LỚP 4: sao lưu đầy đủ.
#
#   bash backup/scripts/full_backup.sh
#
# Mỗi lần chạy tạo một thư mục backup/full/<YYYYMMDD_HHMMSS>/ gồm:
#
#   base.tar.gz      pg_basebackup - bản sao VẬT LÝ của cả cluster. Đây là
#   pg_wal.tar.gz    điểm xuất phát của PITR: khôi phục = giải nén bản này rồi
#   backup_manifest  replay WAL từ backup/wal_archive/ tới thời điểm mong muốn.
#                    backup_manifest chứa checksum từng file để kiểm tra toàn vẹn.
#
#   secdb.dump       pg_dump -Fc - bản sao LOGIC của database secdb. Không dùng
#                    cho PITR được, nhưng khôi phục riêng một bảng hay chuyển
#                    sang máy/phiên bản khác thì chỉ bản này làm được.
#
#   backup_info      thời điểm backup HOÀN TẤT. pitr_restore.sh dựa vào đây để
#                    chọn base backup: chỉ khôi phục được về thời điểm SAU khi
#                    base backup kết thúc.
#
# Cả hai bản đều chỉ chứa CCCD/số thẻ ở dạng ciphertext - khóa nằm ở Docker
# secret, không nằm trong database (xem phép thử pg_dump trong verify.sh).
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.." || exit 1

# Git Bash tự đổi đối số dạng /backup/... thành C:/Program Files/Git/backup/...
# trước khi chuyển cho docker.exe. Tắt để đường dẫn tới container nguyên vẹn.
export MSYS_NO_PATHCONV=1

[ -f .env ] || { echo "Khong tim thay .env"; exit 1; }
set -a; . ./.env; set +a

# -u postgres: file backup thuộc user postgres trong container, không phải root.
sql_su() { docker compose exec -T -u postgres postgres psql -X -d "$POSTGRES_DB" -tAc "$1"; }
pg()     { docker compose exec -T -u postgres postgres "$@"; }

NAME=$(sql_su "SELECT to_char(now(), 'YYYYMMDD_HH24MISS');")
DIR="/backup/full/$NAME"

echo "==> pg_basebackup -> backup/full/$NAME/"
# -Ft -z      : tar nén gzip - một file thay vì hàng nghìn file nhỏ trên bind mount Windows
# -X stream   : kèm luôn WAL sinh ra TRONG LÚC backup, nên bản này tự nhất quán
#               được kể cả khi kho archive có vấn đề
# --checkpoint=fast : không chờ checkpoint định kỳ (mặc định có thể tới 5 phút)
pg pg_basebackup -D "$DIR" -Ft -z -X stream --checkpoint=fast -l "secdb $NAME"

# Làm tròn LÊN tới giây: pitr_restore.sh so sánh với thời điểm khôi phục làm
# tròn XUỐNG, nên phép so sánh không bao giờ chọn nhầm một base backup kết thúc
# sau thời điểm cần khôi phục.
STOP_EPOCH=$(sql_su "SELECT ceil(extract(epoch FROM now()))::bigint;")
STOP_TIME=$(sql_su "SELECT now()::timestamptz(0);")

echo "==> pg_dump -Fc -> backup/full/$NAME/secdb.dump"
pg pg_dump -d "$POSTGRES_DB" -Fc -f "$DIR/secdb.dump"
# Đọc được mục lục thì file dump không bị cắt cụt giữa chừng.
N_TABLES=$(pg pg_restore -l "$DIR/secdb.dump" | grep -c ' TABLE DATA ' || true)

printf 'STOP_EPOCH=%s\nSTOP_TIME=%s\n' "$STOP_EPOCH" "$STOP_TIME" > "backup/full/$NAME/backup_info"

echo "==> Xong: backup/full/$NAME/  (hoan tat luc $STOP_TIME, dump co $N_TABLES bang)"
ls -lh "backup/full/$NAME/" | tail -n +2
