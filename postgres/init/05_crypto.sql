-- =============================================================================
-- 05_crypto.sql  -  LỚP 2: Mã hóa dữ liệu nhạy cảm
--
-- NGUYÊN TẮC: khóa KHÔNG BAO GIỜ rời khỏi server database.
--
-- Cách làm phổ biến là để ứng dụng đọc khóa rồi truyền vào mỗi câu lệnh
-- (pgp_sym_encrypt(cccd, $2)). Cách đó có ba điểm yếu, và ở repo này còn
-- nặng hơn vì cấu hình log:
--   1. Khóa đi qua dây mạng trong từng truy vấn.
--   2. Khóa nằm trong bộ nhớ tiến trình ứng dụng - nơi dễ bị tấn công hơn DB.
--   3. Nếu ai đó bật pgaudit.log_parameter hoặc log_statement='all', khóa sẽ
--      bị ghi plaintext vào log.
-- Biến thể "SET LOCAL app.enc_key = ..." còn tệ hơn nữa ở đây: pgaudit.log đã
-- bật class misc_set để bắt SET ROLE, nên câu SET đó sẽ đi thẳng vào file log.
--
-- Thay vào đó: khóa nằm trong Docker secret, mount vào container database ở
-- /run/secrets/. Ứng dụng chỉ gọi các hàm bọc sẵn và không bao giờ thấy khóa.
-- Hệ quả phụ rất có giá trị cho lớp 3: mọi lần giải mã đều là một lời gọi hàm
-- có tên rõ ràng nằm trong log pgAudit, nên analyzer phát hiện được hành vi
-- rút dữ liệu hàng loạt.
-- =============================================================================


-- =============================================================================
-- PHẦN 1 - Hàm đọc khóa. Chạy dưới quyền superuser `postgres`.
--
-- pg_read_file() với đường dẫn tuyệt đối nằm ngoài thư mục dữ liệu đòi hỏi
-- superuser hoặc thành viên pg_read_server_files. Ở đây chọn cách để hàm thuộc
-- sở hữu của postgres thay vì GRANT pg_read_server_files cho db_owner, vì
-- quyền đó cho phép đọc BẤT KỲ file nào trên server - rộng hơn nhiều so với
-- nhu cầu đọc đúng hai file khóa.
--
-- An toàn của SECURITY DEFINER ở đây dựa trên: không nhận tham số nào (đường
-- dẫn cố định, không thể bị điều khiển từ bên ngoài), search_path cố định, và
-- EXECUTE chỉ cấp cho db_owner.
-- =============================================================================

CREATE FUNCTION ext.master_key() RETURNS text
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog
AS $$
DECLARE
    v_key text;
BEGIN
    -- trim: file khóa thường có ký tự xuống dòng ở cuối. Thừa một '\n' là ra
    -- một khóa khác, và toàn bộ dữ liệu cũ không giải mã được nữa.
    v_key := trim(both E' \t\r\n' FROM pg_read_file('/run/secrets/pgcrypto_key'));
    IF v_key IS NULL OR length(v_key) < 16 THEN
        RAISE EXCEPTION 'Khoa ma hoa trong /run/secrets/pgcrypto_key rong hoac qua ngan'
            USING HINT = 'Chay: bash scripts/init-secrets.sh';
    END IF;
    RETURN v_key;
EXCEPTION
    WHEN undefined_file OR insufficient_privilege THEN
        RAISE EXCEPTION 'Khong doc duoc /run/secrets/pgcrypto_key'
            USING HINT = 'Kiem tra khoi secrets trong docker-compose.yml, roi chay bash scripts/init-secrets.sh';
END $$;

CREATE FUNCTION ext.index_pepper() RETURNS text
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog
AS $$
DECLARE
    v_pepper text;
BEGIN
    v_pepper := trim(both E' \t\r\n' FROM pg_read_file('/run/secrets/cccd_pepper'));
    IF v_pepper IS NULL OR length(v_pepper) < 16 THEN
        RAISE EXCEPTION 'Pepper trong /run/secrets/cccd_pepper rong hoac qua ngan'
            USING HINT = 'Chay: bash scripts/init-secrets.sh';
    END IF;
    RETURN v_pepper;
