# Image postgres:16 gốc không có sẵn pgaudit (đây là extension của bên thứ ba,
# không nằm trong PostgreSQL chuẩn). Image gốc đã có sẵn kho apt của PGDG
# (apt.postgresql.org) để cài chính PostgreSQL, nên ta tận dụng luôn kho đó
# để cài thêm gói pgaudit tương ứng với PostgreSQL 16.
FROM postgres:16

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16-pgaudit \
    && rm -rf /var/lib/apt/lists/*
