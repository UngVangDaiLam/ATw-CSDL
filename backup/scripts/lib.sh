# shellcheck shell=bash
# =============================================================================
# lib.sh - hàm dùng chung cho pitr_restore.sh, demo_pitr.sh và verify.sh.
# Nạp bằng `. backup/scripts/lib.sh` SAU KHI đã cd về gốc repo và nạp .env.
# =============================================================================

export MSYS_NO_PATHCONV=1

_su() { docker compose exec -T -u postgres postgres psql -X -d "$POSTGRES_DB" -tAc "$1"; }

# pick_base <epoch>
# In tên base backup MỚI NHẤT đã hoàn tất trước <epoch>. Không có thì in rỗng.
# Base backup kết thúc sau thời điểm cần khôi phục thì vô dụng: nó đã chứa
# những thay đổi mà ta đang muốn quay lui.
pick_base() {
    local target="$1" best="" best_epoch=0 f STOP_EPOCH
    for f in backup/full/*/backup_info; do
        [ -f "$f" ] || continue
        STOP_EPOCH=$(sed -n 's/^STOP_EPOCH=//p' "$f" | tr -d '\r')
        if [ "$STOP_EPOCH" -le "$target" ] && [ "$STOP_EPOCH" -gt "$best_epoch" ]; then
            best_epoch="$STOP_EPOCH"; best="$(basename "$(dirname "$f")")"
        fi
    done
    printf '%s' "$best"
}

# flush_wal
# Đóng segment WAL đang ghi dở và chờ nó xuất hiện trong kho archive. Chạy
# trước mỗi lần khôi phục: WAL chưa archive thì recovery không thấy, và PITR
# chỉ tới được thời điểm của segment cuối cùng đã archive.
#
# Phải ghi một bản ghi WAL trước khi switch: pg_switch_wal() không làm gì nếu
# segment hiện tại còn trống, khi đó không có file nào để chờ.
flush_wal() {
    local wal
    wal=$(_su "SELECT pg_logical_emit_message(true,'pitr','flush'); SELECT pg_walfile_name(pg_switch_wal());" | tail -1)
    for _ in $(seq 1 30); do
        [ -f "backup/wal_archive/$wal" ] && { printf '%s' "$wal"; return 0; }
        sleep 1
    done
    echo "LOI: segment $wal chua duoc archive sau 30s" >&2
    return 1
}

# timeline - số timeline hiện tại, đọc từ 8 ký tự hex đầu của tên segment WAL.
# Tăng thêm 1 sau mỗi lần PITR promote.
timeline() { _su "SELECT ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8))::bit(32)::int;"; }
