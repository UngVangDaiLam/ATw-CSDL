-- =============================================================================
-- 03_schema.sql  -  Cấu trúc bảng
--
-- `SET ROLE db_owner` để MỌI object được tạo ra thuộc sở hữu của db_owner,
-- không phải của superuser `postgres` và càng không phải của app_user.
-- Đây là điểm mấu chốt của lớp 1: owner luôn có toàn quyền trên object của
-- mình, nên app_user chỉ cần "không phải owner" là đã không thể DROP/ALTER.
-- =============================================================================

SET ROLE db_owner;
SET search_path = app, audit, ext, public;

-- -----------------------------------------------------------------------------
-- Chi nhánh. branch_id là TRỤC PHÂN TÁCH DỮ LIỆU cho Row-Level Security ở
-- bước sau: mỗi nhân viên chỉ thấy khách hàng/đơn hàng của chi nhánh mình.
-- -----------------------------------------------------------------------------
CREATE TABLE app.branches (
    id          SERIAL      PRIMARY KEY,
    code        TEXT        NOT NULL UNIQUE,
    name        TEXT        NOT NULL,
    city        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Nhân viên.
-- db_user ánh xạ nhân viên -> role đăng nhập PostgreSQL. Policy RLS ở bước sau
-- sẽ dùng current_user để tra ra branch_id, nên cột này phải có sẵn từ bây giờ.
--
-- username/password_hash: đăng nhập ở tầng app/ (Express). app_user có SELECT
-- trên toàn bảng (04_grants.sql) nên tự tra được hàng này TRƯỚC khi biết phải
-- SET ROLE sang nv_xxx nào - đây là bước duy nhất app_user đọc password_hash,
-- và cũng chính vì staff KHÔNG bật RLS nên nó là mục tiêu của demo SQL
-- Injection trong app/ (xem app/README.md). password_hash là bcrypt, không
-- bao giờ là plaintext.
-- -----------------------------------------------------------------------------
CREATE TABLE app.staff (
    id            SERIAL      PRIMARY KEY,
    branch_id     INT         NOT NULL REFERENCES app.branches(id),
    db_user       TEXT        UNIQUE,
    username      TEXT        UNIQUE,
    password_hash TEXT,
    full_name     TEXT        NOT NULL,
    position      TEXT,
    is_active     BOOLEAN     NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX staff_branch_id_idx ON app.staff (branch_id);

-- -----------------------------------------------------------------------------
-- Khách hàng - bảng chứa dữ liệu nhạy cảm, mục tiêu chính của lớp 2.
--
-- cccd BYTEA      : ciphertext của ext.pgp_sym_encrypt(), điền ở bước 2.
--
-- cccd_hash BYTEA : BLIND INDEX. Bắt buộc phải có, không thể thêm sau.
--   pgp_sym_encrypt() là non-deterministic (mỗi lần mã hóa cùng một giá trị ra
--   một ciphertext khác nhau, do có IV/salt ngẫu nhiên). Hệ quả: KHÔNG thể
--   `WHERE cccd = ...`, không thể UNIQUE, không thể index trên cột cccd.
--   Cách giải: lưu thêm ext.hmac(cccd_plaintext, <pepper>, 'sha256') - hàm này
--   deterministic nên tra cứu và ràng buộc trùng lặp được, nhưng không đảo
--   ngược ra số CCCD gốc. Dùng HMAC chứ không phải digest() để kẻ tấn công lấy
--   được database vẫn không dò được bằng rainbow table / brute-force 12 chữ số,
--   vì còn thiếu pepper (nằm trong Docker secret, không nằm trong DB).
-- -----------------------------------------------------------------------------
CREATE TABLE app.customers (
    id          BIGSERIAL   PRIMARY KEY,
    branch_id   INT         NOT NULL REFERENCES app.branches(id),
    full_name   TEXT        NOT NULL,
    phone       TEXT,
    email       TEXT,
    cccd        BYTEA,
    cccd_hash   BYTEA,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT customers_cccd_hash_uk UNIQUE (cccd_hash)
);
CREATE INDEX customers_branch_id_idx ON app.customers (branch_id);

-- -----------------------------------------------------------------------------
-- Đơn hàng
-- branch_id lặp lại ở đây (thay vì join qua customers) là cố ý: policy RLS
-- lọc trực tiếp trên cột của chính bảng sẽ đơn giản và nhanh hơn nhiều so với
-- policy phải subquery sang bảng khác.
-- -----------------------------------------------------------------------------
CREATE TABLE app.orders (
    id           BIGSERIAL   PRIMARY KEY,
    customer_id  BIGINT      NOT NULL REFERENCES app.customers(id),
    branch_id    INT         NOT NULL REFERENCES app.branches(id),
    order_no     TEXT        NOT NULL UNIQUE,
    status       TEXT        NOT NULL DEFAULT 'new'
                             CHECK (status IN ('new','paid','shipped','cancelled')),
    total_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer_id_idx ON app.orders (customer_id);
CREATE INDEX orders_branch_id_idx   ON app.orders (branch_id);

-- -----------------------------------------------------------------------------
-- Thanh toán
-- card_last4 để hiển thị (không nhạy cảm), card_token BYTEA là phần mã hóa.
-- Không bao giờ lưu số thẻ đầy đủ ở dạng rõ.
-- -----------------------------------------------------------------------------
CREATE TABLE app.payments (
    id          BIGSERIAL   PRIMARY KEY,
    order_id    BIGINT      NOT NULL REFERENCES app.orders(id),
    branch_id   INT         NOT NULL REFERENCES app.branches(id),
    method      TEXT        NOT NULL CHECK (method IN ('cash','card','transfer','ewallet')),
    amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    card_last4  TEXT        CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
    card_token  BYTEA,
    paid_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_id_idx ON app.payments (order_id);

-- -----------------------------------------------------------------------------
-- LỚP 3 - Cảnh báo do analyzer sinh ra.
-- Nằm trong schema `audit`, tách hẳn khỏi `app`: nếu app_user bị chiếm quyền,
-- kẻ tấn công vẫn không đọc được mình đã bị phát hiện, cũng không xóa được
-- bằng chứng.
-- -----------------------------------------------------------------------------
CREATE TABLE audit.alerts (
    id             BIGSERIAL   PRIMARY KEY,
    db_user        TEXT        NOT NULL,
    rule_triggered TEXT        NOT NULL,
    risk_score     SMALLINT    NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
    detail         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX alerts_created_at_idx ON audit.alerts (created_at DESC);
CREATE INDEX alerts_db_user_idx    ON audit.alerts (db_user);
-- GIN cho JSONB: dashboard sẽ lọc theo các khóa bên trong `detail`
CREATE INDEX alerts_detail_gin_idx ON audit.alerts USING gin (detail);

RESET ROLE;
