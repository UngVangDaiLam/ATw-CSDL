#!/usr/bin/env bash
# =============================================================================
# staff-token.sh - Cấp token phiên nhân viên cho script (source, không chạy).
#
#   . scripts/staff-token.sh
#   mint_staff_token TOK nv_hn01             # TOK = token, hạn 1 giờ
#   mint_staff_token OLD nv_hn01 -1          # đã hết hạn (thử nghiệm)
# Ghi vào biến chứ không in ra: gọi kiểu TOK=$(...) chạy trong subshell nên
# danh sách token cần thu hồi ở revoke_minted_tokens bị mất.
#   docker compose exec -T -e PGOPTIONS="-c secdb.staff_token=$TOK" postgres psql ...
#   revoke_minted_tokens                     # gọi ở trap EXIT
#
# Vì sao cần: RLS chỉ mở dữ liệu khi transaction mang token phiên đăng nhập của
# đúng nhân viên đang SET ROLE (postgres/init/06_rls.sql). App lấy token qua
# app.verify_staff_login() bằng mật khẩu nhân viên; script thử nghiệm không có
# mật khẩu đó nên superuser ghi thẳng một dòng app.staff_sessions.
#
# Token KHÔNG BAO GIỜ đi vào câu SQL:
#   - Băm SHA-256 ngay trong bash, superuser chỉ INSERT giá trị băm.
#   - Gắn vào phiên bằng PGOPTIONS (tham số khởi động), không phải
#     set_config('...','<token>') - câu đó nằm nguyên văn trong log pgAudit.
# verify.sh có phép thử grep log tìm token.
# =============================================================================

MINTED_TOKEN_HASHES=()

# mint_staff_token <tên biến> <db_user> [giờ hiệu lực, âm = đã hết hạn]
mint_staff_token() {
    local tok hash n
    tok=$(openssl rand -hex 32) || return 1
    hash=$(printf '%s' "$tok" | sha256sum | cut -c1-64)
    # Đếm số dòng chèn được: sai tên role (hay nhân viên đã bị khóa) thì INSERT
    # ... SELECT vẫn thành công với 0 dòng, và token cấp ra không mở được gì -
    # mọi phép đo sau đó âm thầm đếm 0 dòng.
    n=$(docker compose exec -T postgres psql -U postgres -d "$POSTGRES_DB" -qtAc \
        "WITH ins AS (
           INSERT INTO app.staff_sessions (token_sha256, staff_id, expires_at)
           SELECT '\\x$hash'::bytea, id, now() + interval '${3:-1} hours'
           FROM app.staff WHERE db_user = '$2' AND is_active
           RETURNING 1)
         SELECT count(*) FROM ins;" | tr -d '[:space:]')
    if [ "$n" != "1" ]; then
        echo "mint_staff_token: khong cap duoc token cho '$2' (nhan vien khong ton tai hoac da bi khoa)" >&2
        return 1
    fi
    MINTED_TOKEN_HASHES+=("$hash")
    printf -v "$1" '%s' "$tok"
}

revoke_minted_tokens() {
    [ "${#MINTED_TOKEN_HASHES[@]}" -gt 0 ] || return 0
    local list="" h
    for h in "${MINTED_TOKEN_HASHES[@]}"; do list="$list,'\\x$h'::bytea"; done
    docker compose exec -T postgres psql -U postgres -d "$POSTGRES_DB" -qtAc \
        "DELETE FROM app.staff_sessions WHERE token_sha256 IN (${list#,});" >/dev/null 2>&1 || true
}
