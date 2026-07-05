#!/usr/bin/env bash
set -euo pipefail

# Deploy the Earthen Delivery (EDD) backend to Cloud Run from source.
#
# --min-instances=1 keeps one instance warm so storefront cart/customer requests
# never hit a cold start (~1s first hit) — the delivery widget auto-checks on product pages, so cold starts are user-visible. A source deploy preserves
# the existing env vars, secrets, Cloud SQL connection, and service account.
#
# Usage: ./scripts/deploy-cloudrun.sh

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

gcloud run deploy earthen-delivery-app \
  --source "${APP_DIR}" \
  --project es-automation-2026 \
  --region asia-south1 \
  --min-instances=1
