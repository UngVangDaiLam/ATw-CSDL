#!/usr/bin/env bash
# =============================================================================
# _restore_inner.sh - phần chạy BÊN TRONG container của PITR.
#
# Không gọi trực tiếp. pitr_restore.sh và verify.sh đưa file này vào qua stdin:
#   docker compose run --rm -T pitr-restore -s -- live    <base> <target>
#   docker compose run --rm -T pitr-sandbox -s -- sandbox <base> <target> <db> <sql>
#
# live    : dựng lại volume pgdata THẬT từ base backup rồi ghi cấu hình recovery
#           vào postgresql.auto.conf. Service postgres khởi động lại sau đó sẽ
#           tự replay WAL tới <target> và promote.
# sandbox : dựng vào volume riêng, tự bật một postgres tạm để replay tới
#           <target>, DỪNG ở đó (pause, không promote), chạy <sql> rồi tắt.
#           Không promote nghĩa là không sinh timeline mới, không ghi gì vào
#           kho WAL (vốn đã gắn read-only) - database thật không bị ảnh hưởng.
# =============================================================================
set -euo pipefail

MODE="${1:?thieu MODE}"; BASE="${2:?thieu ten base backup}"; TARGET="${3:?thieu thoi diem}"
PGDATA=/var/lib/postgresql/data
B="/backup/full/$BASE"
RESTORE_CMD='cp /backup/wal_archive/%f %p'

die() { echo "LOI: $*" >&2; exit 1; }

[ -f "$B/base.tar.gz" ]    || die "khong thay $B/base.tar.gz"
[ -f "$B/pg_wal.tar.gz" ]  || die "khong thay $B/pg_wal.tar.gz"
[ -f "$B/backup_manifest" ] || die "khong thay $B/backup_manifest"

if [ "$MODE" = live ]; then
    # postmaster.pid còn đó nghĩa là server chưa tắt sạch - ghi đè data
    # directory của một server đang chạy là hỏng cluster.
    [ ! -f "$PGDATA/postmaster.pid" ] || die "postgres chua dung han (con postmaster.pid)"
    # Lưới an toàn: cất data directory hiện tại trước khi xóa. Chọn nhầm thời
    # điểm khôi phục thì vẫn còn đường quay lại. Bỏ pg_wal vì WAL đã nằm
    # trong kho archive.
    SAVE="/backup/full/pre_pitr_$(TZ=Asia/Ho_Chi_Minh date +%Y%m%d_%H%M%S).tar.gz"
    echo "--> Cat data directory hien tai vao $SAVE"
    tar czf "$SAVE" --exclude=./pg_wal -C "$PGDATA" .
fi

echo "--> Xoa data directory va giai nen base backup $BASE"
find "$PGDATA" -mindepth 1 -delete
tar xzf "$B/base.tar.gz"   -C "$PGDATA"
tar xzf "$B/pg_wal.tar.gz" -C "$PGDATA/pg_wal"
chown -R postgres:postgres "$PGDATA"
chmod 0700 "$PGDATA"

# Kiểm tra checksum từng file với backup_manifest (và parse được WAL đi kèm)
# TRƯỚC khi ghi cấu hình recovery - sửa postgresql.auto.conf rồi mới kiểm là
# sẽ lệch checksum.
echo "--> Kiem tra toan ven voi backup_manifest"
gosu postgres pg_verifybackup -m "$B/backup_manifest" "$PGDATA"

# recovery.signal: khởi động ở chế độ targeted recovery, lấy WAL bằng
# restore_command cho tới khi chạm recovery_target_time.
touch "$PGDATA/recovery.signal"
chown postgres:postgres "$PGDATA/recovery.signal"

if [ "$MODE" = live ]; then
    # config_file nằm ngoài $PGDATA và nằm trong image, không sửa được ở đây.
    # postgresql.auto.conf thì luôn được đọc từ data directory và đè lên
    # config_file - đúng chỗ để đặt tham số recovery. pitr_restore.sh sẽ
    # ALTER SYSTEM RESET chúng sau khi promote xong.
    cat >> "$PGDATA/postgresql.auto.conf" <<EOF
restore_command = '$RESTORE_CMD'
recovery_target_time = '$TARGET'
recovery_target_action = 'promote'
EOF
    echo "--> Da ghi cau hinh recovery, target = $TARGET"
    exit 0
fi

[ "$MODE" = sandbox ] || die "MODE phai la live hoac sandbox"
DB="${4:?thieu ten database}"; SQL="${5:?thieu cau truy van}"

# archive_mode=off: phòng thủ thêm một lớp ngoài mount read-only - sandbox
# không bao giờ được ghi vào kho WAL của cluster thật.
# listen_addresses='': chỉ socket, container này vốn cũng không có mạng.
echo "--> Bat postgres tam, replay WAL toi $TARGET"
gosu postgres postgres -c config_file=/etc/postgresql/postgresql.conf \
    -c archive_mode=off -c listen_addresses='' \
    -c logging_collector=off -c log_destination=stderr \
    -c restore_command="$RESTORE_CMD" \
    -c recovery_target_time="$TARGET" \
    -c recovery_target_action=pause >/tmp/pg.log 2>&1 &
PG_PID=$!

q() { gosu postgres psql -X -U postgres -d "$1" -tAc "$2"; }

STATE=""
for _ in $(seq 1 120); do
    kill -0 "$PG_PID" 2>/dev/null || { tail -20 /tmp/pg.log >&2; die "postgres tam da thoat"; }
    STATE=$(q postgres "SELECT pg_get_wal_replay_pause_state();" 2>/dev/null || true)
    [ "$STATE" = paused ] && break
    sleep 1
done
[ "$STATE" = paused ] || { tail -20 /tmp/pg.log >&2; die "khong dung duoc tai $TARGET sau 120s"; }

echo "--> Da dung tai giao dich cuoi: $(q postgres 'SELECT pg_last_xact_replay_timestamp();')"
echo "KET_QUA=$(q "$DB" "$SQL")"

gosu postgres pg_ctl -D "$PGDATA" stop -m fast >/dev/null
find "$PGDATA" -mindepth 1 -delete
