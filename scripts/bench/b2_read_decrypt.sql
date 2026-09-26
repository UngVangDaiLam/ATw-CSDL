-- B2 - đọc 100 dòng, GIẢI MÃ cccd qua app.decrypt_text().
BEGIN;
SET LOCAL ROLE nv_hn01;
SELECT app.decrypt_text(cccd) FROM app.customers ORDER BY id LIMIT 100;
COMMIT;
