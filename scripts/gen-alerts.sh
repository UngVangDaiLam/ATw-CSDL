#!/usr/bin/env bash
# =============================================================================
# gen-alerts.sh - Sinh cảnh báo THẬT vào audit.alerts để demo / phát triển
# dashboard.
#
#   bash scripts/gen-alerts.sh
#
# Không INSERT thẳng vào bảng. Script diễn lại các hành vi xấu bằng app_user +
# SET ROLE như một kẻ tấn công thật, rồi chạy analyzer đọc log pgAudit và ghi
# cảnh báo. Nhờ vậy dữ liệu dashboard nhận được đi qua đúng đường ống thật:
# log -> analyzer -> analyzer_user INSERT -> dashboard_user SELECT.
#
# Chạy nhiều lần được: mỗi lần sinh thêm một lô cảnh báo mới (analyzer nhớ vị
# trí đã đọc nên không ghi trùng lô cũ).
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

[ -f .env ] || { echo "Khong tim thay .env"; exit 1; }
set -a; . ./.env; set +a

# Service analyzer của docker compose đang chạy (--watch) thì nó tự ghi cảnh
# báo - không cần, và KHÔNG được, chạy thêm analyzer trên host.
ANALYZER_IN_DOCKER=""
docker compose ps --status running --services 2>/dev/null | grep -qx analyzer && ANALYZER_IN_DOCKER=1

if [ -z "$ANALYZER_IN_DOCKER" ]; then
    command -v node >/dev/null     || { echo "Can Node.js de chay analyzer (hoac: docker compose up -d analyzer)."; exit 1; }
    [ -d analyzer/node_modules ]   || { echo "Chua cai phu thuoc: cd analyzer && npm install"; exit 1; }
    [ -f analyzer/.env ]           || { echo "Thieu analyzer/.env - copy tu analyzer/.env.example"; exit 1; }
fi

APP_URL="postgresql://app_user:${APP_USER_PASSWORD}@172.28.0.10:5432/secdb"
# Chạy dưới danh tính một nhân viên, như backend làm cho mỗi request: SET ROLE
# + token phiên đăng nhập của đúng người đó (scripts/staff-token.sh). Thiếu
# token thì RLS trả 0 dòng và mọi hành vi bên dưới chỉ còn là IDENTITY_WITHOUT_SESSION.
. scripts/staff-token.sh
trap revoke_minted_tokens EXIT
for r in nv_hn01 nv_dn01 nv_hcm01; do mint_staff_token "TOK_$r" "$r"; done
as_nv() {
    local tv="TOK_$1"
    docker compose exec -T -e PGOPTIONS="-c secdb.staff_token=${!tv}" postgres \
        psql "$APP_URL" -tAc "SET ROLE $1; $2" >/dev/null 2>&1 || true
}

echo "==> Dien lai cac hanh vi bat thuong"

echo "    nv_hcm01: giai ma CCCD hang loat               -> BULK_DECRYPT"
as_nv nv_hcm01 'SELECT app.decrypt_text(cccd) FROM app.customers;'

echo "    nv_dn01 : mo ho so MOT khach hang moi            -> HONEYTOKEN_ACCESS"
as_nv nv_dn01 "SELECT full_name, app.decrypt_text(cccd) FROM app.customers WHERE email = 'kh6001@example.local';"

echo "    app_user: SET ROLE nv_hn01 KHONG co token phien   -> IDENTITY_WITHOUT_SESSION"
docker compose exec -T postgres psql "$APP_URL" -tAc 'SET ROLE nv_hn01; SELECT count(*) FROM app.customers;' >/dev/null 2>&1 || true

echo "    nv_dn01 : UNION SELECT doc password_hash (bi chan) -> SQLI_UNION + ACCESS_DENIED"
as_nv nv_dn01 "SELECT full_name FROM app.customers WHERE full_name LIKE '%x%' UNION SELECT password_hash FROM app.staff;"

echo "    nv_dn01 : UNION SELECT doc username nhan vien    -> SQLI_UNION + STAFF_CREDENTIAL_READ"
as_nv nv_dn01 "SELECT full_name FROM app.customers WHERE full_name LIKE '%x%' UNION SELECT username FROM app.staff;"

echo "    nv_hn01 : dieu kien luon dung OR 1=1            -> SQLI_TAUTOLOGY"
as_nv nv_hn01 "SELECT id, full_name FROM app.customers WHERE full_name = '' OR 1=1;"

echo "    nv_hn01 : do cau truc CSDL qua information_schema -> SQLI_SCHEMA_PROBE"
as_nv nv_hn01 "SELECT c.full_name, t.table_name FROM app.customers c, information_schema.tables t WHERE c.id = 1;"

echo "    nv_dn01 : doc toan bang payments khong WHERE    -> FULL_TABLE_READ"
as_nv nv_dn01 'SELECT id, amount, card_last4 FROM app.payments;'

# ROLLBACK: chi de lai dau vet trong log, khong de lai thay doi trong DB.
echo "    admin_user bi chiem: tat RLS, GRANT PUBLIC (ROLLBACK) -> PRIVILEGE_ESCALATION"
printf "BEGIN;\nSET LOCAL ROLE db_owner;\nALTER TABLE app.customers NO FORCE ROW LEVEL SECURITY;\nGRANT SELECT ON app.customers TO PUBLIC;\nROLLBACK;\nRESET ROLE;\n" \
    | docker compose exec -T postgres psql "postgresql://admin_user:${ADMIN_PASSWORD}@172.28.0.10:5432/secdb" -q >/dev/null 2>&1 || true

# Log collector ghi ra file theo lô - chờ một nhịp cho chắc dòng cuối đã xuống đĩa.
sleep 2

if [ -n "$ANALYZER_IN_DOCKER" ]; then
    echo "==> analyzer dang chay trong Docker, tu ghi canh bao - cho mot nhip..."
    sleep 6
else
    echo "==> Chay analyzer (ghi that vao audit.alerts)"
    # Ma 3: analyzer --watch dang chay tren host va se tu ghi - lan batch nay
    # nhuong de khong ghi trung (xem analyzer/src/pipeline.js).
    rc=0; (cd analyzer && node src/index.js) || rc=$?
    if [ "$rc" -eq 3 ]; then
        echo "    Cho analyzer --watch ghi canh bao..."; sleep 6
    elif [ "$rc" -ne 0 ]; then
        exit "$rc"
    fi
fi

echo "==> Canh bao muc cam/do moi nhat (doc bang dashboard_user):"
docker compose exec -T postgres psql \
    "postgresql://dashboard_user:${DASHBOARD_PASSWORD}@172.28.0.10:5432/secdb" \
    -c "SELECT id, db_user, rule_triggered, risk_score, created_at::timestamptz(0)
        FROM audit.alerts WHERE risk_score >= 60 ORDER BY id DESC LIMIT 8;"
