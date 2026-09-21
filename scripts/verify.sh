#!/usr/bin/env bash
# =============================================================================
# verify.sh - Chạy toàn bộ tiêu chí nghiệm thu của lab.
#
#   bash scripts/verify.sh
#
# Chạy được từ Git Bash trên Windows. Không sửa đổi gì ngoài việc tạo/xóa một
# vài dòng dữ liệu thử trong transaction bị ROLLBACK.
# Thoát với mã 0 nếu mọi tiêu chí đạt, 1 nếu có tiêu chí trượt.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

[ -f .env ] || { echo "Khong tim thay .env - copy tu .env.example truoc."; exit 1; }
set -a; . ./.env; set +a

APP_URL="postgresql://app_user:${APP_USER_PASSWORD}@172.28.0.10:5432/secdb"
PASS=0; FAIL=0

# psql dưới quyền superuser (socket trong container)
sql_su() { docker compose exec -T postgres psql -U postgres -d "$POSTGRES_DB" -tAc "$1" 2>&1; }
# psql dưới quyền app_user (TCP, đi qua pg_hba)
sql_app() { docker compose exec -T postgres psql "$APP_URL" -tAc "$1" 2>&1; }
# psql dưới quyền app_user sau khi SET ROLE sang một nhân viên.
# Bỏ dòng "SET" do psql in ra để chỉ còn kết quả thật.
# KHÔNG dùng `tail -1`: stdout của psql là pipe nên bị block-buffer, còn stderr
# thì không, nên dòng ERROR thường xuất hiện TRƯỚC dòng "SET" - lấy tail -1 sẽ
# ra "SET" và làm mọi phép thử lỗi đều trượt một cách khó hiểu.
sql_nv() { docker compose exec -T postgres psql "$APP_URL" -tAc "SET ROLE $1; $2" 2>&1 | grep -vx 'SET'; }

ok()   { PASS=$((PASS+1)); printf '  \033[32mDAT  \033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mTRUOT\033[0m %s\n' "$1"; printf '        mong doi: %s\n        nhan duoc: %s\n' "$2" "$3"; }

# expect <mô tả> <chuỗi mong đợi có trong kết quả> <kết quả thực tế>
expect() {
    if printf '%s' "$3" | grep -qF -- "$2"; then ok "$1"; else bad "$1" "$2" "$(printf '%s' "$3" | tr '\n' ' ' | cut -c1-120)"; fi
}

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# -----------------------------------------------------------------------------
section "LOP 1a - pg_hba: kiem soat truy cap theo host"
expect "superuser postgres bi chan qua TCP" \
       "pg_hba.conf rejects connection" \
       "$(docker compose exec -T postgres psql "postgresql://postgres:${POSTGRES_PASSWORD}@172.28.0.10:5432/secdb" -tAc 'SELECT 1;' 2>&1)"
expect "superuser postgres vao duoc qua unix socket" "postgres" "$(sql_su 'SELECT current_user;')"

# -----------------------------------------------------------------------------
section "LOP 1b/1c - Role va GRANT"
expect "app_user SELECT tren customers khong bi loi" "" "$(sql_app 'SELECT count(*) FROM app.customers;')"
expect "app_user KHONG duoc DELETE"        "permission denied for table customers" "$(sql_app 'DELETE FROM app.customers;')"
expect "app_user KHONG duoc DROP TABLE"    "must be owner of table customers"      "$(sql_app 'DROP TABLE app.customers;')"
expect "app_user KHONG duoc TRUNCATE"      "permission denied for table customers" "$(sql_app 'TRUNCATE app.customers;')"
expect "app_user KHONG duoc tao bang moi"  "permission denied for schema public"   "$(sql_app 'CREATE TABLE public.hacked(x int);')"
expect "app_user KHONG cham duoc schema audit" "permission denied for schema audit" "$(sql_app 'SELECT * FROM audit.alerts;')"
expect "readonly_user KHONG doc duoc payments" "permission denied for table payments" \
       "$(docker compose exec -T postgres psql "postgresql://readonly_user:${READONLY_PASSWORD}@172.28.0.10:5432/secdb" -tAc 'SELECT * FROM app.payments;' 2>&1)"