EXCEPTION
    WHEN undefined_file OR insufficient_privilege THEN
        RAISE EXCEPTION 'Khong doc duoc /run/secrets/cccd_pepper'
            USING HINT = 'Kiem tra khoi secrets trong docker-compose.yml, roi chay bash scripts/init-secrets.sh';
END $$;

-- Chỉ db_owner được gọi trực tiếp. app_user và staff_role KHÔNG có quyền này,
-- nên không role nghiệp vụ nào đọc được khóa dù có toàn quyền trên bảng.
REVOKE ALL ON FUNCTION ext.master_key()    FROM PUBLIC;
REVOKE ALL ON FUNCTION ext.index_pepper()  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ext.master_key()   TO db_owner;
GRANT EXECUTE ON FUNCTION ext.index_pepper() TO db_owner;


-- =============================================================================
-- PHẦN 2 - Hàm nghiệp vụ. Thuộc sở hữu db_owner.
--
-- Đây là toàn bộ bề mặt API mà ứng dụng được phép chạm tới. Cả ba đều
-- SECURITY DEFINER nên khi chạy, effective user là db_owner - role duy nhất có
-- EXECUTE trên ext.master_key(). Người gọi (app_user, nv_xxx) không hề có
-- đường nào lấy được khóa.
--
-- CHÚ Ý VỀ RLS: các hàm này CHỈ nhận/trả giá trị, không tự truy vấn bảng nào.
-- Đó là chủ đích. Nếu viết kiểu app.reveal_cccd(customer_id) - tức hàm tự
-- SELECT từ app.customers - thì câu SELECT bên trong sẽ chạy dưới danh tính
-- db_owner, mà db_owner đang bị FORCE ROW LEVEL SECURITY chặn nên luôn đọc ra
-- 0 dòng và hàm luôn trả NULL. Nhận ciphertext vào thì câu SELECT nằm ở phía
-- người gọi, RLS áp đúng theo chi nhánh của họ.
-- =============================================================================

-- db_owner cần chạm được vào pgcrypto để định nghĩa và chạy ba hàm bọc bên
-- dưới (01_extensions.sql đã REVOKE ALL trên schema ext khỏi PUBLIC).
-- Chỉ cấp đúng những hàm được dùng, không cấp cả schema theo kiểu ALL FUNCTIONS.
GRANT USAGE ON SCHEMA ext TO db_owner;
GRANT EXECUTE ON FUNCTION ext.pgp_sym_encrypt(text, text, text) TO db_owner;
GRANT EXECUTE ON FUNCTION ext.pgp_sym_decrypt(bytea, text)      TO db_owner;
GRANT EXECUTE ON FUNCTION ext.hmac(text, text, text)            TO db_owner;

SET ROLE db_owner;

-- -----------------------------------------------------------------------------
-- Mã hóa.
--
-- cipher-algo=aes256      : mặc định của pgcrypto là aes128, nâng lên 256.
-- s2k-mode=3 + sha256     : hàm dẫn xuất khóa có salt và lặp nhiều vòng,
--                           chống dò khóa ngoại tuyến.
-- compress-algo=0         : TẮT nén. Nén trước khi mã hóa làm độ dài ciphertext
--                           phụ thuộc vào nội dung, dẫn tới rò rỉ thông tin qua
--                           kích thước (họ tấn công kiểu CRIME/BREACH).
--
-- Kết quả KHÔNG tất định: mã hóa cùng một số CCCD hai lần cho ra hai ciphertext
-- khác nhau (do có salt ngẫu nhiên). Đó là tính chất mong muốn về mặt mật mã,
-- nhưng cũng chính là lý do phải có blind index bên dưới.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.encrypt_text(p_plain text) RETURNS bytea
    LANGUAGE sql
    VOLATILE
    SECURITY DEFINER
    SET search_path = ext, pg_catalog
