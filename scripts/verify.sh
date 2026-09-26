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
: "${ANALYZER_PASSWORD:?ANALYZER_PASSWORD chua co trong .env - them vao (xem .env.example)}"
: "${DASHBOARD_PASSWORD:?DASHBOARD_PASSWORD chua co trong .env - them vao (xem .env.example)}"

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
# psql dưới quyền analyzer_user (TCP) - role của lớp 3, chỉ INSERT audit.alerts
sql_an() { docker compose exec -T postgres psql "postgresql://analyzer_user:${ANALYZER_PASSWORD}@172.28.0.10:5432/secdb" -tAc "$1" 2>&1; }
# psql dưới quyền dashboard_user (TCP) - lớp 3 chiều đọc, chỉ SELECT audit.alerts
sql_db() { docker compose exec -T postgres psql "postgresql://dashboard_user:${DASHBOARD_PASSWORD}@172.28.0.10:5432/secdb" -tAc "$1" 2>&1; }

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
# Hiệu năng của chính policy: app.current_branch_id() phải được bọc trong
# subquery để thành InitPlan (tính 1 lần/câu lệnh). Gọi thẳng thì với kế hoạch
# quét theo khóa chính, hàm bị gọi lại cho TỪNG dòng - chậm hơn ~12 lần và mỗi
# lần gọi thêm một dòng log pgAudit. Kết quả vẫn đúng nên không phép thử chức
# năng nào bắt được lỗi này. Xem docs/performance.md mục 1.
expect "policy RLS tinh chi nhanh 1 lan/cau lenh (InitPlan), khong phai moi dong" "InitPlan" \
       "$(sql_nv nv_hn01 'EXPLAIN SELECT phone FROM app.customers ORDER BY id LIMIT 100;')"
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
section "LOP 3b - analyzer_user: chi duoc GHI canh bao, khong duoc doc"
expect "analyzer_user ket noi duoc qua TCP (co dong rieng trong pg_hba)" "analyzer_user" \
       "$(sql_an 'SELECT current_user;')"
# Ghi thật rồi ROLLBACK: chứng minh quyền INSERT có hiệu lực mà không để lại rác.
expect "analyzer_user INSERT duoc vao audit.alerts" "ghi_duoc" \
       "$(sql_an "BEGIN; INSERT INTO audit.alerts(db_user,rule_triggered,risk_score,detail) VALUES ('nv_hn01','VERIFY_PROBE',50,'{}'::jsonb) RETURNING 'ghi_duoc'; ROLLBACK;")"
expect "analyzer_user KHONG doc duoc audit.alerts (ghi mot chieu)" "permission denied for table alerts" \
       "$(sql_an 'SELECT * FROM audit.alerts;')"
expect "analyzer_user KHONG xoa duoc bang chung" "permission denied for table alerts" \
       "$(sql_an 'DELETE FROM audit.alerts;')"
expect "analyzer_user KHONG sua duoc bang chung" "permission denied for table alerts" \
       "$(sql_an 'UPDATE audit.alerts SET risk_score = 0;')"
expect "analyzer_user KHONG cham duoc du lieu nghiep vu" "permission denied for schema app" \
       "$(sql_an 'SELECT count(*) FROM app.customers;')"

# -----------------------------------------------------------------------------
section "LOP 3b' - dashboard_user: chi duoc DOC canh bao, khong duoc ghi"
expect "dashboard_user ket noi duoc qua TCP (co dong rieng trong pg_hba)" "dashboard_user" \
       "$(sql_db 'SELECT current_user;')"
# Đọc được thật (không lỗi, ra một con số) chứ không chỉ "không bị từ chối".
if printf '%s' "$(sql_db 'SELECT count(*) FROM audit.alerts;')" | grep -qE '^[0-9]+$'; then
    ok "dashboard_user SELECT duoc audit.alerts"
else bad "dashboard_user SELECT duoc audit.alerts" "mot con so" "$(sql_db 'SELECT count(*) FROM audit.alerts;' | cut -c1-120)"; fi
# Lớp mềm: phiên mặc định read-only (ALTER ROLE ... default_transaction_read_only).
expect "phien dashboard mac dinh chi doc" "read-only transaction" \
       "$(sql_db "INSERT INTO audit.alerts(db_user,rule_triggered,risk_score) VALUES ('x','GIA_MAO',0);")"
