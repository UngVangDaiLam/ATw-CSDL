#!/usr/bin/env bash
# =============================================================================
# benchmark.sh - Đo chi phí hiệu năng của từng lớp bảo mật.
#
#   bash scripts/benchmark.sh                 (mỗi kịch bản 10 giây, ~2-3 phút)
#   BENCH_SECONDS=30 bash scripts/benchmark.sh
#
# Mỗi phép đo là một CẶP kịch bản pgbench (scripts/bench/*.sql) chỉ khác nhau
# đúng ở cơ chế cần đo:
#   A. RLS          - policy tự lọc chi nhánh  vs  superuser tự viết WHERE
#   B. Mã hóa       - đọc/ghi có pgcrypto       vs  cột thường
#   C. Blind index  - tra CCCD qua cccd_hash   vs  giải mã cả bảng rồi so
#   D. pgAudit      - cùng workload, pgaudit.log tắt vs bật (+ số byte log)
#
# Kết quả in ra màn hình và ghi vào docs/benchmark-results.md.
#
# Chạy bằng superuser qua socket, KHÔNG qua app_user/TCP:
#   - analyzer bỏ qua phiên socket (IGNORE_LOCAL_SOCKET) nên hàng chục nghìn
#     câu lệnh benchmark không biến thành cảnh báo rác trong audit.alerts;
#   - superuser mới đặt được pgaudit.log theo phiên (tham số SUSET).
# Kịch bản vẫn SET LOCAL ROLE nv_hn01 nên RLS áp đúng như khi app chạy.
#
# A, B, C chạy với pgaudit.log = none để cô lập đúng cơ chế đang đo (và để
# không sinh vài trăm MB log). Chi phí của pgAudit đo riêng ở D.
#
# Chỉ đọc hoặc ROLLBACK - không để lại dữ liệu. Seed cố định (setseed trong
# 07_seed.sql) nên số đo giữa các lần reset.sh so sánh được với nhau.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
export MSYS_NO_PATHCONV=1

[ -f .env ] || { echo "Khong tim thay .env"; exit 1; }
set -a; . ./.env; set +a

S="${BENCH_SECONDS:-10}"
OUT=docs/benchmark-results.md

su_sql() { docker compose exec -T -u postgres postgres psql -X -d "$POSTGRES_DB" -tAc "$1"; }

# run_bench <file.sql> <none|config>  -> in "latency_ms tps so_giao_dich"
#   none   : tắt pgAudit cho phiên benchmark (qua PGOPTIONS)
#   config : giữ nguyên pgaudit.log của postgresql.conf - đúng cấu hình thật.
#            Không truyền danh sách class qua PGOPTIONS được: PGOPTIONS tách
#            theo dấu cách nên "read, write" vỡ làm hai tham số.
run_bench() {
    local out opts=""
    [ "$2" = none ] && opts="-c pgaudit.log=none"
    out=$(docker compose exec -T -u postgres -e PGOPTIONS="$opts" postgres \
          pgbench -n -c 1 -j 1 -T "$S" -f "/tmp/bench/$1" "$POSTGRES_DB" 2>&1) || {
        echo "LOI khi chay $1:" >&2; echo "$out" >&2; exit 1; }
    printf '%s %s %s\n' \
        "$(printf '%s' "$out" | sed -n 's/^latency average = \([0-9.]*\) ms.*/\1/p')" \
        "$(printf '%s' "$out" | sed -n 's/^tps = \([0-9.]*\) .*/\1/p' | awk '{ printf "%.1f", $1 }')" \
        "$(printf '%s' "$out" | sed -n 's/^number of transactions actually processed: \([0-9]*\).*/\1/p')"
}

# so_sanh <latency mốc> <latency cần so> -> "+12%" hoặc "x35 chậm hơn"
so_sanh() {
    awk -v a="$1" -v b="$2" 'BEGIN {
        if (a <= 0) { print "-"; exit }
        r = b / a;
        if (r >= 2)        printf "chậm hơn %.0f lần\n", r;
        else if (r >= 1)   printf "+%.0f%%\n", (r - 1) * 100;
        else               printf "%.0f%%\n", (r - 1) * 100;
    }'
}

log_bytes() { docker compose exec -T postgres du -sb /var/log/postgresql | cut -f1; }

echo "==> Chep kich ban pgbench vao container"
tar -C scripts/bench -cf - . | docker compose exec -T -u postgres postgres \
    sh -c 'rm -rf /tmp/bench && mkdir -p /tmp/bench && tar -xf - -C /tmp/bench'

