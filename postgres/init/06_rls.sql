-- =============================================================================
-- 06_rls.sql  -  LỚP 1d: Row-Level Security
--
-- Ba lớp trước lọc theo BẢNG ("ai được đụng vào customers"). RLS lọc theo
-- DÒNG ("được thấy những khách hàng nào trong đó"). Trục phân tách là
-- branch_id: nhân viên chỉ thấy dữ liệu chi nhánh mình.
--
-- Mô hình định danh: ứng dụng kết nối bằng app_user (một pool duy nhất) rồi
-- `SET ROLE nv_xxx` ở đầu mỗi request. current_user khi đó là nv_xxx, nên
-- policy tra được chi nhánh qua app.staff.db_user - NHƯNG chỉ khi transaction
-- mang token phiên đăng nhập còn hạn của chính nv_xxx (app.staff_sessions,
-- 03_schema.sql). SET ROLE thôi thì không đủ.
-- =============================================================================

SET ROLE db_owner;
SET search_path = app, audit, ext, public;

-- -----------------------------------------------------------------------------
-- Hàm tra chi nhánh. Cố ý tách làm HAI hàm - đây không phải chia nhỏ cho vui.
--
-- BẪY: bên trong một hàm SECURITY DEFINER, `current_user` trả về CHỦ SỞ HỮU
-- HÀM chứ không phải người gọi. Viết gộp thành một hàm SECURITY DEFINER dùng
-- `WHERE db_user = current_user` thì nó luôn so với 'db_owner', không bao giờ
-- khớp, và MỌI role đều đọc ra 0 dòng. Triệu chứng nhìn hệt như "RLS chặn
-- đúng", nên rất dễ tưởng là đã xong.
--
--   app.branch_of(text,text) SECURITY DEFINER - chạy dưới quyền db_owner nên
--                            đọc được app.staff + app.staff_sessions mà người
--                            gọi không cần quyền SELECT trên hai bảng đó.
--   app.current_branch_id()  SECURITY INVOKER (mặc định) - giữ đúng danh tính
--                            người gọi, lấy current_user rồi truyền sang. Cũng
--                            là nơi DUY NHẤT ghi dòng LOG mạo danh - vì chỉ
--                            nó biết chắc vai thật của phiên.
--
-- STABLE: policy được gọi trên TỪNG DÒNG. Không có STABLE thì Postgres gọi
-- lại hàm cho mỗi dòng thay vì cache trong một câu lệnh.
--
-- SET search_path: BẮT BUỘC với mọi SECURITY DEFINER. Thiếu nó, kẻ tấn công
-- tạo được một bảng tên `staff` ở schema đứng trước trong search_path là
-- chiếm được quyền db_owner.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.branch_of(p_db_user text, p_token text,
                              OUT branch_id int, OUT ly_do text)
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = app, pg_catalog
AS $$
-- RÀNG BUỘC VAI VỚI PHIÊN ĐĂNG NHẬP (app.staff_sessions, 03_schema.sql).
--
-- branch_id: chi nhánh, CHỈ khi p_token là token còn hạn của đúng nhân viên
--   mang role p_db_user, và nhân viên đó còn hoạt động. Quyền thành viên role
--   (thứ app_user có với MỌI nv_*) không còn đủ: phải có token, mà token chỉ
--   cấp khi nhập đúng mật khẩu nhân viên (app.verify_staff_login).
-- ly_do: vì sao branch_id là NULL - chỉ điền khi p_db_user là role của một
--   nhân viên (readonly_user, app_user chưa SET ROLE, db_owner: không phải).
--
-- Hàm này KHÔNG tự ghi log. Ai cũng gọi thẳng được nó với tên role tùy ý; nếu
-- nó RAISE LOG thì ai cũng sinh được dòng "nv_hcm01 bị mạo danh" mang đúng
-- context mà analyzer tin. Việc ghi log nằm ở app.current_branch_id() bên
-- dưới - hàm đó tự lấy current_user, không nhận tên role từ ngoài vào.
DECLARE
    v_owner  text;
    v_live   boolean;
    v_active boolean;
    v_branch int;
BEGIN
    IF p_token IS NOT NULL AND p_token <> '' THEN
        SELECT s.db_user, t.expires_at > now(), s.is_active, s.branch_id
          INTO v_owner, v_live, v_active, v_branch
          FROM app.staff_sessions t
          JOIN app.staff s ON s.id = t.staff_id
         WHERE t.token_sha256 = sha256(convert_to(p_token, 'UTF8'));
        IF v_owner = p_db_user AND v_live AND v_active THEN
            branch_id := v_branch;
            RETURN;
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM app.staff WHERE db_user = p_db_user) THEN
        ly_do := CASE WHEN p_token IS NULL OR p_token = '' THEN 'khong_co_token'
                      WHEN v_owner IS NULL                  THEN 'token_khong_ton_tai'
                      WHEN v_owner <> p_db_user             THEN 'token_cua_nguoi_khac'
                      WHEN NOT v_active                     THEN 'nhan_vien_bi_khoa'
                      ELSE                                       'token_het_han' END;
    END IF;
