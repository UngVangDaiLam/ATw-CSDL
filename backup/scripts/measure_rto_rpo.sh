#!/usr/bin/env bash
# =============================================================================
# measure_rto_rpo.sh - LỚP 4: ĐO RTO/RPO thật, ghi docs/rto-rpo-results.md
#
#   bash backup/scripts/measure_rto_rpo.sh --yes              (3 lần PITR)
#   bash backup/scripts/measure_rto_rpo.sh --yes --runs 5
#   B_SECONDS=600 bash backup/scripts/measure_rto_rpo.sh --yes  (đo kịch bản B lâu hơn)
#
# CẢNH BÁO: kịch bản A THỰC SỰ xóa app.orders + app.payments rồi khôi phục
# bằng PITR trên database đang chạy (như demo_pitr.sh), lặp --runs lần. Mỗi lần
# sinh một timeline mới. Chạy trên lab, không chạy khi đang demo.
#
# Ba kịch bản, đo bằng đồng hồ thật, không ước lượng:
#
#   A. XÓA NHẦM -> PITR về ngay trước sự cố (pitr_restore.sh, database thật)
#      RTO = từ lúc bắt đầu khôi phục tới khi database nhận lại kết nối TCP.
#            Tách theo từng bước của pitr_restore.sh. KHÔNG tính thời gian
#            phát hiện sự cố và chọn mốc - phần đó là con người.
#      RPO = hai con số khác nhau, đừng gộp:
#        - độ chính xác: giao dịch cuối cùng được giữ lại cách mốc bao xa,
#          và có giao dịch nào commit TRƯỚC mốc bị mất không (phải là 0);
#        - cái giá: mọi giao dịch hợp lệ SAU mốc đều mất (PITR quay lui cả
#          cluster, không chọn lọc) - đo bằng số giao dịch và khoảng thời gian.
#
#   B. MẤT MÁY CHỦ, chỉ còn kho WAL archive (không phá gì, chỉ quan sát)
#      Tại mỗi thời điểm t, thứ còn cứu được là những gì đã nằm trong kho
#      archive. RPO(t) = t - thời điểm của giao dịch MỚI NHẤT mà toàn bộ WAL
#      của nó đã nằm trong kho. Lấy mẫu liên tục trong B_SECONDS giây khi có
#      tải ghi đều, báo min/trung vị/p95/max. Giới hạn lý thuyết là
#      archive_timeout (60s) + thời gian mã hóa/ghi một segment.
#      LƯU Ý: trong lab kho archive nằm CÙNG máy - mất máy là mất cả kho. Con số
#      này là RPO nếu kho được đặt ở máy khác (hướng phát triển), không phải
#      RPO của cấu hình hiện tại (cấu hình hiện tại: mất hết).
#
#   C. KHÔI PHỤC LOGIC từ pg_dump vào một database mới (không đụng secdb)
#      Đo thời gian giải mã + pg_restore, so số dòng và thử giải mã một CCCD
#      trên bản khôi phục (bản sao vô dụng nếu mất khóa pgcrypto).
#
# Đo giao dịch bằng bảng thăm dò rpo_probe.tick: một tiến trình ghi 5 dòng/giây,
# mỗi dòng mang clock_timestamp() và vị trí WAL (LSN) ngay trước khi ghi. Dòng
# k chắc chắn đã nằm trọn trong một segment X nếu dòng k+1 bắt đầu ở LSN <= cuối
# segment X (dòng k+1 chỉ được ghi SAU khi dòng k đã commit). Schema rpo_probe
# do superuser tạo, không GRANT cho ai, bị xóa khi script kết thúc.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.." || exit 1

RUNS=3; YES=""
while [ $# -gt 0 ]; do
    case "$1" in
        --yes)  YES=1 ;;
        --runs) RUNS="${2:?--runs can mot so}"; shift ;;
        *) echo "Tham so la: $1"; exit 1 ;;
    esac
    shift
done
B_SECONDS="${B_SECONDS:-300}"
HZ=5                       # tốc độ ghi của tiến trình thăm dò (giao dịch/giây)

if [ -z "$YES" ]; then
    echo "Script nay XOA app.orders/app.payments roi PITR $RUNS lan tren database dang chay."
    echo "Them --yes de xac nhan."; exit 1
fi

[ -f .env ] || { echo "Khong tim thay .env"; exit 1; }
set -a; . ./.env; set +a
. backup/scripts/lib.sh

OUT=docs/rto-rpo-results.md
TMPD="$(mktemp -d)"
APP_URL="postgresql://app_user:${APP_USER_PASSWORD}@172.28.0.10:5432/secdb"