AS $$
    SELECT CASE
        WHEN p_plain IS NULL OR p_plain = '' THEN NULL
        ELSE ext.pgp_sym_encrypt(
                 p_plain,
                 ext.master_key(),
                 'cipher-algo=aes256, s2k-mode=3, s2k-digest-algo=sha256, compress-algo=0'
             )
    END;
$$;

CREATE FUNCTION app.decrypt_text(p_cipher bytea) RETURNS text
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = ext, pg_catalog
AS $$
    SELECT CASE
        WHEN p_cipher IS NULL THEN NULL
        ELSE ext.pgp_sym_decrypt(p_cipher, ext.master_key())
    END;
$$;

-- -----------------------------------------------------------------------------
-- Blind index - cách duy nhất để tra cứu và ràng buộc trùng lặp trên dữ liệu
-- đã mã hóa.
--
-- HMAC-SHA256 chứ KHÔNG phải digest()/sha256() thuần. CCCD chỉ có 12 chữ số,
-- tức khoảng 10^12 khả năng - một GPU dò cạn bảng băm thuần trong thời gian
-- rất ngắn. HMAC có pepper bí mật (nằm ở Docker secret, KHÔNG nằm trong DB)
-- nên kẻ lấy được nguyên bản dump database vẫn không dò ngược được.
--
-- Chuẩn hóa đầu vào trước khi băm: '012 345 678 901' và '012345678901' là cùng
-- một số nhưng băm ra hai giá trị khác nhau, làm ràng buộc UNIQUE mất tác dụng
-- và tra cứu trượt.
--
-- Hạn chế đã biết: blind index làm lộ quan hệ bằng nhau (hai dòng cùng CCCD sẽ
-- cùng hash). Với CCCD đó là điều chấp nhận được vì nó vốn là khóa định danh
-- duy nhất; nhưng không nên áp cách này lên các trường có ít giá trị khác nhau
-- (giới tính, tỉnh thành...) vì khi đó hash gần như tương đương plaintext.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.blind_index(p_plain text) RETURNS bytea
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = ext, pg_catalog
AS $$
    SELECT CASE
        WHEN p_plain IS NULL OR p_plain = '' THEN NULL
        ELSE ext.hmac(
                 regexp_replace(p_plain, '[^0-9A-Za-z]', '', 'g'),
                 ext.index_pepper(),
                 'sha256'
             )
    END;
$$;

RESET ROLE;

-- =============================================================================
-- PHẦN 3 - Quyền
--
-- Chỉ các role thao tác dữ liệu thật mới được gọi. readonly_user KHÔNG nằm
-- trong danh sách: vai trò báo cáo không có lý do gì để đọc CCCD.
-- =============================================================================
REVOKE ALL ON FUNCTION app.encrypt_text(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.decrypt_text(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.blind_index(text)  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.encrypt_text(text)  TO app_user, staff_role;
GRANT EXECUTE ON FUNCTION app.decrypt_text(bytea) TO app_user, staff_role;
GRANT EXECUTE ON FUNCTION app.blind_index(text)   TO app_user, staff_role;

-- =============================================================================
-- GHI CHÚ CHO BƯỚC SAU
--
-- Cách dùng trong app/ (Express):
--
--   -- Thêm khách hàng
--   INSERT INTO app.customers (branch_id, full_name, cccd, cccd_hash)
--   VALUES ($1, $2, app.encrypt_text($3), app.blind_index($3));
--
--   -- Tra cứu theo CCCD (KHÔNG thể WHERE cccd = ..., ciphertext không tất định)
--   SELECT id, full_name FROM app.customers WHERE cccd_hash = app.blind_index($1);
--
--   -- Hiện CCCD của một khách hàng
--   SELECT app.decrypt_text(cccd) FROM app.customers WHERE id = $1;
--
-- XOAY KHÓA: pgp_sym_encrypt gắn chặt với khóa đang dùng. Đổi khóa đòi hỏi
-- giải mã rồi mã hóa lại toàn bộ dữ liệu cũ trong một transaction, và phải
-- giữ khóa cũ trong lúc đó. Chưa triển khai ở bước này; nếu làm thì thêm cột
-- key_version vào customers để hỗ trợ giai đoạn chuyển tiếp hai khóa.
-- =============================================================================
