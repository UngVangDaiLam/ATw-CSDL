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
section "LOP 1e - app.staff: khong role nghiep vu nao doc duoc password_hash"
# app.staff KHONG bat RLS - chot chan la quyen muc COT (04_grants.sql). Day la
# thu bien SQLi UNION o /customers/search tu "lo hash" thanh "bi tu choi".
expect "app_user van doc duoc cac cot khac cua app.staff" "hn01" \
       "$(sql_app "SELECT username FROM app.staff WHERE username = 'hn01';")"
expect "app_user KHONG doc duoc cot password_hash" "permission denied for table staff" \
       "$(sql_app "SELECT password_hash FROM app.staff;")"
expect "nhan vien (staff_role) KHONG doc duoc password_hash" "permission denied for table staff" \
       "$(sql_nv nv_hn01 "SELECT password_hash FROM app.staff;")"
expect "SQLi kieu UNION doc password_hash bi PostgreSQL tu choi" "permission denied for table staff" \
       "$(sql_nv nv_hn01 "SELECT full_name FROM app.customers WHERE full_name LIKE '%x%' UNION SELECT password_hash FROM app.staff;")"
expect "password_hash la bcrypt, khong phai plaintext (doc bang superuser)" '$2' \
       "$(sql_su "SELECT password_hash FROM app.staff WHERE username = 'hn01';")"

# Dang nhap qua app.verify_staff_login(). Mat khau gui bang \bind (tham so cua
# giao thuc extended query) - dung nhu app lam. Viet thang vao chuoi SQL thi
# chinh phep thu se ghi mat khau vao log.
login_fn() {
    printf 'SELECT db_user FROM app.verify_staff_login($1, $2) \\bind %s %s \\g\n' "$1" "$2" \
        | docker compose exec -T postgres psql "$APP_URL" -tA 2>&1
}
expect "dang nhap dung mat khau qua app.verify_staff_login" "nv_hn01" \
       "$(login_fn hn01 'Demo@123456')"
WRONG_PW="sai_mk_$(date +%s)_$RANDOM"
LOGIN_WRONG="$(login_fn hn01 "$WRONG_PW")"
if [ -z "$LOGIN_WRONG" ]; then ok "sai mat khau -> ham tra 0 dong"
else bad "sai mat khau -> ham tra 0 dong" "rong" "$LOGIN_WRONG"; fi
expect "nhan vien (sau SET ROLE) KHONG goi duoc ham kiem tra mat khau" "permission denied for function verify_staff_login" \
       "$(sql_nv nv_hn01 "SELECT * FROM app.verify_staff_login('hn01', 'x');")"
sleep 2
if grep -rqF "$WRONG_PW" logs/ 2>/dev/null; then
    bad "mat khau gui qua tham so KHONG xuat hien trong log" "khong co" "tim thay $WRONG_PW trong logs/"
else ok "mat khau gui qua tham so KHONG xuat hien trong log"; fi

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
# Service analyzer trong Docker dang chay thi chay dry-run NGAY TRONG container
# do: may host khong can cai Node. Khong thi dung analyzer tren host.
ANALYZER_SKIP=""
if docker compose ps --status running --services 2>/dev/null | grep -qx analyzer; then
    ANALYZER_CMD=(docker compose exec -T analyzer node src/index.js)
else
    ANALYZER_CMD=(node analyzer/src/index.js)
    if ! command -v node >/dev/null 2>&1; then
        ANALYZER_SKIP="khong tim thay node, service analyzer cung khong chay (docker compose up -d analyzer)"
    elif [ ! -d analyzer/node_modules ]; then
        ANALYZER_SKIP="chua cai phu thuoc: cd analyzer && npm install"
    elif [ ! -f analyzer/.env ]; then
        ANALYZER_SKIP="thieu analyzer/.env - copy tu analyzer/.env.example"
    fi
fi
if [ -n "$ANALYZER_SKIP" ]; then
    printf '  \033[33mBO QUA\033[0m %s\n' "$ANALYZER_SKIP"
