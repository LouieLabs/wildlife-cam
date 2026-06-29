#!/usr/bin/env bash
# Set up Workload Identity Federation so GitHub Actions in
# LouieLabs/wildwatch-cam-viewer can deploy to Firebase Hosting WITHOUT a
# service-account JSON key.
#
# Idempotent: safe to re-run (existing resources are left alone).
#
# Run as a user with project-owner / IAM-admin permissions on
# louielabs-animal-cams. Easiest:
#   gcloud auth login    # sign in as admin@louielabs.com
#   gcloud config set project louielabs-animal-cams

set -euo pipefail

PROJECT_ID="louielabs-animal-cams"
REPO="LouieLabs/wildwatch-cam-viewer"
SA_NAME="github-wildwatch-deployer"
POOL_ID="github-pool"
PROVIDER_ID="github-provider"

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
PROJECT_NUM=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

echo "==> Authed as : $(gcloud config get-value account)"
echo "==> Project    : $PROJECT_ID (number $PROJECT_NUM)"
echo "==> Repo       : $REPO"
echo "==> SA email   : $SA_EMAIL"
echo "==> Press ENTER to continue, Ctrl+C to abort."
read -r

echo ""
echo "==> 1/6  Enable required APIs"
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com \
  --project="$PROJECT_ID"

echo ""
echo "==> 2/6  Create deployer service account (skipped if exists)"
gcloud iam service-accounts create "$SA_NAME" \
  --project="$PROJECT_ID" \
  --display-name="GitHub Actions: WildWatch Hosting Deployer" \
  2>/dev/null || echo "    (already exists, continuing)"

echo ""
echo "==> 3/6  Grant Firebase Hosting Admin to the SA"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/firebasehosting.admin" \
  --condition=None \
  --quiet >/dev/null

echo ""
echo "==> 4/6  Create Workload Identity Pool (skipped if exists)"
gcloud iam workload-identity-pools create "$POOL_ID" \
  --project="$PROJECT_ID" \
  --location=global \
  --display-name="GitHub Actions Pool" \
  2>/dev/null || echo "    (already exists, continuing)"

echo ""
echo "==> 5/6  Create OIDC provider scoped to LouieLabs/* repos"
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
  --project="$PROJECT_ID" \
  --location=global \
  --workload-identity-pool="$POOL_ID" \
  --display-name="GitHub Actions Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository_owner=='LouieLabs'" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  2>/dev/null || echo "    (already exists, continuing)"

echo ""
echo "==> 6/6  Allow LouieLabs/wildwatch-cam-viewer to impersonate the SA"
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUM}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${REPO}" \
  --condition=None \
  >/dev/null

WIF_PROVIDER="projects/${PROJECT_NUM}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"

echo ""
echo "================================================================"
echo "SETUP COMPLETE."
echo ""
echo "Add these two GitHub repo VARIABLES (not secrets — they're not sensitive):"
echo "  Settings → Secrets and variables → Actions → Variables tab → New repository variable"
echo ""
echo "  WIF_PROVIDER  = ${WIF_PROVIDER}"
echo "  WIF_SA_EMAIL  = ${SA_EMAIL}"
echo ""
echo "And add these two GitHub repo SECRETS (Secrets tab):"
echo "  VITE_FIREBASE_API_KEY  = AIzaSyBkEV0TVk9282qwW2hnG7lzg3g4adMyskA"
echo "  VITE_FIREBASE_APP_ID   = 1:33010987640:web:2e86888f6d57b2ae1b738d"
echo "================================================================"