END $$;

-- Hàm mà policy gọi. SECURITY INVOKER: current_user là vai THẬT của phiên, nên
-- dòng LOG dưới đây không giả được bằng cách truyền tên role khác vào.
--
-- Token lấy từ GUC secdb.staff_token mà app đặt trong transaction bằng tham số
-- (app/src/middleware/setRole.js). missing_ok = true: chưa đặt thì NULL.
-- GUC đọc được bằng current_setting() trong chính phiên đó - SQL Injection
-- trong một request chỉ thấy token của CHÍNH người gửi request.
--
-- Vai nhân viên mà không có phiên hợp lệ: trả NULL (RLS -> 0 dòng) và ghi một
-- dòng LOG cho lớp 3 - rule IDENTITY_WITHOUT_SESSION của analyzer:
--   - RAISE LOG chỉ vào log server, KHÔNG gửi về client (LOG thấp hơn NOTICE
--     theo client_min_messages) - người gọi chỉ thấy 0 dòng.
--   - Trường `context` là "PL/pgSQL function current_branch_id() line N at
--     RAISE" (không kèm tên schema). Khối DO tự RAISE LOG mang context
--     "inline_code_block"; hàm trùng tên trong pg_temp không tạo được vì
--     PUBLIC không có quyền TEMP (04_grants.sql).
--   - Không bao giờ ghi giá trị token vào log.
--
-- plpgsql thay vì sql: cần RAISE. Thân hàm không còn hiện trong log pgAudit
-- (biểu thức plpgsql đơn giản không qua executor) - không rule nào cần nó.
CREATE FUNCTION app.current_branch_id() RETURNS int
    LANGUAGE plpgsql
    STABLE
    SET search_path = app, pg_catalog
AS $$
DECLARE
    v_role text := current_user;
    r      record;
BEGIN
    SELECT * INTO r FROM app.branch_of(v_role, current_setting('secdb.staff_token', true));
    IF r.ly_do IS NOT NULL THEN
        RAISE LOG 'SECDB_IDENTITY_WITHOUT_SESSION role=% ly_do=%', v_role, r.ly_do;
    END IF;
    RETURN r.branch_id;
END $$;

REVOKE ALL ON FUNCTION app.branch_of(text, text)  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.current_branch_id()    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.branch_of(text, text) TO staff_role, app_user, readonly_user;
GRANT EXECUTE ON FUNCTION app.current_branch_id()   TO staff_role, app_user, readonly_user;

-- -----------------------------------------------------------------------------
-- Bật RLS.
--
-- ENABLE: áp policy cho mọi role KHÔNG phải chủ sở hữu bảng.
-- FORCE : áp cho cả chủ sở hữu (db_owner). Mặc định owner bỏ qua toàn bộ
--         policy - đây là hiểu lầm phổ biến nhất về RLS, và là lý do nhiều
--         người test bằng owner rồi kết luận "RLS không chạy".
--
-- Hệ quả của FORCE ở đây là CỐ Ý: db_owner không có policy nào nên đọc ra
-- 0 dòng. Tức là người quản trị CSDL không đọc được dữ liệu khách hàng -
-- một dạng phân tách nhiệm vụ (separation of duties). db_owner vẫn làm được
-- DDL bình thường vì RLS chỉ chi phối DML.
--
-- Cần thao tác dữ liệu ở mức quản trị thì dùng superuser qua socket:
--   docker compose exec postgres psql -U postgres -d secdb
-- Superuser bỏ qua RLS. Đó cũng là lý do 07_seed.sql chạy bằng postgres chứ
-- không SET ROLE db_owner như 03_schema.sql.
-- -----------------------------------------------------------------------------
ALTER TABLE app.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.customers FORCE  ROW LEVEL SECURITY;

ALTER TABLE app.orders    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.orders    FORCE  ROW LEVEL SECURITY;

