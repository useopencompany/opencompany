#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_REF="${CHAT_SANDBOX_IMAGE_REF:-}"

if [[ -z "$IMAGE_REF" ]]; then
  : "${VERCEL_TEAM_SLUG:?Set VERCEL_TEAM_SLUG or CHAT_SANDBOX_IMAGE_REF.}"
  : "${VERCEL_PROJECT_SLUG:?Set VERCEL_PROJECT_SLUG or CHAT_SANDBOX_IMAGE_REF.}"
  IMAGE_REF="vcr.vercel.com/${VERCEL_TEAM_SLUG}/${VERCEL_PROJECT_SLUG}/goat-chat-sandbox:latest"
fi

if [[ -n "${VERCEL_OIDC_TOKEN:-}" ]]; then
  printf '%s' "$VERCEL_OIDC_TOKEN" |
    docker login vcr.vercel.com --username oidc --password-stdin
fi

docker buildx build \
  --platform linux/amd64 \
  --file "${SCRIPT_DIR}/Dockerfile" \
  --output "type=image,name=${IMAGE_REF},push=true,oci-mediatypes=true,compression=zstd,compression-level=3,force-compression=true" \
  "${SCRIPT_DIR}"

printf 'Pushed %s\n' "$IMAGE_REF"
