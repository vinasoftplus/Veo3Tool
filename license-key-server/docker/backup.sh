#!/bin/sh
# Daily backup to Backblaze B2 — runs via cron at 02:00 UTC
set -e
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DUMP_FILE="/tmp/licenses_${TIMESTAMP}.sql.gz"

pg_dump -h postgres -U "${DB_USER}" licenses | gzip > "$DUMP_FILE"
echo "[backup] Dump created: $DUMP_FILE"

if [ -n "$B2_KEY_ID" ] && [ -n "$B2_APP_KEY" ]; then
  AUTH=$(curl -s -u "${B2_KEY_ID}:${B2_APP_KEY}" \
    https://api.backblazeb2.com/b2api/v3/b2_authorize_account)
  API_URL=$(echo "$AUTH" | grep -o '"apiUrl":"[^"]*"' | cut -d'"' -f4)
  AUTH_TOKEN=$(echo "$AUTH" | grep -o '"authorizationToken":"[^"]*"' | cut -d'"' -f4)

  BUCKET_INFO=$(curl -s -H "Authorization: $AUTH_TOKEN" \
    "$API_URL/b2api/v3/b2_list_buckets?bucketName=${B2_BUCKET}" 2>/dev/null)
  BUCKET_ID=$(echo "$BUCKET_INFO" | grep -o '"bucketId":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -n "$BUCKET_ID" ]; then
    UPLOAD_URL_INFO=$(curl -s -H "Authorization: $AUTH_TOKEN" \
      -d "{\"bucketId\":\"$BUCKET_ID\"}" \
      "$API_URL/b2api/v3/b2_get_upload_url")
    UPLOAD_URL=$(echo "$UPLOAD_URL_INFO" | grep -o '"uploadUrl":"[^"]*"' | cut -d'"' -f4)
    UPLOAD_TOKEN=$(echo "$UPLOAD_URL_INFO" | grep -o '"authorizationToken":"[^"]*"' | cut -d'"' -f4)

    FILE_SIZE=$(wc -c < "$DUMP_FILE")
    SHA1=$(sha1sum "$DUMP_FILE" | cut -d' ' -f1)

    curl -s -H "Authorization: $UPLOAD_TOKEN" \
      -H "X-Bz-File-Name: backups/licenses_${TIMESTAMP}.sql.gz" \
      -H "Content-Type: application/gzip" \
      -H "Content-Length: $FILE_SIZE" \
      -H "X-Bz-Content-Sha1: $SHA1" \
      -T "$DUMP_FILE" "$UPLOAD_URL"
    echo "[backup] Uploaded to B2: backups/licenses_${TIMESTAMP}.sql.gz"
  fi
fi

rm -f "$DUMP_FILE"
echo "[backup] Done."