else
    # Sinh hai hanh vi xau. CO Y chon hai cau KHONG phu thuoc thoi diem chay:
    # rule AFTER_HOURS dua vao gio he thong nen khong dung lam tieu chi duoc -
    # chay luc 10h sang va luc 2h sang se cho ket qua khac nhau.
    #
    # Cau thu hai co so CCCD viet thang trong SQL: vua de thu rule, vua de kiem
    # chung analyzer CHE du lieu nhay cam truoc khi ghi vao audit.alerts.
    #
    # Moc thoi gian lay TU DATABASE theo log_timezone (khong lay gio may host):
    # analyzer chi xet log tu moc nay (--since). Khong doc tiep tu file trang
    # thai nhu binh thuong vi mot analyzer --watch dang chay co the da xu ly va
    # luu vi tri vuot qua cac dong ben duoi truoc khi dry-run kip doc.
    SINCE="$(sql_su "SELECT to_char(now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS.MS');")"
    sql_nv nv_hcm01 'SELECT count(app.decrypt_text(cccd)) FROM app.customers;' >/dev/null
    # Cau nay bi TU CHOI (password_hash): pgAudit khong ghi AUDIT, analyzer phai
    # doc dong ERROR 42501 moi thay (ACCESS_DENIED, xem sessions.js).
    sql_nv nv_hcm01 "SELECT full_name FROM app.customers WHERE cccd_hash = app.blind_index('079203000005') UNION SELECT password_hash FROM app.staff;" >/dev/null
    # Cau nay CHAY DUOC (cot username) -> STAFF_CREDENTIAL_READ.
    sql_nv nv_hcm01 "SELECT full_name FROM app.customers WHERE id = 0 UNION SELECT username FROM app.staff;" >/dev/null

    # Mo phong dung trinh tu cua app/ tren MOT ket noi duoc pool tai su dung:
    # request cua nv_dn01 (SET LOCAL ROLE trong transaction), roi tren CUNG ket
    # noi do la cau dang nhap doc app.staff KHONG SET ROLE. psql doc tu stdin
    # gui tung cau rieng le - giong app, khac -c (ca chuoi chung mot dong log).
    #   doi_chung: KHONG co RESET ROLE -> analyzer van tuong vai nv_dn01 con hieu
    #              luc (COMMIT khong vao log) -> quy nham, canh bao gia.
    #   that:      co RESET ROLE nhu setRole.js -> analyzer tra vai -> khong gan nham.
    login_after_request() {
        printf "BEGIN;\nSET LOCAL ROLE nv_dn01;\nSELECT id FROM app.customers WHERE id = 1;\nCOMMIT;\n%s\nSELECT username FROM app.staff WHERE username = '%s';\n" "$1" "$2" \
            | docker compose exec -T postgres psql "$APP_URL" -q >/dev/null 2>&1
    }
    login_after_request "" "verify_khong_reset"
    login_after_request "RESET ROLE;" "verify_co_reset"
    sleep 2

    # --dry-run: lan chay NAY khong tu ghi vao audit.alerts. Nhung neu service
    # analyzer (--watch) dang chay thi no CO ghi cac hanh vi tren thanh canh bao
    # that - dung vay, do la cau lenh that da chay. Cot `client` cua chung la
    # 172.28.0.10 (psql trong container postgres), phan biet voi app (.20).
    ANALYZER_OUT="$("${ANALYZER_CMD[@]}" --dry-run --since="$SINCE" 2>&1)"

    expect "analyzer phat hien giai ma hang loat" "BULK_DECRYPT" "$ANALYZER_OUT"
    expect "analyzer phat hien dau vet UNION SELECT" "SQLI_UNION" "$ANALYZER_OUT"
    expect "analyzer phat hien truy cap bang chua password_hash" "STAFF_CREDENTIAL_READ" "$ANALYZER_OUT"
    # Tan cong bi lop 1 chan van phai hien o lop 3, va van quy dung nguoi.
    expect "analyzer bat lan SQLi bi tu choi quyen, quy cho nv_hcm01 (ACCESS_DENIED)" "nv_hcm01" \
           "$(printf '%s' "$ANALYZER_OUT" | grep 'ACCESS_DENIED')"
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

    # Moi canh bao in 3 dong: [diem] RULE nguoi | mo ta | cau lenh. Tim dong cau
    # lenh chua dau moc roi nhin 2 dong phia tren.
    staff_alert_for() { printf '%s' "$ANALYZER_OUT" | grep -B2 -F "$1" | grep 'STAFF_CREDENTIAL_READ'; }
    # Doi chung: chung minh phep thu duoi khong vo nghia - thieu dau moc thi
    # analyzer CO gan nham that.
    if staff_alert_for 'verify_khong_reset' | grep -q 'nv_dn01'; then
        ok "doi chung: thieu RESET ROLE thi dang nhap bi gan nham cho nv_dn01"
    else
        bad "doi chung: thieu RESET ROLE thi dang nhap bi gan nham cho nv_dn01" \
            "STAFF_CREDENTIAL_READ nv_dn01" "khong thay - phep thu RESET ROLE ben duoi mat y nghia"
    fi
    # app/src/middleware/setRole.js goi RESET ROLE sau moi COMMIT/ROLLBACK.
    if staff_alert_for 'verify_co_reset' | grep -q .; then
        bad "co RESET ROLE: dang nhap tren ket noi tai su dung KHONG bi gan nham" \
            "khong co STAFF_CREDENTIAL_READ" "$(staff_alert_for 'verify_co_reset' | head -1)"
    else
        ok "co RESET ROLE: dang nhap tren ket noi tai su dung KHONG bi gan nham"
    fi
fi

# -----------------------------------------------------------------------------
section "TRIEN KHAI - app, analyzer, dashboard trong Docker"
SERVICES_UP="$(docker compose ps --status running --services 2>/dev/null)"
MISSING=""
for s in app analyzer dashboard; do printf '%s\n' "$SERVICES_UP" | grep -qx "$s" || MISSING="$MISSING $s"; done
if [ -z "$MISSING" ]; then ok "ca ba service app, analyzer, dashboard dang chay"
else bad "ca ba service app, analyzer, dashboard dang chay" "dang chay" "khong chay:$MISSING (docker compose up -d)"; fi

# Tien trinh trong container KHONG chay bang root (Dockerfile: USER node).
ROOTED=""
for s in app analyzer dashboard; do
    uid="$(docker compose exec -T "$s" id -u 2>/dev/null | tr -d '[:space:]')"
    [ "$uid" = "0" ] || [ -z "$uid" ] && ROOTED="$ROOTED $s(uid=${uid:-?})"
done
if [ -z "$ROOTED" ]; then ok "ca ba container chay bang user thuong, khong phai root"
else bad "ca ba container chay bang user thuong, khong phai root" "uid khac 0" "$ROOTED"; fi

# Log pgAudit la bang chung: analyzer bi chiem cung khong duoc sua/xoa duoc.
expect "analyzer KHONG ghi duoc vao thu muc log (mount chi doc)" "Read-only file system" \
       "$(docker compose exec -T analyzer sh -c 'touch /logs/.verify_probe' 2>&1)"

# .env chua mat khau - khong duoc nam trong image (.dockerignore).
LEAKED=""
for s in app analyzer dashboard; do
    docker compose exec -T "$s" sh -c 'test -e /app/.env' 2>/dev/null && LEAKED="$LEAKED $s"
done
if [ -z "$LEAKED" ]; then ok "khong image nao chua file .env"
else bad "khong image nao chua file .env" "khong co /app/.env" "co trong:$LEAKED"; fi

# App co 2 lo hong co y, dashboard khong co dang nhap: chi mo tren loopback.
PUBLISHED="$(docker compose port app 3000 2>&1) $(docker compose port dashboard 4000 2>&1)"
if printf '%s' "$PUBLISHED" | grep -qE '^127\.0\.0\.1:[0-9]+ 127\.0\.0\.1:[0-9]+$'; then
    ok "cong app va dashboard chi mo tren 127.0.0.1"
else bad "cong app va dashboard chi mo tren 127.0.0.1" "127.0.0.1:<cong> cho ca hai" "$PUBLISHED"; fi

# App trong container ket noi bang dung app_user (khong phai superuser/db_owner).
expect "app trong container ket noi database bang app_user" '"current_user":"app_user"' \
       "$(curl -s "http://127.0.0.1:${APP_HOST_PORT:-3000}/health" 2>&1)"

# -----------------------------------------------------------------------------
section "WEB - lop bao ve tang HTTP cua app/"
# Moc thoi gian cho phan "su kien tang web -> lop 3" o cuoi muc nay.
WEB_SINCE="$(sql_su "SELECT to_char(now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS.MS');")"
# Khoa ky cookie phien: thieu, dung gia tri mau hoac qua ngan thi app tu choi
# khoi dong (ban goc am tham dung khoa mac dinh viet thang trong code).
# Container tam chay thang tu image, KHONG mang (--network none): app phai dung
# truoc khi kip noi DB. Khong dung `docker compose run app` vi no thua ke IP co
# dinh 172.28.0.20 cua service va dung voi container app dang chay.
expect "app TU CHOI khoi dong khi SESSION_SECRET la gia tri mau" "KHONG KHOI DONG" \
       "$(docker run --rm --network none -e SESSION_SECRET=doi_chuoi_bi_mat_nay secdb/app 2>&1)"
# Trong Docker khoa la Docker secret (file), khong phai bien moi truong:
# `docker inspect` / /proc/<pid>/environ khong doc duoc.
expect "khoa phien KHONG nam trong bien moi truong cua container app" "0" \
       "$(docker compose exec -T app sh -c 'env | grep -c "^SESSION_SECRET="' 2>&1)"

# Header bao mat (app/src/httpHeaders.js). Goi 127.0.0.1, KHONG goi localhost -
# xem CLAUDE.md "Bay 8".
WEB="http://127.0.0.1:${APP_HOST_PORT:-3000}"
HDR="$(curl -s -D - -o /dev/null "$WEB/health" 2>&1 | tr -d '\r')"
if printf '%s' "$HDR" | grep -qi "^content-security-policy:.*script-src 'self'.*frame-ancestors 'none'"; then
    ok "CSP chan script la va chan nhung trang vao iframe"
else bad "CSP chan script la va chan nhung trang vao iframe" "script-src 'self' ... frame-ancestors 'none'" "$(printf '%s' "$HDR" | grep -i '^content-security' | cut -c1-120)"; fi
if printf '%s' "$HDR" | grep -qi '^x-content-type-options: nosniff' && ! printf '%s' "$HDR" | grep -qi '^x-powered-by'; then
    ok "co nosniff va KHONG lo X-Powered-By"
else bad "co nosniff va KHONG lo X-Powered-By" "nosniff, khong X-Powered-By" "$(printf '%s' "$HDR" | grep -iE '^(x-content-type|x-powered)' | tr '\n' ' ')"; fi

# CSRF (app/src/csrf.js): request ghi du lieu phai la JSON va mang token.
JAR="$(mktemp)"
CSRF_TOKEN="$(curl -s -c "$JAR" -b "$JAR" "$WEB/auth/csrf" | grep -o '"csrfToken":"[0-9a-f]*"' | cut -d'"' -f4)"
SID_BEFORE="$(grep -o 'secdb.sid[[:space:]]*[^[:space:]]*$' "$JAR" | awk '{print $2}')"
expect "dang nhap KHONG co CSRF token bi tu choi (403)" "403" \
       "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$WEB/auth/login" -H 'Content-Type: application/json' \
          -d '{"username":"hn01","password":"Demo@123456"}')"
# Form HTML tu trang khac chi gui duoc urlencoded/multipart/text/plain.
expect "request ghi KHONG phai JSON bi tu choi (415)" "415" \
       "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$WEB/auth/login" -H "X-CSRF-Token: $CSRF_TOKEN" \
          -H 'Content-Type: application/x-www-form-urlencoded' -d 'username=hn01&password=Demo@123456')"

