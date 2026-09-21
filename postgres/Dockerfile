FROM postgres:16

# pgAudit KHÔNG nằm trong contrib nên phải cài riêng.
# Image official postgres:16 đã cấu hình sẵn repo PGDG (apt.postgresql.org),
# nên chỉ cần apt-get install. pgcrypto thì có sẵn trong postgresql-contrib.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-16-pgaudit; \
    rm -rf /var/lib/apt/lists/*

# Config nằm NGOÀI $PGDATA và được nạp qua `postgres -c config_file=...`.
# Lý do: các script trong /docker-entrypoint-initdb.d/ chạy trên một temp server
# do entrypoint bật lên; entrypoint truyền nguyên tham số CMD cho temp server đó.
# Nhờ vậy shared_preload_libraries='pgaudit' đã có hiệu lực NGAY lúc init,
# nếu không `CREATE EXTENSION pgaudit` sẽ lỗi "pgaudit must be loaded via
# shared_preload_libraries".
COPY conf/postgresql.conf /etc/postgresql/postgresql.conf
COPY conf/pg_hba.conf     /etc/postgresql/pg_hba.conf
COPY init/                /docker-entrypoint-initdb.d/

RUN set -eux; \
    # Repo được clone trên Windows có thể mang CRLF -> bash báo "\r: command not found"
    sed -i 's/\r$//' /docker-entrypoint-initdb.d/*.sh; \
    chmod 0755 /docker-entrypoint-initdb.d/*.sh; \
    mkdir -p /backup/wal_archive /backup/full /var/log/postgresql; \
    chown -R postgres:postgres /backup /var/log/postgresql /etc/postgresql; \
    chmod 0700 /backup/wal_archive; \
    chmod 0640 /etc/postgresql/postgresql.conf /etc/postgresql/pg_hba.conf
