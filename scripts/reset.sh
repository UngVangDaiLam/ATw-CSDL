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

echo "==> Bao dam da co khoa ma hoa (khong ghi de neu da ton tai)"
bash scripts/init-secrets.sh

echo "==> Build va khoi dong lai"
docker compose up -d --build

echo "==> Xong. Chay 'bash scripts/verify.sh' de nghiem thu."