# Dang nhap dung cach (co token) bang tai khoan demo cua 07_seed.sql.
# Cookie phien: HttpOnly (XSS khong doc duoc), SameSite=Strict (khong di theo
# request tu trang khac).
LOGIN_HDR="$(curl -s -D - -o /dev/null -c "$JAR" -b "$JAR" -X POST "$WEB/auth/login" -H 'Content-Type: application/json' \
             -H "X-CSRF-Token: $CSRF_TOKEN" -d '{"username":"hn01","password":"Demo@123456"}' 2>&1 | tr -d '\r')"
COOKIE_LINE="$(printf '%s' "$LOGIN_HDR" | grep -i '^set-cookie: secdb.sid=')"
if printf '%s' "$COOKIE_LINE" | grep -qi 'HttpOnly' && printf '%s' "$COOKIE_LINE" | grep -qi 'SameSite=Strict'; then
    ok "cookie phien co HttpOnly va SameSite=Strict"
else bad "cookie phien co HttpOnly va SameSite=Strict" "secdb.sid=...; HttpOnly; SameSite=Strict" "${COOKIE_LINE:-khong co Set-Cookie secdb.sid}"; fi

# Session fixation: phien co TRUOC khi dang nhap (tao boi GET /auth/csrf) phai
# bi thay bang ma phien moi, khong duoc "nang cap" thanh phien da dang nhap.
SID_AFTER="$(grep -o 'secdb.sid[[:space:]]*[^[:space:]]*$' "$JAR" | awk '{print $2}')"
if [ -n "$SID_BEFORE" ] && [ -n "$SID_AFTER" ] && [ "$SID_BEFORE" != "$SID_AFTER" ]; then
    ok "dang nhap cap ma phien MOI (chong session fixation)"