# Lớp cứng: tự mở transaction READ WRITE (role nào cũng làm được) thì GRANT vẫn
# chặn. Đây mới là chốt chặn thật. Không thử bằng `SET default_transaction_
# read_only = off; ...` được: psql -c gửi cả chuỗi trong MỘT transaction ngầm
# đã mở ở chế độ read-only trước khi câu SET kịp có hiệu lực.
expect "mo READ WRITE van KHONG chen duoc canh bao gia" "permission denied for table alerts" \
       "$(sql_db "BEGIN READ WRITE; INSERT INTO audit.alerts(db_user,rule_triggered,risk_score) VALUES ('x','GIA_MAO',0); ROLLBACK;")"
expect "mo READ WRITE van KHONG xoa duoc canh bao" "permission denied for table alerts" \
       "$(sql_db 'BEGIN READ WRITE; DELETE FROM audit.alerts; ROLLBACK;')"
expect "dashboard_user KHONG cham duoc du lieu nghiep vu" "permission denied for schema app" \
       "$(sql_db 'SELECT count(*) FROM app.customers;')"

# -----------------------------------------------------------------------------
section "LOP 3c - analyzer: phat hien hanh vi bat thuong"
if ! command -v node >/dev/null 2>&1; then
    printf '  \033[33mBO QUA\033[0m khong tim thay node - cai Node.js roi chay lai\n'
elif [ ! -d analyzer/node_modules ]; then
    printf '  \033[33mBO QUA\033[0m chua cai phu thuoc: cd analyzer && npm install\n'
elif [ ! -f analyzer/.env ]; then
    printf '  \033[33mBO QUA\033[0m thieu analyzer/.env - copy tu analyzer/.env.example\n'
else
    # Sinh hai hanh vi xau. CO Y chon hai cau KHONG phu thuoc thoi diem chay:
    # rule AFTER_HOURS dua vao gio he thong nen khong dung lam tieu chi duoc -
    # chay luc 10h sang va luc 2h sang se cho ket qua khac nhau.
    #
    # Cau thu hai co so CCCD viet thang trong SQL: vua de thu rule, vua de kiem
    # chung analyzer CHE du lieu nhay cam truoc khi ghi vao audit.alerts.
    sql_nv nv_hcm01 'SELECT count(app.decrypt_text(cccd)) FROM app.customers;' >/dev/null
    sql_nv nv_hcm01 "SELECT full_name FROM app.customers WHERE cccd_hash = app.blind_index('079203000005') UNION SELECT password_hash FROM app.staff;" >/dev/null
    sleep 2

    # --dry-run: khong ghi vao audit.alerts, nen nghiem thu khong lam ban bang
    # canh bao that.
    ANALYZER_OUT="$(node analyzer/src/index.js --dry-run 2>&1)"

    expect "analyzer phat hien giai ma hang loat" "BULK_DECRYPT" "$ANALYZER_OUT"
    expect "analyzer phat hien dau vet UNION SELECT" "SQLI_UNION" "$ANALYZER_OUT"
    expect "analyzer phat hien truy cap bang chua password_hash" "STAFF_CREDENTIAL_READ" "$ANALYZER_OUT"
    # Diem mau chot cua ca lop 3: log tho chi ghi "app_user", canh bao phai goi
    # duoc ten nhan vien that nho bam theo SET ROLE trong tung phien.
    expect "canh bao quy trach nhiem cho nv_hcm01 (khong phai app_user)" "nv_hcm01" "$ANALYZER_OUT"
    # So CCCD 12 chu so trong cau lenh phai bi che, neu khong thi lop 2 bi thung
    # ngay tai bang canh bao - noi khong he duoc ma hoa.
    expect "cau lenh trong canh bao da che du lieu nhay cam" "chu_so_da_che" "$ANALYZER_OUT"
    if printf '%s' "$ANALYZER_OUT" | grep -qF '079203000005'; then
        bad "CCCD KHONG lot ra canh bao o dang ro" "khong thay so CCCD" "tim thay 079203000005"
    else
        ok "CCCD KHONG lot ra canh bao o dang ro"
    fi
