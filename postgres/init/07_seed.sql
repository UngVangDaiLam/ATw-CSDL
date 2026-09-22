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
--
-- -----------------------------------------------------------------------------
-- CẤU TRÚC FILE: dữ liệu chia làm HAI PHẦN, và thứ tự giữa chúng là bắt buộc.
--
--   PHẦN A - vài dòng viết tay, giá trị cố định.
--     scripts/verify.sh ghim cứng các giá trị này (CCCD '001201000001',
--     'Khach Hang 02', số thẻ '4242424242424242'...) nên chúng phải được chèn
--     TRƯỚC để giữ nguyên id 1..5 và để phép thử "giải mã được CCCD chi nhánh
--     mình" với ORDER BY id LIMIT 1 luôn trúng khách hàng của chi nhánh 1.
--     Sửa PHẦN A là phải sửa verify.sh theo.
--
--   PHẦN B - dữ liệu sinh hàng loạt, khối lượng đặt ở các biến bên dưới.
--     Đề bài yêu cầu 5.000-10.000 dòng. Đây không phải yêu cầu hình thức: trên
--     5 dòng thì không đo được chi phí của RLS lẫn chi phí giải mã, và rule
--     "một truy vấn lấy về gần như toàn bộ bảng" của analyzer cũng vô nghĩa vì
--     khi đó LIMIT 5 đã là toàn bộ bảng.
-- -----------------------------------------------------------------------------
-- =============================================================================

SET search_path = app, audit, ext, public;

-- Khối lượng dữ liệu sinh ra ở PHẦN B. Chỉnh ở đây, không rải số trong file.
\set n_customers 6000
\set n_orders    10000
\set n_payments  4000

-- Cố định bộ sinh số ngẫu nhiên. Nhờ vậy hai lần reset.sh cho ra cùng một tập
-- dữ liệu, nên số đo hiệu năng giữa các lần chạy so sánh được với nhau - điều
-- kiện cần để bảng số liệu trong báo cáo có ý nghĩa.
SELECT setseed(0.4242);

-- =============================================================================
-- PHẦN A - dữ liệu viết tay. verify.sh ghim cứng các giá trị dưới đây.
-- =============================================================================

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

-- =============================================================================
-- PHẦN B - dữ liệu sinh hàng loạt
--
-- Sinh bằng generate_series ngay trong database chứ không bằng Faker.js ở tầng
-- ứng dụng. Lý do không phải là tiện: cccd phải đi qua app.encrypt_text() và
-- app.blind_index(), mà hai hàm đó lấy khóa từ ext.master_key() - thứ chỉ
-- database đọc được. Sinh từ Node.js thì hoặc phải đẩy khóa ra ngoài (phá vỡ
-- toàn bộ lớp 2), hoặc phải gọi ngược lại đúng hai hàm này qua từng round-trip
-- mạng cho mỗi dòng.
--
-- KHÔNG có CCCD hay số thẻ nào trùng với PHẦN A: chữ số thứ 5 của CCCD sinh ra
-- luôn là '9', còn PHẦN A luôn là '0'. Điều này cần thiết vì cccd_hash có ràng
-- buộc UNIQUE (blind index chính là thứ chống trùng), và cũng để phép thử
-- pg_dump trong verify.sh không bắt nhầm dòng.
-- =============================================================================

-- Khách hàng: chia đều 3 chi nhánh bằng (g % 3) để RLS có đủ dữ liệu cả ba
-- phía. cccd_plain được tính trong subquery rồi dùng lại hai lần - một lần cho
-- ciphertext, một lần cho blind index - đúng cặp giá trị như app/ vẫn làm.
INSERT INTO app.customers (branch_id, full_name, phone, email, cccd, cccd_hash, created_at)
SELECT s.branch_id,
       s.full_name,
       s.phone,
       s.email,
       app.encrypt_text(s.cccd_plain),
       app.blind_index(s.cccd_plain),
       s.created_at
