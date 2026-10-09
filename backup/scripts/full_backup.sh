#!/usr/bin/env bash
# =============================================================================
# full_backup.sh - LỚP 4: sao lưu đầy đủ.
#
#   bash backup/scripts/full_backup.sh
#
# Mỗi lần chạy tạo một thư mục backup/full/<YYYYMMDD_HHMMSS>/ gồm:
#
#   base.tar.gz.gpg    pg_basebackup - bản sao VẬT LÝ của cả cluster. Đây là
#   pg_wal.tar.gz.gpg  điểm xuất phát của PITR: khôi phục = giải mã, giải nén
#   backup_manifest    rồi replay WAL từ backup/wal_archive/ tới thời điểm mong
#                      muốn. backup_manifest chứa checksum từng file để kiểm
#                      tra toàn vẹn sau khi giải mã.
#
#   secdb.dump.gpg     pg_dump -Fc - bản sao LOGIC của database secdb. Không dùng
#                      cho PITR được, nhưng khôi phục riêng một bảng hay chuyển
#                      sang máy/phiên bản khác thì chỉ bản này làm được.
#
#   backup_info        thời điểm backup HOÀN TẤT. pitr_restore.sh dựa vào đây
#                      để chọn base backup: chỉ khôi phục được về thời điểm SAU
#                      khi base backup kết thúc.
#
# MÃ HÓA (postgres/backup-crypt.sh): mọi file chứa dữ liệu đều là .gpg, khóa
# sao lưu riêng ở Docker secret backup_key. CCCD/số thẻ bên trong còn là
# ciphertext của lớp 2 - hai lớp, hai khóa độc lập. Chỉ backup_manifest (tên
# file + checksum) và backup_info (mốc thời gian) để rõ: không chứa dữ liệu,
# và pitr_restore.sh cần đọc chúng mà không cần khóa.
#
# pg_basebackup ghi vào /tmp TRONG container, mã hóa xong mới đưa sang
# /backup/full (bind mount ra host) - bản rõ không bao giờ chạm đĩa của host.
# Đọc lại bản dump:
#   docker compose exec -T postgres backup-crypt.sh decrypt /backup/full/<ten>/secdb.dump.gpg - | pg_restore -l
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

# Thư mục tạm TRONG container (không phải bind mount): bản rõ chỉ nằm ở đây.
TMP="/tmp/basebackup_$NAME"
cleanup() { pg rm -rf "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> pg_basebackup -> (tam trong container) -> ma hoa -> backup/full/$NAME/"
# -Ft -z      : tar nén gzip - một file thay vì hàng nghìn file nhỏ trên bind mount Windows
# -X stream   : kèm luôn WAL sinh ra TRONG LÚC backup, nên bản này tự nhất quán
#               được kể cả khi kho archive có vấn đề
# --checkpoint=fast : không chờ checkpoint định kỳ (mặc định có thể tới 5 phút)
pg pg_basebackup -D "$TMP" -Ft -z -X stream --checkpoint=fast -l "secdb $NAME"
pg mkdir -p "$DIR"
pg backup-crypt.sh encrypt "$TMP/base.tar.gz"   "$DIR/base.tar.gz.gpg"
pg backup-crypt.sh encrypt "$TMP/pg_wal.tar.gz" "$DIR/pg_wal.tar.gz.gpg"
pg cp "$TMP/backup_manifest" "$DIR/backup_manifest"
cleanup

# Làm tròn LÊN tới giây: pitr_restore.sh so sánh với thời điểm khôi phục làm
# tròn XUỐNG, nên phép so sánh không bao giờ chọn nhầm một base backup kết thúc
# sau thời điểm cần khôi phục.
STOP_EPOCH=$(sql_su "SELECT ceil(extract(epoch FROM now()))::bigint;")
STOP_TIME=$(sql_su "SELECT now()::timestamptz(0);")

echo "==> pg_dump -Fc | ma hoa -> backup/full/$NAME/secdb.dump.gpg"
# Đi thẳng qua pipe: bản dump rõ không được ghi ra file ở đâu cả.
pg bash -c "set -o pipefail; pg_dump -d '$POSTGRES_DB' -Fc | backup-crypt.sh encrypt - '$DIR/secdb.dump.gpg'"
# Giải mã + đọc được mục lục thì file dump không bị cắt cụt và khóa đúng.
N_TABLES=$(pg bash -c "backup-crypt.sh decrypt '$DIR/secdb.dump.gpg' - | pg_restore -l" | grep -c ' TABLE DATA ' || true)
[ "$N_TABLES" -gt 0 ] || { echo "LOI: khong doc lai duoc ban dump vua ma hoa"; exit 1; }

printf 'STOP_EPOCH=%s\nSTOP_TIME=%s\n' "$STOP_EPOCH" "$STOP_TIME" > "backup/full/$NAME/backup_info"

echo "==> Xong: backup/full/$NAME/  (hoan tat luc $STOP_TIME, dump co $N_TABLES bang)"
ls -lh "backup/full/$NAME/" | tail -n +2
