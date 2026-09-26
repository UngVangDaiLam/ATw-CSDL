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
