-- Task 13 - Row-Level Security (RLS) theo chi nhanh.
--
-- KHONG tu dong chay qua docker-entrypoint-initdb.d - volume "pgdata" da co
-- du lieu tu truoc (init script chi chay 1 lan duy nhat luc initdb tren volume
-- rong). Chay THU CONG bang lenh sau (thay dbsec_admin/dbsec neu ban doi
-- POSTGRES_SUPERUSER/POSTGRES_DB trong .env):
--
--   docker compose exec postgres psql -U dbsec_admin -d dbsec -f /docker-entrypoint-initdb.d/04-app-rls.sql
--
-- Muc dich: gioi han moi nhan vien (qua app_user) chi doc/ghi duoc du lieu
-- thuoc chi nhanh cua minh. Chi nhanh hien tai duoc xac dinh qua session
-- variable "app.branch_id", se duoc app SET LOCAL trong tung transaction
-- (middleware/rls.js - lam o buoc sau cua Task 13), dua theo staff.branch_id
-- luu trong session dang nhap.
--
-- QUAN TRONG - fail-safe: neu app quen SET LOCAL app.branch_id (vd middleware
-- loi), current_setting(...) tra ve NULL, dieu kien "branch_id = NULL" luon
-- SAI/UNKNOWN -> KHONG row nao duoc thay. Tuc la loi o day dan den "khong
-- thay gi" (an toan) chu khong phai "thay het" (nguy hiem) - dung nguyen tac
-- fail closed/deny-by-default.
--
-- GIOI HAN CAN NEU RO TRONG BAO CAO: RLS o day chi bao ve du lieu TRONG CHINH
-- 3 bang duoc bat RLS ben duoi. No KHONG chan duoc SQL Injection kieu
-- UNION-based da demo o Task 10 (doc bang "staff" qua endpoint /customers/search)
-- vi bang staff khong bat RLS va logic loi van la noi chuoi SQL truc tiep -
-- RLS la lop phong thu BO SUNG sau parameterized query, khong thay the no.

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY; -- ke ca khi vo tinh chay bang quyen owner

CREATE POLICY customers_branch_isolation ON customers
  USING (branch_id = current_setting('app.branch_id', true)::int);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;

CREATE POLICY orders_branch_isolation ON orders
  USING (
    customer_id IN (
      SELECT id FROM customers
      WHERE branch_id = current_setting('app.branch_id', true)::int
    )
  );

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;

CREATE POLICY payments_branch_isolation ON payments
  USING (
    order_id IN (
      SELECT o.id
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      WHERE c.branch_id = current_setting('app.branch_id', true)::int
    )
  );
