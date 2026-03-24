#!/usr/bin/env bash
set -euo pipefail

header='{"alg":"HS256","typ":"JWT"}'
now="$(date +%s)"
exp="$((now + 3600))"
payload="{\"sub\":\"agent_test\",\"org\":\"org_test\",\"wks\":\"ws_test\",\"scopes\":[\"*\"],\"exp\":${exp}}"
secret='dev-secret'

base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

header_b64="$(printf '%s' "${header}" | base64url)"
payload_b64="$(printf '%s' "${payload}" | base64url)"
unsigned="${header_b64}.${payload_b64}"
signature="$(printf '%s' "${unsigned}" | openssl dgst -sha256 -hmac "${secret}" -binary | base64url)"

printf '%s.%s\n' "${unsigned}" "${signature}"
