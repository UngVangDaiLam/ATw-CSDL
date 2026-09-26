#!/usr/bin/env bash
# =============================================================================
# reset.sh - Dựng lại lab từ số 0.
#
#   bash scripts/reset.sh          (hỏi xác nhận)
#   bash scripts/reset.sh --yes    (không hỏi)
#
# Dùng khi sửa bất cứ file nào trong postgres/init/ - các script đó CHỈ chạy
# khi $PGDATA còn trống.
#
# VÌ SAO PHẢI DỌN backup/wal_archive/ CHỨ KHÔNG CHỈ `docker compose down -v`:
# `down -v` xóa volume pgdata, nên cluster mới khởi tạo lại và đánh số WAL từ
# đầu (000000010000000000000001). Nhưng ./backup/wal_archive là thư mục trên
# host nên KHÔNG bị xóa, vẫn còn file cùng tên của cluster cũ. archive_command
#     test ! -f /backup/wal_archive/%f && cp %p /backup/wal_archive/%f
# thấy file đã tồn tại nên trả về 1 -> archiving hỏng vĩnh viễn, kẹt ở segment
# đầu tiên, failed_count tăng không ngừng.
#
# Điều kiện `test ! -f` không phải thứ nên gỡ: nó chính là cái chặn việc ghi đè
# WAL. Nếu gỡ, archive sẽ trộn WAL của hai cluster khác nhau và mọi lần PITR
# sau đó đều cho ra dữ liệu rác - hỏng âm thầm, nguy hiểm hơn nhiều.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

if [ "${1:-}" != "--yes" ]; then
    echo "Thao tac nay se XOA TOAN BO du lieu, WAL archive va log cua lab."
    if [ -t 0 ]; then
        read -r -p "Tiep tuc? [y/N] " a
        case "$a" in [yY]*) ;; *) echo "Da huy."; exit 1 ;; esac
    else
        echo "Chay khong tuong tac - them --yes de xac nhan."; exit 1
    fi
fi

echo "==> Dung stack va xoa volume du lieu"
docker compose down -v

echo "==> Don WAL archive, backup va log cu (giu .gitkeep)"
find backup/wal_archive backup/full logs -type f ! -name '.gitkeep' -delete 2>/dev/null || true
# full_backup.sh tạo mỗi lần một thư mục con - xóa file xong còn vỏ rỗng.
find backup/full -mindepth 1 -type d -empty -delete 2>/dev/null || true

echo "==> Bao dam da co khoa ma hoa (khong ghi de neu da ton tai)"
bash scripts/init-secrets.sh

echo "==> Build va khoi dong lai"
docker compose up -d --build

# Chờ init chạy xong thay vì trả quyền điều khiển ngay. 07_seed.sql mã hóa vài
# nghìn dòng nên khởi tạo mất vài chục giây; chạy verify.sh trong lúc đó sẽ
# thấy bảng còn rỗng hoặc role chưa kịp tạo, và trượt một cách khó hiểu.
#
# PHẢI dò qua TCP, KHÔNG dùng trạng thái `healthy` của container: healthcheck
# trong docker-compose.yml gọi pg_isready qua unix socket, mà trong lúc chạy
# /docker-entrypoint-initdb.d/ thì entrypoint đã dựng sẵn một TEMP SERVER nghe
# trên chính socket đó. Kết quả là container báo "healthy" khi init mới chạy
# được một nửa. Temp server chạy với listen_addresses='' nên không nghe TCP -
# dò qua 172.28.0.10 mới phân biệt được server thật với temp server.
echo "==> Cho database khoi tao xong (co the mat 1-2 phut)"
READY=""
for _ in $(seq 1 90); do
    if docker compose exec -T postgres pg_isready -h 172.28.0.10 -p 5432 -q 2>/dev/null; then
        READY="yes"; break
    fi
    sleep 2
done
[ -n "$READY" ] && echo "==> Database da san sang." \
                || echo "==> CANH BAO: het thoi gian cho. Xem 'docker compose logs postgres'."

echo "==> Xong. Chay 'bash scripts/verify.sh' de nghiem thu."
