#!/bin/sh
# Docker bind mounts retain host ownership. Copy a private host key into tmpfs
# before dropping privileges so the runtime never needs a world-readable key.
set -eu
umask 077
source_key="${GOOGLE_APPLICATION_CREDENTIALS:-/secrets/gcs-service-account.json}"
runtime_key=/run/patch-gcs/service-account.json
[ -f "$source_key" ] || { echo 'GCS runtime key is missing' >&2; exit 1; }
mkdir -p /run/patch-gcs
cp "$source_key" "$runtime_key"
chown codemagic-patch:codemagic-patch /run/patch-gcs "$runtime_key"
chmod 700 /run/patch-gcs
chmod 600 "$runtime_key"
export GOOGLE_APPLICATION_CREDENTIALS="$runtime_key"
exec su-exec codemagic-patch:codemagic-patch "$@"
