-- Task 12 - Data masking cho moi truong dev/test.
--
-- Muc tieu: lap trinh vien/test can du lieu "giong that" (dung dinh dang,
-- co the demo UI, viet query thu...) NHUNG khong duoc thay du lieu KHACH
-- HANG THAT (ho_ten/email/sdt that, va dac biet la cccd/so_the). Script nay
-- tao 1 SCHEMA rieng "dev" chua ban sao da "mask" (an di) tu du lieu that,
-- tach biet hoan toan voi schema public (bang that).
--
-- Chay THU CONG (khong tu dong qua docker-entrypoint-initdb.d), moi khi can
-- lam moi ban sao dev tu du lieu moi nhat trong schema public:
--   docker compose exec postgres psql -U dbsec_admin -d dbsec -f /docker-entrypoint-initdb.d/05-mask-dev-data.sql
--
-- Nguyen tac mask (dung ham SQL, khong dung script ngoai - de bat ky ai co
-- may co the tu chay lai va kiem chung):
--   - ho_ten / email / sdt: giu 1 PHAN NHO (vd ky tu dau, phan domain email)
--     de du lieu "trong giong that" khi hien thi UI, phan con lai thay bang
--     '*' - khong the suy nguoc ra gia tri goc tu ban mask.
--   - dia_chi: thay HOAN TOAN bang 1 placeholder co dinh (khong can giu
--     dinh dang rieng vi it anh huong toi logic can test).
--   - cccd / so_the: schema dev KHONG can gia tri nay o BAT KY dang nao (ke
--     ca ban da ma hoa) - dat NULL truc tiep, giam dien tan cong thay vi
--     copy ca ciphertext qua 1 schema it duoc bao ve hon.

DROP SCHEMA IF EXISTS dev CASCADE;
CREATE SCHEMA dev;

COMMENT ON SCHEMA dev IS 'Ban sao du lieu da mask cho moi truong dev/test (Task 12). Lam moi bang cach chay lai db/init/05-mask-dev-data.sql.';

-- Ham mask dung chung: giu ky tu dau, thay phan con lai bang '*', giu nguyen
-- do dai chuoi goc (de khong lam hong cac test lien quan toi do dai/dinh dang).
CREATE OR REPLACE FUNCTION dev.mask_text(input text) RETURNS text AS $$
  SELECT CASE
    WHEN input IS NULL OR length(input) <= 1 THEN input
    ELSE left(input, 1) || repeat('*', length(input) - 1)
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION dev.mask_email(input text) RETURNS text AS $$
  SELECT CASE
    WHEN input IS NULL OR position('@' in input) = 0 THEN input
    ELSE dev.mask_text(split_part(input, '@', 1)) || '@' || split_part(input, '@', 2)
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION dev.mask_phone(input text) RETURNS text AS $$
  SELECT CASE
    WHEN input IS NULL OR length(input) < 5 THEN input
    ELSE left(input, 3) || repeat('*', length(input) - 5) || right(input, 2)
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE dev.customers AS
SELECT
  id,
  dev.mask_text(ho_ten)          AS ho_ten,
  dev.mask_email(email)          AS email,
  dev.mask_phone(sdt)            AS sdt,
  'Dia chi da an (du lieu dev)'  AS dia_chi,
  NULL::bytea                    AS cccd,
  branch_id,
  created_at
FROM customers;

ALTER TABLE dev.customers ADD PRIMARY KEY (id);
CREATE INDEX idx_dev_customers_branch_id ON dev.customers(branch_id);

-- orders khong chua PII truc tiep (chi co customer_id/tong_tien/trang_thai) -
-- giu nguyen de dev/test van kiem tra duoc logic don hang, thong ke, v.v.
CREATE TABLE dev.orders AS
SELECT * FROM orders;

ALTER TABLE dev.orders ADD PRIMARY KEY (id);
CREATE INDEX idx_dev_orders_customer_id ON dev.orders(customer_id);

CREATE TABLE dev.payments AS
SELECT
  id, order_id,
  NULL::bytea               AS so_the,
  dev.mask_text(ten_chu_the) AS ten_chu_the,
  exp_month, exp_year, created_at
FROM payments;

ALTER TABLE dev.payments ADD PRIMARY KEY (id);
CREATE INDEX idx_dev_payments_order_id ON dev.payments(order_id);

-- Cho phep app_user doc schema dev (vd 1 moi truong dev cua app tro toi
-- schema nay thay vi public) - KHONG cap quyen ghi, du lieu dev chi de doc/test.
GRANT USAGE ON SCHEMA dev TO app_user;
GRANT SELECT ON ALL TABLES IN SCHEMA dev TO app_user;