fi

# -----------------------------------------------------------------------------
section "DU LIEU - khoi luong theo yeu cau de bai"
N_CUST=$(sql_su 'SELECT count(*) FROM app.customers;')
N_ORD=$(sql_su  'SELECT count(*) FROM app.orders;')
N_PAY=$(sql_su  'SELECT count(*) FROM app.payments;')
if [ "${N_CUST:-0}" -ge 5000 ] 2>/dev/null; then ok "app.customers co $N_CUST dong (de bai yeu cau >= 5000)"
else bad "app.customers >= 5000 dong" ">= 5000" "${N_CUST:-loi}"; fi
if [ "${N_ORD:-0}" -ge 5000 ] 2>/dev/null; then ok "app.orders co $N_ORD dong"
else bad "app.orders >= 5000 dong" ">= 5000" "${N_ORD:-loi}"; fi
if [ "${N_PAY:-0}" -gt 0 ] 2>/dev/null; then ok "app.payments co $N_PAY dong"
else bad "app.payments co du lieu" "> 0" "${N_PAY:-loi}"; fi
# Dữ liệu phải trải đều cả ba chi nhánh, nếu không thì phép thử RLS ở trên chỉ
# đang chứng minh "chi nhánh kia rỗng" chứ không chứng minh được nó bị lọc.
expect "ca 3 chi nhanh deu co khach hang" "3" \
       "$(sql_su 'SELECT count(DISTINCT branch_id) FROM app.customers;')"
expect "khong co don hang nao lech chi nhanh so voi khach hang" "0" \
       "$(sql_su 'SELECT count(*) FROM app.orders o JOIN app.customers c ON c.id = o.customer_id WHERE o.branch_id <> c.branch_id;')"

# -----------------------------------------------------------------------------
section "LOP 4 - WAL archiving"
# pg_switch_wal() KHÔNG làm gì nếu segment hiện tại chưa có bản ghi nào kể từ
# lần switch trước - khi đó không file nào được sinh ra và phép thử kiểu "đếm
# thấy số file tăng" sẽ trượt dù archiving hoàn toàn bình thường (chính các
# phép thử phía trên đã vô tình switch sang segment mới).
# Nên: ghi một bản ghi WAL trước (pg_logical_emit_message không đụng bảng nào),
# switch, rồi chờ ĐÚNG tên segment vừa đóng xuất hiện trong kho lưu trữ.
WALFILE=$(sql_su "SELECT pg_logical_emit_message(true,'verify','wal-probe'); SELECT pg_walfile_name(pg_switch_wal());" | tail -1)
ARCHIVED=""
for _ in $(seq 1 15); do
    [ -f "backup/wal_archive/$WALFILE" ] && { ARCHIVED="yes"; break; }
    sleep 1
done
if [ -n "$ARCHIVED" ]; then ok "segment $WALFILE da duoc archive sang backup/wal_archive/"
else bad "segment WAL vua dong duoc archive" "co file $WALFILE" "khong thay sau 15s"; fi
expect "khong co lan archive nao that bai" "0" "$(sql_su 'SELECT failed_count FROM pg_stat_archiver;')"

# -----------------------------------------------------------------------------
section "LOP 4b - Base backup, pg_dump va PITR"
. backup/scripts/lib.sh

# `all` trong pg_hba KHÔNG phủ kết nối replication. Chỉ có dòng
# `local replication postgres` nên qua TCP không role nào lấy được bản sao
# vật lý của cả cluster - kể cả khi mật khẩu đúng.
# Phải thử replication=true (VẬT LÝ - thứ pg_basebackup dùng). replication=
# database là replication LOGIC, khớp với các dòng `all` thông thường nên đi
# qua pg_hba và chỉ bị chặn ở bước sau vì role thiếu thuộc tính REPLICATION.
expect "ket noi replication vat ly qua TCP bi pg_hba tu choi" "no pg_hba.conf entry for replication connection" \
       "$(docker compose exec -T postgres psql "postgresql://app_user:${APP_USER_PASSWORD}@172.28.0.10:5432/secdb?replication=true" -c 'IDENTIFY_SYSTEM;' 2>&1)"