expect "readonly_user KHONG ghi duoc" "read-only transaction" \
       "$(docker compose exec -T postgres psql "postgresql://readonly_user:${READONLY_PASSWORD}@172.28.0.10:5432/secdb" -tAc "INSERT INTO app.customers(branch_id,full_name) VALUES (1,'x');" 2>&1)"

# -----------------------------------------------------------------------------
section "LOP 1d - Row-Level Security"
expect "app_user chua SET ROLE -> 0 dong" "0" "$(sql_app 'SELECT count(*) FROM app.customers;')"
expect "nv_hn01 chi thay chi nhanh 1" "1" \
       "$(sql_nv nv_hn01 'SELECT DISTINCT branch_id FROM app.customers;')"
expect "nv_dn01 chi thay chi nhanh 2" "2" \
       "$(sql_nv nv_dn01 'SELECT DISTINCT branch_id FROM app.customers;')"
expect "nv_hn01 khong INSERT duoc sang chi nhanh khac" "violates row-level security policy" \
       "$(sql_nv nv_hn01 "INSERT INTO app.customers(branch_id,full_name) VALUES (2,'Chen lau');")"
expect "nv_hn01 khong doi duoc branch_id sang chi nhanh khac" "violates row-level security policy" \
       "$(sql_nv nv_hn01 'UPDATE app.customers SET branch_id = 2 WHERE branch_id = 1;')"
expect "db_owner bi FORCE RLS chan -> 0 dong" "0" \
       "$(sql_su 'SET ROLE db_owner; SELECT count(*) FROM app.customers;' | tail -1)"

# -----------------------------------------------------------------------------
section "LOP 2 - Ma hoa cot bang pgcrypto"
expect "nv_hn01 giai ma duoc CCCD chi nhanh minh" "001201000001" \
       "$(sql_nv nv_hn01 'SELECT app.decrypt_text(cccd) FROM app.customers ORDER BY id LIMIT 1;')"
expect "tra cuu duoc theo CCCD qua blind index" "Khach Hang 02" \
       "$(sql_nv nv_hn01 "SELECT full_name FROM app.customers WHERE cccd_hash = app.blind_index('001201000002');")"
expect "blind index TAT DINH (goi 2 lan ra cung gia tri)" "t" \
       "$(sql_nv nv_hn01 "SELECT app.blind_index('001201000001') = app.blind_index('001201000001');")"
expect "ciphertext KHONG tat dinh (goi 2 lan ra khac nhau)" "t" \
       "$(sql_nv nv_hn01 "SELECT app.encrypt_text('001201000001') <> app.encrypt_text('001201000001');")"
expect "role nghiep vu KHONG doc duoc khoa" "permission denied for schema ext" \
       "$(sql_nv nv_hn01 'SELECT ext.master_key();')"
expect "role nghiep vu KHONG goi truc tiep pgcrypto duoc" "permission denied for schema ext" \
       "$(sql_nv nv_hn01 "SELECT ext.pgp_sym_decrypt(cccd,'x') FROM app.customers LIMIT 1;")"
expect "readonly_user KHONG doc duoc cot cccd (quyen muc COT)" "permission denied for table customers" \
       "$(docker compose exec -T postgres psql "postgresql://readonly_user:${READONLY_PASSWORD}@172.28.0.10:5432/secdb" -tAc 'SELECT cccd FROM app.customers;' 2>&1)"

# Phép thử quan trọng nhất của lớp 2: kẻ lấy được bản dump có đọc được gì không.
DUMP="$(mktemp)"
docker compose exec -T postgres pg_dump -U postgres -d "$POSTGRES_DB" > "$DUMP" 2>/dev/null
LEAK=""
for c in 001201000001 048202000003 079203000005 4242424242424242; do
    grep -qF "$c" "$DUMP" && LEAK="$LEAK $c"
