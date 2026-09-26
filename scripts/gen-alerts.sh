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

command -v node >/dev/null     || { echo "Can Node.js de chay analyzer."; exit 1; }
[ -d analyzer/node_modules ]   || { echo "Chua cai phu thuoc: cd analyzer && npm install"; exit 1; }
[ -f analyzer/.env ]           || { echo "Thieu analyzer/.env - copy tu analyzer/.env.example"; exit 1; }

APP_URL="postgresql://app_user:${APP_USER_PASSWORD}@172.28.0.10:5432/secdb"
# Chạy dưới danh tính một nhân viên, như backend làm cho mỗi request.
as_nv() { docker compose exec -T postgres psql "$APP_URL" -tAc "SET ROLE $1; $2" >/dev/null 2>&1 || true; }

echo "==> Dien lai cac hanh vi bat thuong"

echo "    nv_hcm01: giai ma CCCD hang loat               -> BULK_DECRYPT"
as_nv nv_hcm01 'SELECT app.decrypt_text(cccd) FROM app.customers;'

echo "    nv_dn01 : UNION SELECT doc password_hash        -> SQLI_UNION + STAFF_CREDENTIAL_READ"
as_nv nv_dn01 "SELECT full_name FROM app.customers WHERE full_name LIKE '%x%' UNION SELECT password_hash FROM app.staff;"

echo "    nv_hn01 : dieu kien luon dung OR 1=1            -> SQLI_TAUTOLOGY"
as_nv nv_hn01 "SELECT id, full_name FROM app.customers WHERE full_name = '' OR 1=1;"

echo "    nv_hn01 : do cau truc CSDL qua information_schema -> SQLI_SCHEMA_PROBE"
as_nv nv_hn01 "SELECT c.full_name, t.table_name FROM app.customers c, information_schema.tables t WHERE c.id = 1;"

echo "    nv_dn01 : doc toan bang payments khong WHERE    -> FULL_TABLE_READ"
as_nv nv_dn01 'SELECT id, amount, card_last4 FROM app.payments;'

# Log collector ghi ra file theo lô - chờ một nhịp cho chắc dòng cuối đã xuống đĩa.
sleep 2

echo "==> Chay analyzer (ghi that vao audit.alerts)"
(cd analyzer && node src/index.js)

echo "==> Canh bao muc cam/do moi nhat (doc bang dashboard_user):"
docker compose exec -T postgres psql \
    "postgresql://dashboard_user:${DASHBOARD_PASSWORD}@172.28.0.10:5432/secdb" \
    -c "SELECT id, db_user, rule_triggered, risk_score, created_at::timestamptz(0)
        FROM audit.alerts WHERE risk_score >= 60 ORDER BY id DESC LIMIT 8;"