NOW_EPOCH=$(sql_su 'SELECT floor(extract(epoch FROM now()))::bigint;')
BASE=$(pick_base "$NOW_EPOCH")
if [ -z "$BASE" ]; then
    echo "  (chua co base backup - tao mot ban bang backup/scripts/full_backup.sh)"
    bash backup/scripts/full_backup.sh >/dev/null 2>&1
    sleep 1
    BASE=$(pick_base "$(sql_su 'SELECT floor(extract(epoch FROM now()))::bigint;')")
fi
if [ -n "$BASE" ] && [ -f "backup/full/$BASE/base.tar.gz" ] && [ -f "backup/full/$BASE/backup_manifest" ]; then
    ok "co base backup $BASE (base.tar.gz + backup_manifest)"
else bad "co base backup" "backup/full/<ten>/base.tar.gz" "${BASE:-khong co}"; fi
expect "ban pg_dump doc duoc, co du lieu bang customers" "TABLE DATA app customers" \
       "$(MSYS_NO_PATHCONV=1 docker compose exec -T postgres pg_restore -l "/backup/full/$BASE/secdb.dump" 2>&1)"

# Khôi phục THẬT sự, nhưng trong container sandbox (volume riêng, archive
# read-only, không promote) - database đang chạy không bị đụng tới.
# Mốc đo nằm ở database riêng pitr_probe để không phải ghi vào dữ liệu nghiệp
# vụ: một dòng commit TRƯỚC thời điểm T, một dòng commit SAU. Khôi phục đúng
# thì chỉ thấy dòng thứ nhất.
sql_su 'DROP DATABASE IF EXISTS pitr_probe;' >/dev/null
sql_su 'CREATE DATABASE pitr_probe;' >/dev/null
sql_su 'REVOKE ALL ON DATABASE pitr_probe FROM PUBLIC;' >/dev/null
docker compose exec -T postgres psql -U postgres -d pitr_probe -tAc \
    "CREATE TABLE probe(v text); INSERT INTO probe VALUES ('truoc');" >/dev/null
sleep 1
PITR_T=$(sql_su 'SELECT now()::text;')
sleep 1
docker compose exec -T postgres psql -U postgres -d pitr_probe -tAc "INSERT INTO probe VALUES ('sau');" >/dev/null
HIST_BEFORE=$(ls backup/wal_archive | grep -c '\.history$' || true)
if flush_wal >/dev/null; then
    SANDBOX_OUT=$(docker compose run --rm -T pitr-sandbox -s -- sandbox "$BASE" "$PITR_T" pitr_probe \
        "SELECT count(*) FILTER (WHERE v='truoc') || '/' || count(*) FILTER (WHERE v='sau') FROM probe;" \
        < backup/scripts/_restore_inner.sh 2>&1)
else
    SANDBOX_OUT="khong archive duoc WAL"
fi
sql_su 'DROP DATABASE IF EXISTS pitr_probe;' >/dev/null

expect "base backup khop checksum voi backup_manifest (pg_verifybackup)" "backup successfully verified" "$SANDBOX_OUT"
# 1/0: có dòng commit trước T, KHÔNG có dòng commit sau T.
expect "PITR dung chinh xac tai T: giu dong truoc, bo dong sau" "KET_QUA=1/0" "$SANDBOX_OUT"
# Sandbox mà promote thì sẽ ghi file .history của một timeline mới vào kho
# archive - lần PITR thật tiếp theo (recovery_target_timeline = latest) sẽ đi
# theo timeline ma đó. Số file .history phải giữ nguyên.
HIST_AFTER=$(ls backup/wal_archive | grep -c '\.history$' || true)
if [ "$HIST_BEFORE" = "$HIST_AFTER" ]; then ok "sandbox khong sinh timeline moi trong kho WAL"
else bad "sandbox khong sinh timeline moi trong kho WAL" "$HIST_BEFORE file .history" "$HIST_AFTER"; fi

# -----------------------------------------------------------------------------
printf '\n\033[1m============================================\033[0m\n'
printf '  DAT: %s    TRUOT: %s\n' "$PASS" "$FAIL"
printf '\033[1m============================================\033[0m\n'
[ "$FAIL" -eq 0 ] || exit 1