else bad "dang nhap cap ma phien MOI (chong session fixation)" "ma phien truoc != sau" "truoc=${SID_BEFORE:0:16} sau=${SID_AFTER:0:16}"; fi

# Da dang nhap nhung thieu token thi van khong ghi duoc. Chi thu nhanh bi chan:
# ban co token se INSERT that, ma verify.sh khong de lai du lieu.
expect "da dang nhap nhung thieu CSRF token: KHONG tao duoc khach hang (403)" "403" \
       "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$WEB/customers" -H 'Content-Type: application/json' \
          -d '{"full_name":"verify_csrf"}')"
rm -f "$JAR"

# Gioi han dang nhap sai (app/src/loginLimiter.js): 5 lan sai cho mot cap
# (IP, username) -> lan thu 6 bi tu choi 429. Dung username NGAU NHIEN khong ton
# tai: khoa theo cap, khoa nham hn01 thi demo-attack.sh va chinh verify.sh
# khong dang nhap duoc trong 15 phut.
JAR="$(mktemp)"
# Chen chu "x" giua: hai $RANDOM lien nhau co the thanh day >= 9 chu so, ma
# analyzer CHE moi day so nhu vay trong canh bao (chong lo CCCD) - phep thu
# ben duoi se khong tim thay username nua.
BF_USER="verify_bf_${RANDOM}x${RANDOM}"
BF_TOKEN="$(curl -s -c "$JAR" -b "$JAR" "$WEB/auth/csrf" | grep -o '"csrfToken":"[0-9a-f]*"' | cut -d'"' -f4)"
bf_try() {
    curl -s -D - -o /dev/null -c "$JAR" -b "$JAR" -X POST "$WEB/auth/login" -H 'Content-Type: application/json' \
         -H "X-CSRF-Token: $BF_TOKEN" -d "{\"username\":\"$1\",\"password\":\"$2\"}" | tr -d '\r'
}
BF_CODES=""
for _ in 1 2 3 4 5; do BF_CODES="$BF_CODES $(bf_try "$BF_USER" sai_mat_khau | head -1 | awk '{print $2}')"; done
BF_SIXTH="$(bf_try "$BF_USER" sai_mat_khau)"
if [ "$BF_CODES" = " 401 401 401 401 401" ] && printf '%s' "$BF_SIXTH" | head -1 | grep -q ' 429' \
   && printf '%s' "$BF_SIXTH" | grep -qi '^retry-after: [0-9]'; then
    ok "5 lan dang nhap sai -> lan thu 6 bi khoa (429 + Retry-After)"