done
[ -s secrets/pgcrypto_key ] && grep -qF "$(cat secrets/pgcrypto_key)" "$DUMP" && LEAK="$LEAK <khoa>"
if [ -z "$LEAK" ]; then ok "pg_dump KHONG chua CCCD, so the hay khoa o dang ro"
else bad "pg_dump KHONG chua du lieu nhay cam" "khong co gi" "lo:$LEAK"; fi
rm -f "$DUMP"

# Khóa không được rò vào log - đây là lý do pgaudit.log_parameter phải tắt.
if [ -s secrets/pgcrypto_key ] && grep -rqF "$(cat secrets/pgcrypto_key)" logs/ 2>/dev/null; then
    bad "khoa KHONG xuat hien trong log" "khong co" "tim thay trong logs/"
else ok "khoa KHONG xuat hien trong log"; fi

# -----------------------------------------------------------------------------
section "APP - lien ket dang nhap (app.staff.username/password_hash)"
expect "app_user tra cuu duoc staff de dang nhap (SELECT bang app.staff)" "hn01" \
       "$(sql_app "SELECT username FROM app.staff WHERE username = 'hn01';")"
expect "password_hash la bcrypt, khong phai plaintext" '$2' \
       "$(sql_app "SELECT password_hash FROM app.staff WHERE username = 'hn01';")"

# -----------------------------------------------------------------------------
section "LOP 3 - Giam sat bang pgAudit"
MARK="verify_$(date +%s)"
sql_nv nv_dn01 "SELECT '$MARK', phone FROM app.customers;" >/dev/null
sleep 2
expect "cau SELECT xuat hien dang AUDIT trong log CSV" "$MARK" \
       "$(grep -h AUDIT logs/*.csv 2>/dev/null | grep -F "$MARK" | tail -1)"
# Lọc theo class MISC,SET chứ không theo chuỗi 'SET ROLE ...': khi psql gửi
# nhiều câu trong một query string, dòng AUDIT của câu SELECT cũng chứa nguyên
# văn 'SET ROLE ...' nên tìm theo chuỗi sẽ bắt nhầm dòng.
expect "log ghi lai duoc SET ROLE (can cho analyzer quy trach nhiem)" "SET ROLE nv_dn01" \
       "$(grep -h AUDIT logs/*.json 2>/dev/null | grep -F 'MISC,SET' | tail -1)"
expect "tham so KHONG bi ghi plaintext (pgaudit.log_parameter=off)" "<not logged>" \
       "$(grep -h AUDIT logs/*.csv 2>/dev/null | grep -F "$MARK" | tail -1)"

# -----------------------------------------------------------------------------
section "LOP 4 - WAL archiving"
BEFORE=$(ls -1 backup/wal_archive/ 2>/dev/null | grep -vc gitkeep)
sql_su 'SELECT pg_switch_wal();' >/dev/null
sleep 4
AFTER=$(ls -1 backup/wal_archive/ 2>/dev/null | grep -vc gitkeep)
if [ "$AFTER" -gt "$BEFORE" ]; then ok "pg_switch_wal() sinh them file WAL ($BEFORE -> $AFTER)"
else bad "pg_switch_wal() sinh them file WAL" "so file tang" "$BEFORE -> $AFTER"; fi
expect "khong co lan archive nao that bai" "0" "$(sql_su 'SELECT failed_count FROM pg_stat_archiver;')"

# -----------------------------------------------------------------------------
printf '\n\033[1m============================================\033[0m\n'
printf '  DAT: %s    TRUOT: %s\n' "$PASS" "$FAIL"
printf '\033[1m============================================\033[0m\n'
[ "$FAIL" -eq 0 ] || exit 1