echo "==> ANALYZE + lam nong cache"
su_sql "ANALYZE app.customers; ANALYZE app.orders;" >/dev/null
for f in scripts/bench/*.sql; do
    docker compose exec -T -u postgres -e PGOPTIONS="-c pgaudit.log=none" postgres \
        pgbench -n -t 3 -f "/tmp/bench/$(basename "$f")" "$POSTGRES_DB" >/dev/null 2>&1
done

ROWS=""
# add_row <nhóm> <mô tả> <file> <pgaudit.log> [<latency mốc>]
# Ghi kết quả vào biến toàn cục LAT để dòng sau dùng làm mốc.
add_row() {
    local r lat tps n cmp
    printf '    %-34s' "$3" >&2
    r=$(run_bench "$3" "$4"); read -r lat tps n <<<"$r"
    cmp="mốc"; [ -n "${5:-}" ] && cmp=$(so_sanh "$5" "$lat")
    printf '%10s ms %10s tps   %s\n' "$lat" "$tps" "$cmp" >&2
    ROWS+="| $1 | $2 | \`$3\` | $lat | $tps | $cmp |"$'\n'
    LAT="$lat"; NTX="$n"
}

echo "==> Do (moi kich ban ${S}s, 1 client)"
echo "  A. Row-Level Security" >&2
add_row A "Đếm khách 1 chi nhánh — tự viết WHERE, không RLS" a1_scan_manual.sql none;          A1=$LAT
add_row A "Đếm khách 1 chi nhánh — RLS tự lọc"             a2_scan_rls.sql     none "$A1"
add_row A "Tra 1 khách theo id — không RLS"                a3_point_manual.sql none;          A3=$LAT
add_row A "Tra 1 khách theo id — có RLS"                   a4_point_rls.sql    none "$A3"

echo "  B. Ma hoa cot (pgcrypto)" >&2
add_row B "Đọc 100 dòng cột thường (phone)"                b1_read_plain.sql   none;          B1=$LAT
add_row B "Đọc 100 dòng có giải mã CCCD"                   b2_read_decrypt.sql none "$B1"; B2=$LAT
# Tỉ lệ B2/B1 phóng đại vì mốc quá rẻ - con số dùng được là chi phí MỖI LẦN giải mã.
PER_DECRYPT=$(awk -v a="$B1" -v b="$B2" 'BEGIN { printf "%.2f", (b - a) / 100 }')
echo "    -> moi lan giai ma ~ ${PER_DECRYPT} ms" >&2
add_row B "Thêm 1 khách không CCCD"                        b3_insert_plain.sql none;          B3=$LAT
add_row B "Thêm 1 khách có mã hóa + blind index"           b4_insert_encrypt.sql none "$B3"

echo "  C. Blind index" >&2
add_row C "Tra CCCD qua blind index"                       c1_lookup_blind.sql none;          C1=$LAT
add_row C "Tra CCCD bằng cách giải mã cả chi nhánh"        c2_lookup_decrypt_scan.sql none "$C1"

echo "  D. pgAudit" >&2
add_row D "Workload backend — pgaudit tắt"                 d_workload.sql none;               D1=$LAT
sleep 1; BYTES0=$(log_bytes)
add_row D "Workload backend — pgaudit bật (cấu hình thật)" d_workload.sql config "$D1"
sleep 2; BYTES1=$(log_bytes)
LOG_PER_TX=$(( (BYTES1 - BYTES0) / (NTX > 0 ? NTX : 1) ))
LOG_TOTAL_MB=$(awk -v b=$((BYTES1 - BYTES0)) 'BEGIN { printf "%.1f", b / 1048576 }')
echo "    -> log sinh them: ${LOG_TOTAL_MB} MB cho ${NTX} giao dich = ${LOG_PER_TX} byte/giao dich (csv + json)" >&2

# ---------------------------------------------------------------------------
PG_VER=$(su_sql "SHOW server_version;")
CPUS=$(docker compose exec -T postgres nproc)
N_CUST=$(su_sql "SELECT count(*) FROM app.customers;")
N_ORD=$(su_sql "SELECT count(*) FROM app.orders;")
N_B1=$(su_sql "SELECT count(*) FROM app.customers WHERE branch_id = 1;")

mkdir -p docs
cat > "$OUT" <<EOF
# Kết quả đo hiệu năng

> Sinh tự động bởi \`scripts/benchmark.sh\` — chạy lại sẽ ghi đè file này.

| | |
|---|---|
| Thời điểm | $(date '+%Y-%m-%d %H:%M') |
| PostgreSQL | $PG_VER (Docker, $CPUS CPU) |
| Dữ liệu | $N_CUST khách hàng ($N_B1 ở chi nhánh 1), $N_ORD đơn hàng — seed cố định |
| Cách đo | \`pgbench\`, 1 client, ${S} giây mỗi kịch bản, có làm nóng cache trước |

| Nhóm | Phép đo | Kịch bản (\`scripts/bench/\`) | Latency TB (ms) | TPS | So với dòng mốc |
|---|---|---|---:|---:|---|
${ROWS}
Số dẫn xuất:

- Mỗi lần giải mã một CCCD: **~${PER_DECRYPT} ms** (= (B2 − B1) / 100).
- pgAudit (dòng D bật): sinh **${LOG_TOTAL_MB} MB** log cho ${NTX} giao dịch, tức
  khoảng **${LOG_PER_TX} byte/giao dịch** (ghi song song \`.csv\` và \`.json\`).

Phân tích và các đánh đổi: [\`docs/performance.md\`](performance.md).

## Đọc bảng này thế nào

- Mỗi nhóm có một dòng **mốc** (không có cơ chế) và dòng ngay dưới **có** cơ
  chế; cột cuối là chênh lệch latency giữa hai dòng.
- A, B, C chạy với \`pgaudit.log = none\` để cô lập đúng cơ chế đang đo. Chi phí
  pgAudit đo riêng ở D.
- Số tuyệt đối phụ thuộc máy; **tỉ lệ** giữa hai dòng trong cùng nhóm mới là
  thứ đem so sánh được.
EOF

echo "==> Da ghi $OUT"
