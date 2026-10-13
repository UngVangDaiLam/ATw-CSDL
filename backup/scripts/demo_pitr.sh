#!/usr/bin/env bash
# =============================================================================
# demo_pitr.sh - LỚP 4: kịch bản demo "xóa nhầm dữ liệu -> khôi phục về thời
# điểm trước sự cố".
#
#   bash backup/scripts/demo_pitr.sh          (dừng chờ Enter giữa các bước)
#   bash backup/scripts/demo_pitr.sh --yes    (chạy một mạch)
#
# CẢNH BÁO: script THỰC SỰ xóa app.orders + app.payments rồi khôi phục bằng
# PITR trên database đang chạy. Mọi thay đổi khác trong vài giây đó cũng mất.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.." || exit 1

AUTO=""; [ "${1:-}" = "--yes" ] && AUTO=1

[ -f .env ] || { echo "Khong tim thay .env"; exit 1; }
set -a; . ./.env; set +a
. backup/scripts/lib.sh

APP_URL="postgresql://app_user:${APP_USER_PASSWORD}@172.28.0.10:5432/secdb"

step()  { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
pause() { [ -n "$AUTO" ] || [ ! -t 0 ] || read -r -p "   (Enter de tiep tuc) " _; }
counts() {
    _su "SELECT 'orders = ' || (SELECT count(*) FROM app.orders)
             || ', payments = ' || (SELECT count(*) FROM app.payments)
             || ', tong tien = ' || (SELECT coalesce(sum(total_amount), 0) FROM app.orders);"
}

step "0. Chuan bi: can mot base backup hoan tat TRUOC thoi diem se khoi phuc"
if [ -z "$(pick_base "$(_su 'SELECT floor(extract(epoch FROM now()))::bigint;')")" ]; then
    bash backup/scripts/full_backup.sh
else
    echo "   Da co base backup: $(ls -d backup/full/*/backup_info | tail -1 | xargs dirname)"
fi

step "1. Trang thai ban dau"
BEFORE=$(counts)
echo "   $BEFORE"
pause

step "2. Ghi lai thoi diem T - moc se khoi phuc ve"
T=$(_su "SELECT now()::text;")
echo "   T = $T"
# Moc do RPO: so dong tai T, va ma giao dich (xid) ngay sau T. Moi giao dich co
# xid lon hon moc nay la giao dich commit SAU T - PITR se bo chung.
ROWS_Q="SELECT (SELECT count(*) FROM app.customers) + (SELECT count(*) FROM app.orders) + (SELECT count(*) FROM app.payments);"
ROWS_T=$(_su "$ROWS_Q")
XID_T=$(_su "SELECT pg_current_xact_id()::text;")
sleep 2
pause

step "3. Su co: xoa sach don hang"
echo "   3a. Ke tan cong nam duoc app_user thu xoa:"
docker compose exec -T postgres psql "$APP_URL" -tAc 'DELETE FROM app.orders;' 2>&1 | sed 's/^/       /' || true
echo "       -> LOP 1 chan: app_user khong co quyen DELETE."
echo "   3b. Quan tri vien (superuser) go nham lenh:"
_su "BEGIN; DELETE FROM app.payments; DELETE FROM app.orders; COMMIT;" | sed 's/^/       /'
echo "   $(counts)"
echo "   -> Superuser bo qua moi GRANT va RLS. Chi con LOP 4 cuu duoc."
pause

step "4. PITR: khoi phuc ca cluster ve T"
# Chot so do RPO ngay truoc khi khoi phuc: bao nhieu dong, bao nhieu giao dich,
# bao nhieu giay ke tu T se bi quay lui.
ROWS_INCIDENT=$(_su "$ROWS_Q")
XID_END=$(_su "SELECT pg_current_xact_id()::text;")
WINDOW_S=$(_su "SELECT round(extract(epoch FROM now() - '$T'::timestamptz)::numeric, 1);")
PITR_TIMING_FILE="$(mktemp)"; export PITR_TIMING_FILE
bash backup/scripts/pitr_restore.sh "$T" --yes
pause

step "5. Ket qua"
AFTER=$(counts)
echo "   Truoc su co : $BEFORE"
echo "   Sau khoi phuc: $AFTER"
if [ "$BEFORE" = "$AFTER" ]; then
    printf '\n   \033[32mKHOI PHUC THANH CONG - du lieu khop tung dong voi thoi diem T\033[0m\n'
else
    printf '\n   \033[31mKHONG KHOP\033[0m\n'; exit 1
fi

step "6. RTO / RPO thuc do"
ROWS_AFTER=$(_su "$ROWS_Q")
RTO=$(awk -F'\t' '$2 !~ /^\[6\/6\]/ { r += $1 } END { printf "%.1f", r }' "$PITR_TIMING_FILE")
TOTAL=$(awk -F'\t' '{ t += $1 } END { printf "%.1f", t }' "$PITR_TIMING_FILE")
# pg_current_xact_id() tu no tieu mot xid moi lan goi: tru di lan goi lay moc cuoi.
TX_LOST=$(( XID_END - XID_T - 1 ))
ROWS_LOST=$(( ROWS_T - ROWS_AFTER ))
echo "   RTO : ${RTO}s tu luc bat dau khoi phuc toi luc database nhan ket noi tro lai"
echo "         (${TOTAL}s neu tinh ca buoc ghi bu canh bao)"
echo "   RPO : so voi moc T mat $ROWS_LOST dong ($ROWS_T dong tai T, $ROWS_AFTER dong sau khoi phuc)"
echo "         $TX_LOST giao dich commit sau T bi bo (gom ca giao dich su co), cua so ${WINDOW_S}s"

# Ghi ket qua kem dieu kien do. Chay lai script la ghi de.
OUT=docs/recovery-results.md
BASE_USED=$(pick_base "$(_su "SELECT floor(extract(epoch FROM '$T'::timestamptz))::bigint;")")
{
    echo '# Kết quả đo khôi phục (RTO / RPO) — lớp 4'
    echo
    echo '> File này do `backup/scripts/demo_pitr.sh` sinh ra; chạy lại script là ghi đè.'
    echo
    echo '## Điều kiện đo'
    echo
    echo '| Mục | Giá trị |'
    echo '|-----|---------|'
    echo "| Ngày đo | $(_su "SELECT to_char(now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI');") (giờ VN) |"
    echo "| Máy | $(docker info --format '{{.NCPU}} {{.MemTotal}}' | awk '{ printf "%s CPU, %.1f GB RAM cấp cho Docker", $1, $2 / 1073741824 }'); $(docker info --format '{{.OperatingSystem}}') |"
    echo "| PostgreSQL | $(_su 'SHOW server_version;') |"
    echo "| Dữ liệu | $(_su "SELECT (SELECT count(*) FROM app.customers) || ' khách, ' || (SELECT count(*) FROM app.orders) || ' đơn, ' || (SELECT count(*) FROM app.payments) || ' thanh toán; database ' || pg_size_pretty(pg_database_size(current_database()));") |"
    echo "| Base backup dùng | \`backup/full/$BASE_USED\` ($(du -sh "backup/full/$BASE_USED" | cut -f1), đã mã hóa) |"
    echo '| Kịch bản | superuser xóa toàn bộ `app.payments` + `app.orders`, khôi phục cả cluster về mốc T ngay trước đó |'
    echo
    echo '## RTO — thời gian khôi phục'
    echo
    echo '| Bước của `pitr_restore.sh` | Giây |'
    echo '|----------------------------|-----:|'
    awk -F'\t' '{ printf "| %s | %.1f |\n", $2, $1 }' "$PITR_TIMING_FILE"
    echo "| **RTO: bước 1–5, database nhận kết nối trở lại** | **$RTO** |"
    echo "| Tổng, kể cả bước 6 (ghi bù cảnh báo, chạy khi dịch vụ đã lên) | $TOTAL |"
    echo
    echo '## RPO — dữ liệu mất'
    echo
    echo '| Chỉ số | Giá trị |'
    echo '|--------|--------:|'
    echo "| Số dòng (customers + orders + payments) tại mốc T | $ROWS_T |"
    echo "| Số dòng ngay sau sự cố | $ROWS_INCIDENT |"
    echo "| Số dòng sau khôi phục | $ROWS_AFTER |"
    echo "| **Dòng mất so với mốc T** | **$ROWS_LOST** |"
    echo "| Giao dịch commit sau T bị bỏ (gồm cả giao dịch sự cố) | $TX_LOST |"
    echo "| Cửa sổ thời gian bị quay lui (T → lúc bắt đầu khôi phục) | ${WINDOW_S} giây |"
    echo
    echo '## Đọc số đo thế nào'
    echo
    echo '- Kho WAL còn nguyên nên PITR dừng đúng tại T: RPO so với mốc T là số dòng mất ở bảng trên.'
    echo '  Cái giá là mọi giao dịch commit **sau** T cũng bị bỏ, kể cả giao dịch hợp lệ — chọn T càng sát sự cố thì mất càng ít.'
    echo '- Số trên đo trường hợp **máy chủ còn, kho WAL còn**. Mất cả máy chủ thì chỉ khôi phục được tới segment WAL cuối cùng đã archive:'
    echo "  \`archive_timeout = $(_su 'SHOW archive_timeout;')\` nên RPO xấu nhất theo cấu hình là chừng đó. Con số này là **cấu hình, chưa đo**."
    echo '- RTO tăng theo kích thước base backup và lượng WAL phải replay từ base backup tới T; số ở đây ứng với khối lượng dữ liệu ở mục điều kiện đo.'
    echo '- Một lần đo, không phải trung bình nhiều lần.'
} > "$OUT"
rm -f "$PITR_TIMING_FILE"
echo "   Da ghi $OUT"
