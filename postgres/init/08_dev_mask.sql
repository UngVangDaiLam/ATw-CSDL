-- =============================================================================
-- 08_dev_mask.sql  -  LỚP 2b: Che dữ liệu cho môi trường phát triển
--
-- Đổ bản sao ĐÃ CHE của `app` sang schema `dev` (bảng tạo ở 03_schema.sql,
-- quyền ở 04_grants.sql). Chạy SAU 07_seed.sql vì cần dữ liệu để chép.
--
-- Quy tắc che (theo nhu cầu dùng của lập trình viên, không phải "che hết"):
--
--   Trường            Cách xử lý                    Ví dụ
--   ----------------  ----------------------------  -----------------------------
--   full_name         chữ cái đầu mỗi từ            Khach Hang 02 -> K. H. 0***
--   phone             giữ 3 số đầu + 2 số cuối      0901000002    -> 090*****02
--   email             giữ ký tự đầu + tên miền      kh02@example.local -> k***@example.local
--   cccd, cccd_hash   LOẠI BỎ (NULL, có CHECK)      -
--   card_token        LOẠI BỎ (NULL, có CHECK)      -
--   card_last4        giữ nguyên                    4 số cuối là thông tin được phép
--                                                   hiển thị (PCI DSS), app cũng hiện rõ
--   staff.username,   KHÔNG CÓ CỘT trong dev.staff  -
--   db_user,
--   password_hash
--   id, branch_id,    giữ nguyên                    cần cho JOIN, phân bổ chi nhánh,
--   số tiền, trạng                                  thống kê - không định danh ai
--   thái, thời điểm
--
-- Giữ id để quan hệ khách - đơn - thanh toán còn nguyên; nhưng id không đưa
-- được ngược về bản gốc vì dev_user không có quyền nào trên `app`.
--
-- Giới hạn (ghi vào báo cáo): che như trên là GIẢM mức lộ, không phải ẩn danh
-- hóa. Tổ hợp chi nhánh + thời điểm tạo + số tiền đơn hàng vẫn có thể giúp
-- người đã biết sẵn một khách hàng nhận ra họ trong bản sao.
-- =============================================================================

SET ROLE db_owner;

