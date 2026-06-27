#!/usr/bin/env bash
# Deploy the dashboard to Cloud Run.
#
# Prereqs (one-time, need an interactive login):
#   1. gcloud auth login                  # admin@louielabs.com, for API/deploy
#   2. billing enabled on the project     # Cloud Run requires it (free tier covers this)
#
# Then, from web/:  ./deploy.sh
set -euo pipefail

PROJECT=louielabs-animal-cams
REGION=us-west1                              # match the bucket + Firestore region
SERVICE=wildlife-dashboard
SA=cloud-backend@${PROJECT}.iam.gserviceaccount.com
BUCKET=wildlife-camera-telemetry
RTDB=https://${PROJECT}-default-rtdb.firebaseio.com
FSDB=wildlife-camera-telemetry-db

echo "==> enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com --project "$PROJECT"

echo "==> storing CAMERA_API_KEY in Secret Manager (from .env.local)"
KEY=$(grep '^CAMERA_API_KEY=' .env.local | cut -d= -f2)
printf '%s' "$KEY" | gcloud secrets create camera-api-key --data-file=- --project "$PROJECT" 2>/dev/null \
  || printf '%s' "$KEY" | gcloud secrets versions add camera-api-key --data-file=- --project "$PROJECT"
gcloud secrets add-iam-policy-binding camera-api-key \
  --member="serviceAccount:${SA}" --role=roles/secretmanager.secretAccessor --project "$PROJECT" >/dev/null

echo "==> building + deploying to Cloud Run (runs AS the cloud-backend SA -> keyless, never reauths)"
gcloud run deploy "$SERVICE" \
  --source . --region "$REGION" --project "$PROJECT" \
  --service-account "$SA" \
  --allow-unauthenticated \
  --set-env-vars "GCP_PROJECT_ID=${PROJECT},GCLOUD_STORAGE_BUCKET=${BUCKET},FIREBASE_DATABASE_URL=${RTDB},FIRESTORE_DATABASE_ID=${FSDB},APP_ENV=prod" \
  --set-secrets "CAMERA_API_KEY=camera-api-key:latest"

echo
echo "==> URL:"
gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
  --format="value(status.url)"
echo "Set the firmware's BACKEND_BASE_URL to that URL (no LAN IP, never changes)."