else bad "5 lan dang nhap sai -> lan thu 6 bi khoa (429 + Retry-After)" "401 x5 roi 429" \
         "$BF_CODES ->$(printf '%s' "$BF_SIXTH" | head -1)"; fi
# Khoa theo CAP (IP, username): tai khoan khac tu cung IP van dang nhap duoc.
expect "khoa chi ap cho username bi do - tai khoan khac van dang nhap duoc" " 200" \
       "$(bf_try hn01 Demo@123456 | head -1)"
rm -f "$JAR"

# Loi KHONG lo chi tiet noi bo (app/src/errors.js).
# JSON hong: truoc day Express tra nguyen stack trace kem /app/node_modules/...
BAD_JSON="$(curl -s -w ' HTTP%{http_code}' -X POST "$WEB/auth/login" -H 'Content-Type: application/json' -d '{"username": hn01')"
if printf '%s' "$BAD_JSON" | grep -q 'HTTP400$' && ! printf '%s' "$BAD_JSON" | grep -qiE 'SyntaxError|node_modules|at JSON'; then
    ok "JSON hong -> 400, KHONG lo stack trace"
else bad "JSON hong -> 400, KHONG lo stack trace" "HTTP400, khong co SyntaxError/node_modules" "$(printf '%s' "$BAD_JSON" | cut -c1-120)"; fi

# Loi tu PostgreSQL tren route binh thuong: client chi thay ma tham chieu, chi
# tiet (ten rang buoc...) chi nam trong log server. Tao don cho khach hang
# KHONG ton tai -> vi pham khoa ngoai; INSERT that bai, transaction ROLLBACK,
# khong de lai du lieu.
JAR="$(mktemp)"
E_TOKEN="$(curl -s -c "$JAR" -b "$JAR" "$WEB/auth/csrf" | grep -o '"csrfToken":"[0-9a-f]*"' | cut -d'"' -f4)"
E_TOKEN="$(curl -s -c "$JAR" -b "$JAR" -X POST "$WEB/auth/login" -H 'Content-Type: application/json' -H "X-CSRF-Token: $E_TOKEN" \
             -d '{"username":"hn01","password":"Demo@123456"}' | grep -o '"csrfToken":"[0-9a-f]*"' | cut -d'"' -f4)"
