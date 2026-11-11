# The backup service: pg_dump and psql from the same postgres major version as the database, age to encrypt, and rclone
# to talk to S3-compatible storage. Runs backup.sh every day at BACKUP_AT (Shanghai time).
FROM postgres:17-alpine
RUN apk add --no-cache age rclone tzdata
ENV TZ=Asia/Shanghai
COPY backup.sh restore.sh entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
