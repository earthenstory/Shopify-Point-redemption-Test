#!/usr/bin/env bash
set -euo pipefail

# Deploy after the Cloud SQL database, Shopify app, secrets and production URL
# listed in README.md are configured. Existing Cloud Run environment variables,
# secrets, service account and Cloud SQL attachment are preserved by source deploy.
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

gcloud run deploy earthen-subscriptions-app \
  --source "${APP_DIR}" \
  --project es-automation-2026 \
  --region asia-south1 \
  --min-instances=1