DB_ERR="$(curl -s -b "$JAR" -X POST "$WEB/orders" -H 'Content-Type: application/json' -H "X-CSRF-Token: $E_TOKEN" \
             -d '{"customer_id":999999999,"total_amount":1000}')"
ERR_REF="$(printf '%s' "$DB_ERR" | grep -o '"ref":"[0-9a-f]*"' | cut -d'"' -f4)"
if [ -n "$ERR_REF" ] && ! printf '%s' "$DB_ERR" | grep -qiE 'constraint|violates|foreign key|orders_'; then
    ok "loi CSDL tra ve ma tham chieu, KHONG lo ten bang/rang buoc"
else bad "loi CSDL tra ve ma tham chieu, KHONG lo ten bang/rang buoc" "{ref, thong bao chung}" "$(printf '%s' "$DB_ERR" | cut -c1-120)"; fi
if [ -n "$ERR_REF" ] && docker compose logs --no-log-prefix app 2>/dev/null | grep -q "\[loi $ERR_REF\].*foreign key"; then
    ok "chi tiet loi nam trong log server, tra duoc bang ma tham chieu"
else bad "chi tiet loi nam trong log server, tra duoc bang ma tham chieu" "[loi $ERR_REF] ... foreign key" "khong thay trong docker compose logs app"; fi
rm -f "$JAR"

# Su kien tang web -> lop 3. Cac phep thu o tren vua gay ra mot lan khoa dang
# nhap ($BF_USER) va vai request CSRF bi chan - log pgAudit khong the hien
# nhung thu nay. app ghi chung ra logs/app/ (app/src/securityLog.js), analyzer
# doc va bien thanh canh bao (analyzer/src/appEvents.js). app_user van KHONG co
# quyen gi tren schema audit (phep thu o muc LOP 1).
sleep 1
if grep -h "\"username\":\"$BF_USER\"" logs/app/security-*.jsonl 2>/dev/null | grep -q '"event":"login_locked"'; then
    ok "app ghi su kien 'bi khoa vi do mat khau' ra logs/app/ (khong ghi mat khau)"
else bad "app ghi su kien 'bi khoa vi do mat khau' ra logs/app/ (khong ghi mat khau)" "login_locked cho $BF_USER" "khong thay trong logs/app/security-*.jsonl"; fi
if [ -n "${ANALYZER_SKIP:-}" ]; then
    printf '  \033[33mBO QUA\033[0m analyzer khong chay duoc: %s\n' "$ANALYZER_SKIP"
else
    WEB_ALERTS="$("${ANALYZER_CMD[@]}" --dry-run --since="$WEB_SINCE" 2>&1)"
    expect "analyzer bien do mat khau thanh canh bao LOGIN_BRUTE_FORCE" "$BF_USER" \
           "$(printf '%s' "$WEB_ALERTS" | grep -A1 'LOGIN_BRUTE_FORCE')"
    expect "analyzer bien request CSRF bi chan thanh canh bao CSRF_BLOCKED" "CSRF_BLOCKED" "$WEB_ALERTS"
fi

# Giao dien web (app/web -> public/) phuc vu cung origin voi API, va cung mang
# CSP nhu moi phan hoi khac.
UI_PAGE="$(curl -s -D - "$WEB/" 2>&1 | tr -d '\r')"
if printf '%s' "$UI_PAGE" | grep -q '<title>SecDB · Quản lý khách hàng</title>' \
   && printf '%s' "$UI_PAGE" | grep -qi "^content-security-policy:.*script-src 'self'"; then
    ok "app phuc vu giao dien web cung origin, co CSP"
else bad "app phuc vu giao dien web cung origin, co CSP" "<title>SecDB · Quản lý khách hàng</title> + CSP" \
         "$(printf '%s' "$UI_PAGE" | grep -iE '<title>|^content-security|^HTTP' | tr '\n' ' ' | cut -c1-120)"; fi

# Phan hoi co du lieu khach hang khong duoc luu lai o trinh duyet/proxy.
expect "API du lieu tra ve Cache-Control: no-store" "no-store" \
       "$(curl -s -D - -o /dev/null "$WEB/customers" 2>&1 | tr -d '\r' | grep -i '^cache-control')"

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