ALTER TABLE app.payments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payments  FORCE  ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Policy phân tách theo chi nhánh.
--
-- USING      -> lọc dòng ĐỌC được (SELECT, và dòng nào được UPDATE/DELETE nhìn thấy)
-- WITH CHECK -> chặn dòng GHI vào (INSERT, và giá trị SAU khi UPDATE)
--
-- Thiếu WITH CHECK là lỗ hổng phổ biến nhất của RLS: nhân viên Hà Nội vẫn
-- đọc đúng dữ liệu của mình, nhưng UPDATE được branch_id sang 2 để đẩy khách
-- hàng sang chi nhánh khác, hoặc INSERT thẳng dữ liệu vào chi nhánh khác.
--
-- app_user nằm trong danh sách TO nhưng KHÔNG có dòng nào trong app.staff,
-- nên app.current_branch_id() trả NULL và `branch_id = NULL` cho ra NULL -
-- không phải TRUE - tức app_user đọc ra 0 dòng. Đây là chủ đích: chiếm được
-- mật khẩu app_user vẫn chưa lấy được dữ liệu. SET ROLE sang nv_xxx cũng chưa
-- đủ - còn thiếu token phiên của nv_xxx, thứ chỉ có được bằng mật khẩu của
-- chính nhân viên đó; và lần thử ấy để lại dòng LOG cho analyzer.
--
-- VÌ SAO `(SELECT app.current_branch_id())` CHỨ KHÔNG GỌI HÀM TRỰC TIẾP:
-- Gọi thẳng thì khi planner dùng được index trên branch_id, hàm chạy 1 lần
-- (Index Cond); nhưng khi planner chọn đường khác - vd. quét theo khóa chính
-- cho `ORDER BY id LIMIT 100` - điều kiện RLS thành `Filter` và hàm chạy LẠI
-- CHO TỪNG DÒNG. Mỗi lần là một truy vấn vào app.staff qua hàm SECURITY
-- DEFINER (không inline được), và mỗi truy vấn đó còn sinh thêm một dòng log
-- pgAudit. Bọc trong subquery biến nó thành InitPlan: tính đúng MỘT lần cho
-- mỗi câu lệnh. Ngữ nghĩa không đổi vì current_user cố định trong suốt một
-- câu lệnh. Số đo trước/sau: docs/benchmark-results.md.
-- -----------------------------------------------------------------------------
CREATE POLICY branch_isolation ON app.customers
    FOR ALL
    TO staff_role, app_user, readonly_user
    USING      (branch_id = (SELECT app.current_branch_id()))
    WITH CHECK (branch_id = (SELECT app.current_branch_id()));

CREATE POLICY branch_isolation ON app.orders
    FOR ALL
    TO staff_role, app_user, readonly_user
    USING      (branch_id = (SELECT app.current_branch_id()))
    WITH CHECK (branch_id = (SELECT app.current_branch_id()));

CREATE POLICY branch_isolation ON app.payments
    FOR ALL
    TO staff_role, app_user, readonly_user
    USING      (branch_id = (SELECT app.current_branch_id()))
    WITH CHECK (branch_id = (SELECT app.current_branch_id()));

RESET ROLE;

-- =============================================================================
-- GHI CHÚ CHO BƯỚC SAU
--
-- Trong app/ (Express), mỗi request phải:
--     BEGIN;
--     SET LOCAL ROLE nv_hn01;      -- SET LOCAL: tự hết hiệu lực khi COMMIT
--     ... truy vấn ...
--     COMMIT;
--
-- Dùng SET LOCAL ROLE trong transaction thay vì SET ROLE trần. Lý do: với
-- connection pool, quên RESET ROLE là request kế tiếp mượn lại connection đó
-- sẽ chạy dưới danh tính của người trước - lỗ hổng nghiêm trọng và rất khó
-- phát hiện vì nó chỉ xuất hiện khi pool tái sử dụng connection.
--
-- app_user là thành viên của cả ba role nv_*, nên chiếm được app_user thì SET
-- ROLE sang chi nhánh nào cũng được. Trước đây đó là giới hạn "không thể loại
-- bỏ nếu vẫn dùng một pool chung". Nay RLS còn đòi token phiên của đúng nhân
-- viên đó (app.branch_of ở trên): SET ROLE được nhưng đọc ra 0 dòng, và để lại
-- dòng LOG SECDB_IDENTITY_WITHOUT_SESSION cho analyzer.
--
-- Mỗi transaction của app vì vậy là:
--     BEGIN;
--     SET LOCAL ROLE nv_hn01;
--     SELECT set_config('secdb.staff_token', $1, true);   -- $1: token, THAM SỐ
--     ... truy vấn ...
--     COMMIT;
-- Token phải đi qua tham số: viết thẳng vào câu SQL là nó nằm nguyên văn trong
-- log pgAudit. Và KHÔNG dùng `SET LOCAL secdb.staff_token = '...'` - câu SET
-- không tham số hóa được, và class misc_set ghi nó vào log.
-- =============================================================================
