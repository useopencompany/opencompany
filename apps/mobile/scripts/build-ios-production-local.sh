#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

required=(
  APP_VARIANT
  EXPO_TOKEN
  ASC_P8_KEY
  EXPO_ASC_KEY_ID
  EXPO_ASC_ISSUER_ID
  EXPO_APPLE_TEAM_ID
  EXPO_APPLE_TEAM_TYPE
  EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN
  EXPO_PUBLIC_POSTHOG_API_KEY
  EXPO_PUBLIC_WORKOS_CLIENT_ID
  SENTRY_AUTH_TOKEN
)
missing=()
for variable_name in "${required[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then missing+=("$variable_name"); fi
done
if (( ${#missing[@]} > 0 )); then
  printf 'Missing required mobile build environment variables: %s\n' "${missing[*]}" >&2
  exit 1
fi

if [[ "$APP_VARIANT" != production ]]; then
  echo 'APP_VARIANT must be production.' >&2
  exit 1
fi
case "$EXPO_APPLE_TEAM_TYPE" in
  IN_HOUSE|COMPANY_OR_ORGANIZATION|INDIVIDUAL) ;;
  *)
    echo 'EXPO_APPLE_TEAM_TYPE must be IN_HOUSE, COMPANY_OR_ORGANIZATION, or INDIVIDUAL.' >&2
    exit 1
    ;;
esac

umask 077
key_dir="$(mktemp -d "${TMPDIR:-/tmp}/opencompany-asc.XXXXXX")"
trap 'rm -rf -- "$key_dir"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
export EXPO_ASC_API_KEY_PATH="$key_dir/asc-api-key.p8"
printf '%s\n' "$ASC_P8_KEY" > "$EXPO_ASC_API_KEY_PATH"
unset ASC_P8_KEY

mkdir -p build
export EXPO_NO_CAPABILITY_SYNC=1
export EAS_BUILD_NO_EXPO_GO_WARNING=true
eas build --local --platform ios --profile preview --output ./build/production-device.ipa
