#!/usr/bin/env bash
# =============================================================================
# backup-crypt.sh - LỚP 4: mã hóa mọi thứ rời khỏi database ra kho sao lưu.
#
#   backup-crypt.sh encrypt <vào|-> <ra|->          (gzip/dump đã nén: không nén lại)
#   backup-crypt.sh decrypt <vào|-> <ra|->
#   backup-crypt.sh wal-archive <%p> <%f>          (archive_command)
#   backup-crypt.sh wal-restore <%f> <%p>          (restore_command)
#
# VÌ SAO: lớp 2 chỉ mã hóa cột cccd/card_token. Bản sao lưu vật lý, pg_dump và
# từng segment WAL vẫn chứa họ tên, số điện thoại, đơn hàng ở dạng RÕ - và kho
# sao lưu là thứ được chép đi nơi khác, giữ lâu nhất, ít được canh nhất.
#
# CÁCH LÀM: OpenPGP đối xứng (gpg, AES-256) có kiểm tra toàn vẹn (MDC) - sửa một
# byte trong file là giải mã báo "message has been manipulated" và thoát mã
# khác 0. Nhờ vậy kẻ ghi được vào kho WAL cũng KHÔNG cấy được segment giả để
# PITR replay: không có khóa thì không tạo được file giải mã hợp lệ.
#
# KHÓA: /run/secrets/backup_key - Docker secret RIÊNG, khác pgcrypto_key. Lộ
# khóa sao lưu thì CCCD trong bản sao lưu vẫn là ciphertext của lớp 2; lộ khóa
# cột thì bản sao lưu vẫn khóa. Chỉ container postgres và hai container PITR
# nhận khóa này. MẤT khóa = mất mọi bản sao lưu - ngoài lab phải cất một bản ở
# nơi khác máy chủ (két, KMS), nếu không mã hóa backup thành tự hủy backup.
#
# Plaintext KHÔNG BAO GIỜ chạm thư mục /backup (bind mount ra host): mã hóa đi
# thẳng từ pipe hoặc từ /tmp trong container.
# =============================================================================
set -euo pipefail

KEY=/run/secrets/backup_key
ARCHIVE=/backup/wal_archive

die() { echo "backup-crypt: $*" >&2; exit 1; }
[ -s "$KEY" ] || die "thieu $KEY - chay 'bash scripts/init-secrets.sh' tren host roi tao lai container"

# gpg 2.x luôn đi qua gpg-agent, kể cả mã hóa đối xứng với --batch. Mỗi lần gọi
# dùng một homedir tạm và tắt agent khi xong - nếu không, mỗi segment WAL bỏ lại
# một tiến trình gpg-agent sống mãi trong container.
GH="$(mktemp -d /tmp/gnupg.XXXXXX)"
cleanup() { gpgconf --homedir "$GH" --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$GH"; }
trap cleanup EXIT

# --no-symkey-cache: agent không giữ khóa trong bộ nhớ sau khi xong việc.
G=(gpg --batch --quiet --no-tty --homedir "$GH" --pinentry-mode loopback
   --passphrase-file "$KEY" --no-symkey-cache)

# encrypt <vào> <ra> [nén: none|zlib]
encrypt() {
    "${G[@]}" --symmetric --cipher-algo AES256 --compress-algo "${3:-none}" \
        --output "$2" "$1"
}
decrypt() { "${G[@]}" --decrypt --output "$2" "$1"; }

case "${1:-}" in
    encrypt) encrypt "${2:?vao}" "${3:?ra}" none ;;
    decrypt) decrypt "${2:?vao}" "${3:?ra}" ;;

    wal-archive)
        SRC="${2:?%p}"; NAME="${3:?%f}"; DST="$ARCHIVE/$NAME"
        # Giữ nguyên điều kiện `test ! -f` của archive_command cũ: KHÔNG ghi đè
        # segment đã có (cluster cũ cùng tên - CLAUDE.md "Bẫy 1"). Trả mã khác 0
        # để postgres giữ segment lại và thử lại, failed_count tăng.
        [ ! -f "$DST" ] || die "$DST da ton tai - khong ghi de"
        # Ghi ra file tạm rồi đổi tên: postgres có thể bị dừng giữa chừng, một
        # file mã hóa dở dang mang đúng tên segment sẽ làm hỏng mọi lần PITR.
        # WAL chưa nén (16 MB, phần lớn là 0 khi bị switch sớm) - zlib thu nhỏ đáng kể.
        TMP="$ARCHIVE/.$NAME.tmp"
        rm -f "$TMP"
        if encrypt "$SRC" "$TMP" zlib; then mv "$TMP" "$DST"
        else rm -f "$TMP"; exit 1; fi
        ;;

    wal-restore)
        NAME="${2:?%f}"; DST="${3:?%p}"; SRC="$ARCHIVE/$NAME"
        # Không có file là chuyện bình thường (recovery dò segment/.history kế
        # tiếp để biết đã hết WAL) - thoát 1 im lặng, đừng in lỗi.
        [ -f "$SRC" ] || exit 1
        decrypt "$SRC" "$DST"
        ;;

    *) die "lenh khong hop le: ${1:-<trong>} (encrypt|decrypt|wal-archive|wal-restore)" ;;
esac
