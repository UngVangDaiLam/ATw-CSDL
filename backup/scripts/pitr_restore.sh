#!/usr/bin/env bash
# =============================================================================
# pitr_restore.sh - LỚP 4: Point-In-Time Recovery trên database ĐANG CHẠY.
#
#   bash backup/scripts/pitr_restore.sh "2026-09-26 14:30:00+07"          (hỏi xác nhận)
#   bash backup/scripts/pitr_restore.sh "2026-09-26 14:30:00+07" --yes
#
# Đưa TOÀN BỘ cluster về trạng thái tại thời điểm chỉ định. Mọi giao dịch
# commit SAU thời điểm đó bị bỏ - kể cả những dòng trong audit.alerts. Log
# pgAudit trong ./logs/ vẫn còn nguyên vì nằm ngoài database.
#
# Các bước:
#   1. flush_wal      - đẩy nốt WAL đang ghi dở ra kho archive
#   2. chọn base backup mới nhất hoàn tất TRƯỚC thời điểm cần khôi phục
#   3. dừng postgres
#   4. container pitr-restore: cất data cũ vào backup/full/pre_pitr_*.tar.gz,
#      giải nén base backup, kiểm tra với backup_manifest, ghi cấu hình recovery
#   5. khởi động postgres -> tự replay WAL từ archive tới thời điểm đích -> promote
#   6. xóa cấu hình recovery khỏi postgresql.auto.conf
#
# Sau khi promote, cluster sang TIMELINE mới (00000002..., 00000003...). WAL
# của timeline cũ trong kho archive vẫn giữ nguyên và không bị ghi đè vì khác
# tên - nên vẫn khôi phục lại được về thời điểm SAU sự cố nếu chọn nhầm.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.." || exit 1

TARGET="${1:-}"
YES=""; [ "${2:-}" = "--yes" ] && YES=1

if [ -z "$TARGET" ]; then
    echo "Cach dung: bash backup/scripts/pitr_restore.sh \"YYYY-MM-DD HH:MM:SS[+07]\" [--yes]"
    exit 1
fi
# Chuỗi này được chép vào postgresql.auto.conf nằm giữa hai dấu nháy đơn -
# chỉ chấp nhận đúng dạng thời gian, không cho lọt dấu nháy hay ký tự lạ.
if ! printf '%s' "$TARGET" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?([+-][0-9]{2}(:?[0-9]{2})?)?$'; then
    echo "LOI: thoi diem khong dung dinh dang: $TARGET"; exit 1
fi

[ -f .env ] || { echo "Khong tim thay .env"; exit 1; }
set -a; . ./.env; set +a
. backup/scripts/lib.sh

# Không ghi múi giờ thì hiểu theo `timezone` của server (Asia/Ho_Chi_Minh) -
# chính server cũng sẽ hiểu recovery_target_time theo cách đó.
TARGET_EPOCH=$(_su "SELECT floor(extract(epoch FROM '$TARGET'::timestamptz))::bigint;")
NOW_EPOCH=$(_su "SELECT floor(extract(epoch FROM now()))::bigint;")
TARGET_SHOW=$(_su "SELECT '$TARGET'::timestamptz;")
if [ "$TARGET_EPOCH" -ge "$NOW_EPOCH" ]; then
    echo "LOI: $TARGET_SHOW chua xay ra - khong khoi phuc ve tuong lai duoc."; exit 1
fi

BASE=$(pick_base "$TARGET_EPOCH")
if [ -z "$BASE" ]; then
    echo "LOI: khong co base backup nao hoan tat truoc $TARGET_SHOW."
    echo "     PITR chi quay ve duoc cac thoi diem SAU mot lan full_backup.sh."
    exit 1
fi

echo "Thoi diem khoi phuc : $TARGET_SHOW"
echo "Base backup         : backup/full/$BASE ($(sed -n 's/^STOP_TIME=//p' "backup/full/$BASE/backup_info"))"
echo "Timeline hien tai   : $(timeline)"
if [ -z "$YES" ]; then
    echo "Moi giao dich sau thoi diem tren se BI MAT (data hien tai duoc cat vao backup/full/pre_pitr_*)."
    if [ -t 0 ]; then
        read -r -p "Tiep tuc? [y/N] " a
        case "$a" in [yY]*) ;; *) echo "Da huy."; exit 1 ;; esac
    else
        echo "Chay khong tuong tac - them --yes de xac nhan."; exit 1
    fi
fi

echo "==> [1/5] Day WAL con lai ra kho archive"
echo "    segment cuoi: $(flush_wal)"

echo "==> [2/5] Dung postgres"
docker compose stop postgres

echo "==> [3/5] Dung lai data directory tu base backup"
docker compose run --rm -T pitr-restore -s -- live "$BASE" "$TARGET" < backup/scripts/_restore_inner.sh

echo "==> [4/5] Khoi dong postgres - replay WAL toi $TARGET_SHOW"
docker compose up -d postgres
DONE=""
for _ in $(seq 1 90); do
    if [ "$(_su 'SELECT pg_is_in_recovery();' 2>/dev/null)" = f ]; then DONE=1; break; fi
    sleep 2
done
if [ -z "$DONE" ]; then
    echo "LOI: postgres chua ra khoi recovery sau 180s. Xem log moi nhat trong ./logs/"
    echo "     Data truoc khi khoi phuc da cat o backup/full/pre_pitr_*.tar.gz"
    exit 1
fi

echo "==> [5/5] Xoa cau hinh recovery khoi postgresql.auto.conf"
# Để lại thì vô hại lúc này (recovery.signal đã bị xóa khi promote), nhưng
# lần PITR sau sẽ ghi chồng thêm một bộ tham số nữa vào cùng file.
_su "ALTER SYSTEM RESET restore_command;" >/dev/null
_su "ALTER SYSTEM RESET recovery_target_time;" >/dev/null
_su "ALTER SYSTEM RESET recovery_target_action;" >/dev/null
_su "SELECT pg_reload_conf();" >/dev/null

# Chờ TCP như reset.sh - app/analyzer kết nối qua đường này.
for _ in $(seq 1 30); do
    docker compose exec -T postgres pg_isready -h 172.28.0.10 -p 5432 -q 2>/dev/null && break
    sleep 1
done

echo "==> Xong. Da khoi phuc ve $TARGET_SHOW"
echo "    Timeline moi : $(timeline)"
