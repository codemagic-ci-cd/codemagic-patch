#!/usr/bin/env bash
# Prints the https:// address ngrok serves for an account, on this machine,
# before any stack exists:
#
#   NGROK_AUTHTOKEN=<token> scripts/selfhost/ngrok-address.sh
#   https://brave-otter-4821.ngrok-free.dev
#
#   NGROK_AUTHTOKEN=<token> scripts/selfhost/ngrok-address.sh --domain patch-test.ngrok.app
#   https://patch-test.ngrok.app
#
# `install.sh --ngrok` derives SERVER_URL, the download URL, and the OAuth
# callback from this address, and the OAuth app has to allow that callback
# before the install can finish — so the address is what someone needs first.
# `cmpatch selfhost install --ngrok` runs this, then asks for the OAuth app.
# Without --domain the address is the account's dev domain, which never
# changes and is the free plan's only one. --domain names a domain a paid plan
# has reserved instead — for instance when the dev domain is busy with another
# agent — and fails here if the account cannot serve it. Pass the same domain
# to install.sh as --api-domain.
#
# Starts a throwaway ngrok agent container, reads the endpoint it reports, and
# removes it — also when the run is interrupted, and a probe an earlier run
# could not remove is cleared first, so a leftover never holds the address
# (see selfhost_ngrok_address in common.sh). Stdout is the address alone;
# failures exit 1 with a `[selfhost] FAIL:` line on stderr.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

domain=""
domain_given=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain) domain="${2:-}"; domain_given=1; shift; [ "$#" -eq 0 ] || shift ;;
    --domain=*) domain="${1#--domain=}"; domain_given=1; shift ;;
    -h | --help)
      # The header comment, however long it grows.
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) fail_selfhost "unknown option: $1 (the token comes from the NGROK_AUTHTOKEN environment variable, never from an argument)" ;;
  esac
done

# A pasted address is as good as a bare domain: the scheme and a trailing
# slash are dropped, and anything else that is not a hostname is refused.
domain="${domain#https://}"
domain="${domain%/}"
if [ "$domain_given" -eq 1 ]; then
  case "$domain" in
    *.*) ;;
    *) fail_selfhost "--domain must be a domain such as patch-test.ngrok.app (got '${domain}')" ;;
  esac
  case "$domain" in
    *[!A-Za-z0-9.-]* | .* | *.)
      fail_selfhost "--domain must be a domain such as patch-test.ngrok.app (got '${domain}')" ;;
  esac
fi

require_command_selfhost docker
selfhost_ngrok_address "$domain"