now_ms() { date +%s%3N; }
secs()   { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f", (b - a) / 1000 }'; }
log()    { printf '\033[1;36m== %s\033[0m\n' "$*" >&2; }

TICKER_PID=""
cleanup() {
    [ -n "$TICKER_PID" ] && kill "$TICKER_PID" 2>/dev/null || true
    _su "DROP SCHEMA IF EXISTS rpo_probe CASCADE;" >/dev/null 2>&1 || true
    _su "DROP DATABASE IF EXISTS secdb_restore_drill;" >/dev/null 2>&1 || true
    rm -rf "$TMPD"
}
trap cleanup EXIT

# ticker <run> <giây> - chạy nền, ghi HZ dòng/giây. COMMIT từng dòng trong
# PROCEDURE nên mỗi dòng là một giao dịch riêng, như tải nghiệp vụ thật.
ticker() {
    docker compose exec -T -u postgres postgres psql -X -q -d "$POSTGRES_DB" \
        -c "CALL rpo_probe.ticker('$1', $2, $HZ);" >/dev/null 2>&1 &
    TICKER_PID=$!
}
wait_ticker() { wait "$TICKER_PID" 2>/dev/null || true; TICKER_PID=""; }

counts() {
    _su "SELECT (SELECT count(*) FROM app.orders) || '/' || (SELECT count(*) FROM app.payments)
             || '/' || (SELECT coalesce(sum(total_amount), 0) FROM app.orders);"
}

# -----------------------------------------------------------------------------
log "Chuan bi bang tham do rpo_probe"
_su "DROP SCHEMA IF EXISTS rpo_probe CASCADE;" >/dev/null
_su "CREATE SCHEMA rpo_probe;
     CREATE TABLE rpo_probe.tick (
         id  bigserial PRIMARY KEY,
         run text        NOT NULL,
         ts  timestamptz NOT NULL,
         lsn pg_lsn      NOT NULL);
     CREATE PROCEDURE rpo_probe.ticker(p_run text, p_seconds int, p_hz int)
     LANGUAGE plpgsql AS \$\$
     DECLARE t_end timestamptz := clock_timestamp() + make_interval(secs => p_seconds);
     BEGIN
         WHILE clock_timestamp() < t_end LOOP
             INSERT INTO rpo_probe.tick (run, ts, lsn)
             VALUES (p_run, clock_timestamp(), pg_current_wal_insert_lsn());
             COMMIT;
             PERFORM pg_sleep(1.0 / p_hz);
         END LOOP;
     END \$\$;" >/dev/null

PG_VER=$(_su "SELECT version();" | sed -E 's/^PostgreSQL ([0-9.]+).*/\1/')
NCPU=$(docker compose exec -T postgres nproc | tr -d '\r')
DB_SIZE=$(_su "SELECT pg_size_pretty(pg_database_size(current_database()));")
SEG_BYTES=$(_su "SELECT pg_size_bytes(current_setting('wal_segment_size'));")
ARCH_TIMEOUT=$(_su "SHOW archive_timeout;")
N_CUST=$(_su "SELECT count(*) FROM app.customers;")

# -----------------------------------------------------------------------------
log "Sao luu day du (do thoi gian sao luu)"
T0=$(now_ms)
bash backup/scripts/full_backup.sh > "$TMPD/backup.log" 2>&1
T1=$(now_ms)
BACKUP_SECS=$(secs "$T0" "$T1")
BASE=$(ls -d backup/full/2*/ | tail -1 | xargs basename)
BASE_SIZE=$(du -sh "backup/full/$BASE" | cut -f1)
echo "   $BASE: ${BACKUP_SECS}s, $BASE_SIZE" >&2

# -----------------------------------------------------------------------------
log "C. Khoi phuc logic tu pg_dump vao database moi"
_su "DROP DATABASE IF EXISTS secdb_restore_drill;" >/dev/null
T0=$(now_ms)
docker compose exec -T -u postgres postgres bash -c "set -o pipefail
    createdb secdb_restore_drill &&
    backup-crypt.sh decrypt /backup/full/$BASE/secdb.dump.gpg - |
        pg_restore -d secdb_restore_drill --exit-on-error" > "$TMPD/restore_logic.log" 2>&1 \
    && C_OK=1 || C_OK=""
T1=$(now_ms)
C_SECS=$(secs "$T0" "$T1")
q_drill() { docker compose exec -T -u postgres postgres psql -X -d secdb_restore_drill -tAc "$1"; }
if [ -n "$C_OK" ]; then
    C_ROWS=$(q_drill "SELECT (SELECT count(*) FROM app.customers) || '/' || (SELECT count(*) FROM app.orders) || '/' || (SELECT count(*) FROM app.payments);")
    C_DECRYPT=$(q_drill "SELECT app.decrypt_text(cccd) = '001201000001' FROM app.customers WHERE id = 1;")
else
    C_ROWS="loi"; C_DECRYPT="loi"; tail -5 "$TMPD/restore_logic.log" >&2
fi
LIVE_ROWS=$(_su "SELECT (SELECT count(*) FROM app.customers) || '/' || (SELECT count(*) FROM app.orders) || '/' || (SELECT count(*) FROM app.payments);")
_su "DROP DATABASE IF EXISTS secdb_restore_drill;" >/dev/null
echo "   ${C_SECS}s, so dong $C_ROWS (ban goc $LIVE_ROWS), giai ma: $C_DECRYPT" >&2

# -----------------------------------------------------------------------------
log "B. Mat may chu: lay mau RPO trong ${B_SECONDS}s co tai ghi deu ($HZ giao dich/giay)"
TL=$(_su "SELECT substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8);")
ticker B $((B_SECONDS + 10))
END_B=$(( $(date +%s) + B_SECONDS ))
: > "$TMPD/rpo_b.txt"
while [ "$(date +%s)" -lt "$END_B" ]; do
    # Segment mới nhất ĐÃ NẰM TRONG KHO (file chỉ mang tên thật sau khi ghi
    # xong - backup-crypt.sh ghi .tmp rồi mv). Đọc kho TRƯỚC, lấy giờ SAU: sai
    # số nếu có chỉ làm RPO lớn lên, không bao giờ đẹp hơn thực tế.
    SEG=$(ls backup/wal_archive 2>/dev/null | grep -E "^${TL}[0-9A-F]{16}$" | sort | tail -1)
    T_NOW=$(_su "SELECT clock_timestamp();")
    if [ -n "$SEG" ]; then
        R=$(_su "WITH s AS (
                     SELECT ('x' || substr('$SEG', 9, 8))::bit(32)::bigint * 4294967296
                          + ('x' || substr('$SEG', 17, 8))::bit(32)::bigint * $SEG_BYTES
                          + $SEG_BYTES AS end_off)
                 SELECT round(extract(epoch FROM ('$T_NOW'::timestamptz - max(t1.ts)))::numeric, 2)
                 FROM rpo_probe.tick t1
                 JOIN rpo_probe.tick t2 ON t2.id = t1.id + 1 AND t2.run = t1.run, s
                 WHERE t1.run = 'B' AND t2.lsn <= '0/0'::pg_lsn + s.end_off;")
        [ -n "$R" ] && echo "$R" >> "$TMPD/rpo_b.txt"
    fi
    sleep 2
done
wait_ticker
B_N=$(wc -l < "$TMPD/rpo_b.txt" | tr -d ' ')
B_STATS=$(sort -n "$TMPD/rpo_b.txt" | awk '{ v[NR] = $1; s += $1 }
    END { if (NR == 0) { print "- - - - -"; exit }
          p = int(NR * 0.95 + 0.999); if (p > NR) p = NR
          printf "%.1f %.1f %.1f %.1f %.1f", v[1], v[int((NR + 1) / 2)], s / NR, v[p], v[NR] }')
read -r B_MIN B_MED B_AVG B_P95 B_MAX <<< "$B_STATS"
echo "   $B_N mau: min ${B_MIN}s, trung vi ${B_MED}s, TB ${B_AVG}s, p95 ${B_P95}s, max ${B_MAX}s" >&2

# -----------------------------------------------------------------------------
# A. Xóa nhầm -> PITR, lặp RUNS lần
A_ROWS=""
for i in $(seq 1 "$RUNS"); do
    log "A. Lan $i/$RUNS: sao luu -> tai ghi -> xoa nham -> PITR"
    [ "$i" -gt 1 ] && bash backup/scripts/full_backup.sh > "$TMPD/backup_$i.log" 2>&1
    RUN="A$i"
    ticker "$RUN" 40
    sleep 20
    BEFORE=$(counts)
    # Mốc khôi phục: thời điểm "còn tốt" cuối cùng, ngay trước lệnh xóa - đúng
    # thứ quản trị viên sẽ đọc ra từ log pgAudit của câu DELETE.
    T_TARGET=$(_su "SELECT clock_timestamp()::text;")
    _su "BEGIN; DELETE FROM app.payments; DELETE FROM app.orders; COMMIT;" >/dev/null
    wait_ticker
    sleep 1
    AFTER_INC=$(counts)
    N_BEFORE_T=$(_su "SELECT count(*) FROM rpo_probe.tick WHERE run = '$RUN' AND ts <= '$T_TARGET';")
    N_AFTER_T=$(_su "SELECT count(*) FROM rpo_probe.tick WHERE run = '$RUN' AND ts > '$T_TARGET';")

    # Mốc bắt đầu khôi phục theo đồng hồ của DATABASE - để trừ với T_TARGET
    # (cũng là giờ database). Đồng hồ VM của Docker Desktop có thể lệch máy host.
    T_RESTORE=$(_su "SELECT clock_timestamp()::text;")
    T0=$(now_ms)
    set +e
    bash backup/scripts/pitr_restore.sh "$T_TARGET" --yes 2>&1 \
        | while IFS= read -r l; do printf '%s %s\n' "$(now_ms)" "$l"; done > "$TMPD/pitr_$i.log"
    RC=${PIPESTATUS[0]}
    set -e
    T_END=$(now_ms)
    [ "$RC" -eq 0 ] || { echo "LOI: pitr_restore.sh that bai (lan $i):" >&2; tail -20 "$TMPD/pitr_$i.log" >&2; exit 1; }

    # Mốc thời gian của từng bước, đọc từ dòng "==> [k/6]" của pitr_restore.sh
    step_t() { awk -v k="[$1/6]" 'index($0, "==> " k) { print $1; exit }' "$TMPD/pitr_$i.log"; }
    S1=$(step_t 1); S2=$(step_t 2); S3=$(step_t 3); S4=$(step_t 4); S5=$(step_t 5); S6=$(step_t 6)
    RTO_DB=$(secs "$T0" "$S6")

    AFTER=$(counts)
    APP_OK=$(docker compose exec -T postgres psql "$APP_URL" -tAc "SELECT 'ok';" 2>&1 | tr -d '\r')
    KEPT_BEFORE_T=$(_su "SELECT count(*) FROM rpo_probe.tick WHERE run = '$RUN' AND ts <= '$T_TARGET';")
    KEPT_AFTER_T=$(_su "SELECT count(*) FROM rpo_probe.tick WHERE run = '$RUN' AND ts > '$T_TARGET';")
    GAP_MS=$(_su "SELECT round(extract(epoch FROM ('$T_TARGET'::timestamptz - max(ts))) * 1000) FROM rpo_probe.tick WHERE run = '$RUN';")
    LOST_WINDOW=$(_su "SELECT round(extract(epoch FROM ('$T_RESTORE'::timestamptz - '$T_TARGET'::timestamptz))::numeric, 1);")
    [ "$BEFORE" = "$AFTER" ] && MATCH="khop" || MATCH="KHONG KHOP ($BEFORE -> $AFTER)"

    A_ROWS="$A_ROWS| $i | $(secs "$S1" "$S2") | $(secs "$S2" "$S3") | $(secs "$S3" "$S4") | $(secs "$S4" "$S5") | $(secs "$S5" "$S6") | **$RTO_DB** | $(secs "$S6" "$T_END") | $((N_BEFORE_T - KEPT_BEFORE_T)) / $N_BEFORE_T | $GAP_MS | $N_AFTER_T (mat $((N_AFTER_T - KEPT_AFTER_T))) / ${LOST_WINDOW}s | $MATCH, app: ${APP_OK} |
"
    echo "   RTO ${RTO_DB}s | mat truoc moc: $((N_BEFORE_T - KEPT_BEFORE_T)) | cach moc ${GAP_MS}ms | du lieu: $MATCH" >&2
    echo "$RTO_DB" >> "$TMPD/rto.txt"
done

RTO_STATS=$(sort -n "$TMPD/rto.txt" | awk '{ v[NR] = $1; s += $1 } END { printf "%.1f %.1f %.1f", v[1], s / NR, v[NR] }')
read -r RTO_MIN RTO_AVG RTO_MAX <<< "$RTO_STATS"

# -----------------------------------------------------------------------------
cat > "$OUT" <<EOF
# Kết quả đo RTO / RPO

> Sinh tự động bởi \`backup/scripts/measure_rto_rpo.sh\` — chạy lại sẽ ghi đè file này.

| | |
|---|---|
| Thời điểm | $(date '+%Y-%m-%d %H:%M') |
| PostgreSQL | $PG_VER (Docker, $NCPU CPU) |
| Dữ liệu | $N_CUST khách hàng, database $DB_SIZE |
| Bản sao lưu đầy đủ | $BASE_SIZE (base backup + pg_dump, đã mã hóa), tạo mất **${BACKUP_SECS} s** |
| WAL | segment $((SEG_BYTES / 1048576)) MB, \`archive_timeout = $ARCH_TIMEOUT\`, mỗi segment mã hóa gpg trước khi vào kho |
| Tải ghi khi đo | $HZ giao dịch/giây (bảng thăm dò \`rpo_probe.tick\`, mỗi dòng một giao dịch) |

## A. Xóa nhầm dữ liệu → PITR về ngay trước sự cố

Superuser xóa sạch \`app.orders\` + \`app.payments\`; mốc khôi phục là thời điểm
ngay trước lệnh \`DELETE\`. Khôi phục bằng \`pitr_restore.sh\` trên database thật.
Lặp $RUNS lần, mỗi lần có base backup mới.

**RTO** (từ lúc bắt đầu khôi phục tới khi database nhận lại kết nối TCP):
min **${RTO_MIN} s**, trung bình **${RTO_AVG} s**, max **${RTO_MAX} s**.
Không gồm thời gian phát hiện sự cố và chọn mốc.

| Lần | Đẩy WAL (s) | Dừng dịch vụ (s) | Dựng lại từ base backup (s) | Replay WAL + promote (s) | Dọn cấu hình, chờ TCP (s) | **RTO (s)** | Ghi bù cảnh báo (s) | GD trước mốc bị mất | Giao dịch cuối giữ lại cách mốc (ms) | GD sau mốc / khoảng mất | Dữ liệu nghiệp vụ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
$A_ROWS
Đọc bảng:

- **GD trước mốc bị mất = 0** nghĩa là mọi giao dịch đã commit trước mốc đều về
  đủ — RPO tính tới mốc bằng 0. "Cách mốc" nhỏ hơn chu kỳ ghi ($((1000 / HZ)) ms)
  nghĩa là PITR dừng đúng tại giao dịch cuối trước mốc.
- **GD sau mốc / khoảng mất** là cái giá của PITR: mọi giao dịch hợp lệ commit
  sau mốc cũng mất, vì PITR quay lui cả cluster. Khoảng mất = từ mốc tới lúc
  bắt đầu khôi phục — càng phát hiện chậm càng mất nhiều.
- Dữ liệu nghiệp vụ: số đơn hàng / thanh toán / tổng tiền sau khôi phục so với
  ngay trước sự cố; \`app: ok\` là \`app_user\` kết nối lại được qua TLS.

## B. Mất máy chủ, chỉ còn kho WAL (lấy mẫu, không phá gì)

RPO(t) = t − thời điểm của giao dịch mới nhất mà toàn bộ WAL của nó đã nằm
trong kho archive. Lấy mẫu mỗi ~2 s trong ${B_SECONDS} s.

| Số mẫu | Min (s) | Trung vị (s) | Trung bình (s) | p95 (s) | **Max (s)** |
|---:|---:|---:|---:|---:|---:|
| $B_N | $B_MIN | $B_MED | $B_AVG | $B_P95 | **$B_MAX** |

Giới hạn lý thuyết: \`archive_timeout\` ($ARCH_TIMEOUT) + thời gian mã hóa và ghi
một segment. **Trong lab kho archive nằm cùng máy với database**, nên mất máy
chủ thật là mất cả kho — con số trên là RPO *nếu* kho được đặt ở máy khác.

## C. Khôi phục logic từ \`pg_dump\`

Giải mã \`secdb.dump.gpg\` và \`pg_restore\` vào một database mới, không đụng \`secdb\`.

| Thời gian (s) | Số dòng khách/đơn/thanh toán | Bản gốc | Giải mã được CCCD trên bản khôi phục |
|---:|---|---|---|
| $C_SECS | $C_ROWS | $LIVE_ROWS | $C_DECRYPT |

Bản dump chỉ là ảnh chụp tại lúc sao lưu: RPO của cách này là khoảng cách tới
lần \`full_backup.sh\` gần nhất. Giải mã được CCCD vì bản khôi phục chạy trên
cùng server có khóa \`pgcrypto_key\` — mất khóa thì cột \`cccd\`/\`card_token\` vô dụng.

## Giới hạn của phép đo

- Một máy, database vài chục MB, $RUNS lần lặp — số tuyệt đối phụ thuộc phần cứng
  và tăng theo dung lượng (bước dựng lại từ base backup tỉ lệ với kích thước data).
- Tải ghi tổng hợp, 1 tiến trình; tải thật nhiều client sinh WAL nhanh hơn nên
  segment đầy trước \`archive_timeout\` và RPO kịch bản B nhỏ hơn.
- RTO không gồm thời gian con người phát hiện sự cố và quyết định mốc.
EOF

log "Xong. Ket qua: $OUT"