-- Hàm che: thuần (IMMUTABLE), không đọc bảng nào, không cần khóa.
-- 'Nguyen Van An' -> 'N. V. A***' ; NULL -> NULL
CREATE FUNCTION dev.mask_name(p text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path = pg_catalog
AS $$
    SELECT string_agg(
               CASE WHEN ord < n THEN left(w, 1) || '.' ELSE left(w, 1) || '***' END,
               ' ' ORDER BY ord)
    FROM (SELECT w, ord, count(*) OVER () AS n
          FROM regexp_split_to_table(btrim(p), '\s+') WITH ORDINALITY AS t(w, ord)
          WHERE w <> '') AS x;
$$;

-- '0901000002' -> '090*****02'. Số quá ngắn thì che hết.
-- Giữ 5/10 chữ số: redact.js của analyzer coi chuỗi >= 9 chữ số là dữ liệu
-- thật, bản che không bao giờ chạm ngưỡng đó.
CREATE FUNCTION dev.mask_phone(p text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path = pg_catalog
AS $$
    SELECT CASE
        WHEN p IS NULL THEN NULL
        WHEN length(p) < 6 THEN repeat('*', length(p))
        ELSE left(p, 3) || repeat('*', length(p) - 5) || right(p, 2)
    END;
$$;

-- 'kh02@example.local' -> 'k***@example.local'. Không có '@' thì che hết.
-- Giữ tên miền: lập trình viên cần thử luồng theo tên miền (email công ty,
-- email cá nhân...) mà tên miền một mình không định danh được ai.
CREATE FUNCTION dev.mask_email(p text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path = pg_catalog
AS $$
    SELECT CASE
        WHEN p IS NULL THEN NULL
        WHEN position('@' IN p) < 2 THEN '***'
        ELSE left(p, 1) || '***@' || split_part(p, '@', 2)
    END;
$$;

-- -----------------------------------------------------------------------------
-- Làm mới bản sao. CHỈ superuser gọi được, và hàm tự kiểm tra điều đó.
--
-- Vì sao bắt buộc superuser: phải đọc TOÀN BỘ `app` của cả ba chi nhánh. Chỉ
-- superuser bỏ qua được RLS - db_owner bị FORCE ROW LEVEL SECURITY nên đọc ra
-- 0 dòng, và nếu không chặn thì thủ tục sẽ lặng lẽ xóa sạch bản sao rồi chép
-- vào... không gì cả. Cùng bẫy với hàm giải mã SECURITY DEFINER (CLAUDE.md).
--
-- KHÔNG làm thành SECURITY DEFINER sở hữu bởi postgres để cấp cho người khác
-- gọi: đó là một đường đọc vượt RLS cho bất kỳ ai có EXECUTE.
--
-- Cách dùng (sau khi dữ liệu thật thay đổi):
--   docker compose exec postgres psql -U postgres -d secdb -c 'CALL dev.refresh_masked();'
-- -----------------------------------------------------------------------------
CREATE PROCEDURE dev.refresh_masked()
    LANGUAGE plpgsql
    SET search_path = pg_catalog
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
        RAISE EXCEPTION 'dev.refresh_masked() chi chay duoc bang superuser (dang la %)', current_user
            USING HINT = 'Role khac bi RLS loc nen doc app.* ra 0 dong - ban sao se rong ma khong bao loi.';
    END IF;

    TRUNCATE dev.payments, dev.orders, dev.customers, dev.staff, dev.branches;

    INSERT INTO dev.branches (id, code, name, city)
    SELECT id, code, name, city FROM app.branches;

    INSERT INTO dev.staff (id, branch_id, full_name, position, is_active)
    SELECT id, branch_id, dev.mask_name(full_name), position, is_active FROM app.staff;

    INSERT INTO dev.customers (id, branch_id, full_name, phone, email, cccd, cccd_hash, created_at, updated_at)
    SELECT id, branch_id, dev.mask_name(full_name), dev.mask_phone(phone), dev.mask_email(email),
           NULL, NULL, created_at, updated_at
    FROM app.customers;

    INSERT INTO dev.orders (id, customer_id, branch_id, order_no, status, total_amount, created_at)
    SELECT id, customer_id, branch_id, order_no, status, total_amount, created_at FROM app.orders;

    INSERT INTO dev.payments (id, order_id, branch_id, method, amount, card_last4, card_token, paid_at)
    SELECT id, order_id, branch_id, method, amount, card_last4, NULL, paid_at FROM app.payments;

    RAISE NOTICE 'dev.refresh_masked: % khach hang, % don hang, % thanh toan',
        (SELECT count(*) FROM dev.customers), (SELECT count(*) FROM dev.orders),
        (SELECT count(*) FROM dev.payments);
END;
$$;

-- Mặc định PUBLIC có EXECUTE trên mọi hàm/thủ tục mới. Thu hồi theo mô hình
-- whitelist; hàm che vốn vô hại nhưng không role nào cần gọi chúng.
REVOKE ALL ON FUNCTION  dev.mask_name(text)   FROM PUBLIC;
REVOKE ALL ON FUNCTION  dev.mask_phone(text)  FROM PUBLIC;
REVOKE ALL ON FUNCTION  dev.mask_email(text)  FROM PUBLIC;
REVOKE ALL ON PROCEDURE dev.refresh_masked()  FROM PUBLIC;

RESET ROLE;

-- Lần đổ đầu tiên. Init script chạy dưới superuser postgres.
CALL dev.refresh_masked();

ANALYZE dev.customers;
ANALYZE dev.orders;
ANALYZE dev.payments;
