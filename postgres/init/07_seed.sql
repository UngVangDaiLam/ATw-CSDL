-- =============================================================================
-- 07_seed.sql  -  Dữ liệu mẫu
--
-- Chạy dưới quyền superuser `postgres`, KHÔNG `SET ROLE db_owner` như
-- 03_schema.sql. Lý do: 06_rls.sql vừa bật FORCE ROW LEVEL SECURITY, mà
-- db_owner không có policy nào nên mọi INSERT vào customers/orders/payments
-- sẽ bị WITH CHECK từ chối. Superuser bỏ qua RLS nên seed được.
-- (Quy ước SET ROLE db_owner chỉ áp cho DDL - tạo object; đây là DML.)
--
-- Có 3 chi nhánh và mỗi chi nhánh có khách hàng riêng là CỐ Ý: bước RLS cần
-- dữ liệu nhiều chi nhánh mới chứng minh được việc phân tách theo dòng.
--
-- cccd và card_token được mã hóa thật bằng các hàm ở 05_crypto.sql, khóa lấy
-- từ Docker secret. Plaintext chỉ xuất hiện ở đây, trong file seed - không có
-- ở bất kỳ đâu trong database.
-- =============================================================================

SET search_path = app, audit, ext, public;

INSERT INTO app.branches (code, name, city) VALUES
    ('HN01', 'Chi nhanh Ha Noi',      'Ha Noi'),
    ('DN01', 'Chi nhanh Da Nang',     'Da Nang'),
    ('HCM01','Chi nhanh Ho Chi Minh', 'Ho Chi Minh');

-- db_user trỏ tới role PostgreSQL thật. Đây chính là bảng tra cứu mà
-- app.current_branch_id() dùng để quyết định người đang thao tác thuộc
-- chi nhánh nào.
--
-- CỐ Ý không có dòng nào cho `app_user`: app_user chỉ là danh tính kết nối,
-- không phải nhân viên. Chưa SET ROLE thì current_branch_id() trả NULL và
-- app_user đọc ra 0 dòng.
--
-- username/password_hash: tài khoản đăng nhập demo cho app/ (Express).
-- Mật khẩu demo giống nhau cho cả ba, băm bằng bcrypt qua chính pgcrypto
-- (ext.crypt + ext.gen_salt('bf')) ngay trong seed - không hardcode chuỗi
-- hash tĩnh trong repo. Chạy được vì seed đang chạy dưới quyền superuser
-- postgres, bỏ qua REVOKE trên schema ext.
-- readonly_user KHÔNG có username/password: role đó đăng nhập thẳng bằng mật
-- khẩu DB của chính nó (xem .env), không đi qua app/ - app_user không phải
-- thành viên của readonly_user nên không SET ROLE sang được.
INSERT INTO app.staff (branch_id, db_user, username, password_hash, full_name, position) VALUES
    (1, 'nv_hn01',  'hn01',  ext.crypt('Demo@123456', ext.gen_salt('bf')), 'Nguyen Van A', 'Giao dich vien'),
    (2, 'nv_dn01',  'dn01',  ext.crypt('Demo@123456', ext.gen_salt('bf')), 'Tran Thi B',   'Giao dich vien'),
    (3, 'nv_hcm01', 'hcm01', ext.crypt('Demo@123456', ext.gen_salt('bf')), 'Le Van C',     'Truong chi nhanh');

INSERT INTO app.staff (branch_id, db_user, full_name, position) VALUES
    (1, 'readonly_user', 'Pham Thi D', 'Nhan vien bao cao');

-- cccd      = ciphertext (không tất định - mỗi lần chạy lại ra giá trị khác)
-- cccd_hash = blind index HMAC (tất định - dùng để tra cứu và chống trùng)
-- Cả hai đều sinh từ cùng một chuỗi plaintext, qua hai hàm khác nhau.
INSERT INTO app.customers (branch_id, full_name, phone, email, cccd, cccd_hash)
SELECT branch_id, full_name, phone, email,
       app.encrypt_text(cccd_plain),
       app.blind_index(cccd_plain)
FROM (VALUES
    (1, 'Khach Hang 01', '0901000001', 'kh01@example.local', '001201000001'),
    (1, 'Khach Hang 02', '0901000002', 'kh02@example.local', '001201000002'),
    (2, 'Khach Hang 03', '0901000003', 'kh03@example.local', '048202000003'),
    (2, 'Khach Hang 04', '0901000004', 'kh04@example.local', '048202000004'),
    (3, 'Khach Hang 05', '0901000005', 'kh05@example.local', '079203000005')
) AS t(branch_id, full_name, phone, email, cccd_plain);

INSERT INTO app.orders (customer_id, branch_id, order_no, status, total_amount) VALUES
    (1, 1, 'ORD-0001', 'paid',    1250000.00),
    (2, 1, 'ORD-0002', 'new',      480000.00),
    (3, 2, 'ORD-0003', 'shipped', 2300000.00),
    (5, 3, 'ORD-0004', 'paid',     990000.00);

-- card_last4 để rõ (không nhạy cảm, dùng để hiển thị),
-- số thẻ đầy đủ chỉ tồn tại ở dạng đã mã hóa trong card_token.
INSERT INTO app.payments (order_id, branch_id, method, amount, card_last4, card_token)
SELECT order_id, branch_id, method, amount, card_last4,
       app.encrypt_text(card_plain)
FROM (VALUES
    (1, 1, 'card',     1250000.00, '4242', '4242424242424242'),
    (3, 2, 'transfer', 2300000.00, NULL,   NULL),
    (4, 3, 'ewallet',   990000.00, NULL,   NULL)
) AS t(order_id, branch_id, method, amount, card_last4, card_plain);

-- Một cảnh báo mẫu để dashboard ở bước sau có dữ liệu render ngay.
INSERT INTO audit.alerts (db_user, rule_triggered, risk_score, detail) VALUES
    ('app_user', 'SEED_PLACEHOLDER', 10,
     '{"note": "ban ghi mau tao luc khoi tao, analyzer se ghi de bang du lieu that"}'::jsonb);