FROM (
    SELECT 1 + (g % 3)                                    AS branch_id,
           'Khach Hang ' || lpad(g::text, 5, '0')         AS full_name,
           '09' || lpad(g::text, 8, '0')                  AS phone,
           'kh' || g || '@example.local'                  AS email,
           CASE 1 + (g % 3)
               WHEN 1 THEN '0012' WHEN 2 THEN '0482' ELSE '0792'
           END || '9' || lpad(g::text, 7, '0')            AS cccd_plain,
           now() - (random() * 365) * interval '1 day'    AS created_at
    FROM generate_series(1, :n_customers) AS g
) AS s;

-- Đơn hàng: branch_id LẤY TỪ chính khách hàng, không sinh độc lập.
-- Nếu để lệch nhau thì sẽ có đơn hàng thuộc chi nhánh này nhưng khách hàng lại
-- thuộc chi nhánh kia - dữ liệu vô lý, và quan trọng hơn là nó làm hỏng chính
-- thứ đang muốn chứng minh: nhân viên thấy đúng đơn hàng của chi nhánh mình.
-- Phép chia dư trên id để phân bổ khách hàng: id của customers liên tục từ 1.
INSERT INTO app.orders (customer_id, branch_id, order_no, status, total_amount, created_at)
SELECT c.id,
       c.branch_id,
       'ORD-' || lpad(g::text, 7, '0'),
       (ARRAY['new','paid','shipped','cancelled'])[1 + floor(random() * 4)::int],
       round((100000 + random() * 4900000)::numeric, 2),
       c.created_at + (random() * 30) * interval '1 day'
FROM generate_series(1, :n_orders) AS g
JOIN app.customers c
  ON c.id = 1 + (g % (SELECT max(id) FROM app.customers));

-- Thanh toán: chỉ cho đơn đã 'paid'/'shipped'. Số thẻ đầy đủ đi qua
-- app.encrypt_text() y hệt CCCD; card_last4 để rõ vì bốn số cuối là thông tin
-- được phép hiển thị. Đơn chưa thanh toán thì không có dòng payments nào -
-- nhờ vậy số dòng ở đây nhỏ hơn số đơn, giống dữ liệu thật.
INSERT INTO app.payments (order_id, branch_id, method, amount, card_last4, card_token, paid_at)
SELECT o.id,
       o.branch_id,
       o.method,
       o.total_amount,
       CASE WHEN o.method = 'card'
            THEN lpad(((o.id * 7919) % 10000)::text, 4, '0') END,
       CASE WHEN o.method = 'card'
            THEN app.encrypt_text('4' || lpad(((o.id * 7919) % 1000000000000000)::text, 15, '0')) END,
       o.created_at + (random() * 3) * interval '1 hour'
FROM (
    SELECT id, branch_id, total_amount, created_at,
           (ARRAY['cash','card','transfer','ewallet'])[1 + (id % 4)] AS method
    FROM app.orders
    WHERE id > 4                       -- chừa lại các đơn của PHẦN A
      AND status IN ('paid', 'shipped')
    ORDER BY id
    LIMIT :n_payments
) AS o;

-- Thống kê lại sau khi ghi. ANALYZE ngay tại đây chứ không đợi autovacuum:
-- các phép đo chi phí RLS chạy ngay sau reset.sh, mà trình tối ưu dùng thống kê
-- cũ (bảng rỗng) sẽ chọn seq scan cho mọi thứ và cho ra số liệu sai lệch.
ANALYZE app.customers;
ANALYZE app.orders;
ANALYZE app.payments;

DO $$
DECLARE c bigint; o bigint; p bigint;
BEGIN
    SELECT count(*) INTO c FROM app.customers;
    SELECT count(*) INTO o FROM app.orders;
    SELECT count(*) INTO p FROM app.payments;
    RAISE NOTICE '07_seed.sql: % khach hang, % don hang, % thanh toan', c, o, p;
END $$;

-- Một cảnh báo mẫu để dashboard ở bước sau có dữ liệu render ngay.
INSERT INTO audit.alerts (db_user, rule_triggered, risk_score, detail) VALUES
    ('app_user', 'SEED_PLACEHOLDER', 10,
     '{"note": "ban ghi mau tao luc khoi tao, analyzer se ghi de bang du lieu that"}'::jsonb);
