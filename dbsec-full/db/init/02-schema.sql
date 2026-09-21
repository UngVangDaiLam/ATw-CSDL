-- Schema chính cho đồ án "Bảo mật cơ sở dữ liệu nhiều lớp trên PostgreSQL".
-- Mỗi bảng/cột được thiết kế để phục vụ đúng một tính năng phòng thủ sẽ demo
-- ở các tuần sau — xem comment ở từng cột.

-- ============================================================
-- BRANCHES — không có trong đề xuất gốc, thêm vào để branch_id
-- có nghĩa thật (tên chi nhánh) khi demo RLS, thay vì chỉ là số.
-- ============================================================
CREATE TABLE branches (
    id            serial PRIMARY KEY,
    ma_chi_nhanh  text NOT NULL UNIQUE,   -- vd: 'HN', 'HCM'
    ten_chi_nhanh text NOT NULL           -- vd: 'Hà Nội', 'Hồ Chí Minh'
);

COMMENT ON TABLE branches IS 'Danh sách chi nhánh, dùng làm biên giới cho Row-Level Security (Tuần 4).';

-- ============================================================
-- STAFF — tài khoản nhân viên. staff.role dùng để demo least
-- privilege ở tầng ứng dụng; DB user riêng (app_user/readonly_user/
-- admin_user) mới là least privilege ở tầng database (Tuần 3).
-- ============================================================
CREATE TABLE staff (
    id            serial PRIMARY KEY,
    username      text NOT NULL UNIQUE,
    password_hash text NOT NULL,          -- bcrypt/argon2 hash, KHÔNG BAO GIỜ lưu plaintext
    role          text NOT NULL CHECK (role IN ('admin', 'manager', 'sales')),
    branch_id     integer NOT NULL REFERENCES branches(id),
    created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN staff.role IS 'Vai trò ở tầng ứng dụng. Việc chặn thật sự (least privilege) phải nằm ở DB user, không phải cột này — cột này chỉ quyết định UI hiển thị gì.';
COMMENT ON COLUMN staff.branch_id IS 'Chi nhánh của nhân viên — session variable app.branch_id (Tuần 4) sẽ được set từ giá trị này sau khi đăng nhập.';

-- ============================================================
-- CUSTOMERS — bảng trung tâm để demo RLS (branch_id) và
-- mã hóa cột (cccd).
-- ============================================================
CREATE TABLE customers (
    id          serial PRIMARY KEY,
    ho_ten      text NOT NULL,
    email       text,
    sdt         text,
    cccd        bytea,                     -- sẽ lưu pgp_sym_encrypt(...) từ Tuần 5, KHÔNG lưu plaintext
    dia_chi     text,
    branch_id   integer NOT NULL REFERENCES branches(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN customers.branch_id IS 'Cột biên giới cho RLS: nhân viên chi nhánh A không được thấy khách chi nhánh B, kể cả nếu app quên kiểm tra quyền.';
COMMENT ON COLUMN customers.cccd IS 'Số căn cước công dân — dữ liệu nhạy cảm theo Nghị định 13/2023/NĐ-CP. Mã hóa bằng pgcrypto (Tuần 5), kiểu bytea vì dữ liệu mã hóa là nhị phân, không phải text.';

CREATE INDEX idx_customers_branch_id ON customers(branch_id);

-- ============================================================
-- ORDERS
-- ============================================================
CREATE TABLE orders (
    id           serial PRIMARY KEY,
    customer_id  integer NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    tong_tien    numeric(14,2) NOT NULL CHECK (tong_tien >= 0),
    trang_thai   text NOT NULL DEFAULT 'pending'
                 CHECK (trang_thai IN ('pending', 'paid', 'shipped', 'cancelled')),
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_customer_id ON orders(customer_id);

-- ============================================================
-- PAYMENTS — so_the là cột mã hóa thứ hai, dùng để chứng minh
-- việc mã hóa cột áp dụng được cho nhiều bảng chứ không phải
-- một trường hợp đơn lẻ.
-- ============================================================
CREATE TABLE payments (
    id          serial PRIMARY KEY,
    order_id    integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    so_the      bytea,                    -- pgp_sym_encrypt(...) từ Tuần 5
    ten_chu_the text,
    exp_month   smallint CHECK (exp_month BETWEEN 1 AND 12),
    exp_year    smallint CHECK (exp_year >= 2024),
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN payments.so_the IS 'Số thẻ thanh toán — mã hóa bằng pgcrypto, khóa giải mã KHÔNG được lưu trong database (xem docs/tuan1-nghien-cuu.md).';

CREATE INDEX idx_payments_order_id ON payments(order_id);

-- ============================================================
-- AUDIT_LOG — log ở tầng ứng dụng (vd: đăng nhập, đổi mật khẩu).
-- Đây KHÔNG phải nguồn dữ liệu chính cho analyzer ở Tuần 6 — nguồn
-- chính là log của pgAudit (ghi ở log của Postgres, cấu hình đã bật
-- trong docker-compose.yml). Bảng này chỉ bổ sung một số sự kiện
-- ở tầng ứng dụng mà pgAudit không thấy được (vd: đăng nhập thất bại
-- trước khi có kết nối DB).
-- ============================================================
CREATE TABLE audit_log (
    id         bigserial PRIMARY KEY,
    actor      text NOT NULL,
    action     text NOT NULL,
    table_name text,
    row_id     text,
    at         timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Dữ liệu chi nhánh tối thiểu để có thể tạo staff/customers ngay.
-- Dữ liệu khách hàng/đơn hàng thật sẽ được seed bằng Faker.js ở Tuần 2.
-- ============================================================
INSERT INTO branches (ma_chi_nhanh, ten_chi_nhanh) VALUES
    ('HN', 'Hà Nội'),
    ('HCM', 'Hồ Chí Minh'),
    ('DN', 'Đà Nẵng');
