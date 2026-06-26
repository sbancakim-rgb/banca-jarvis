# /api/search Cloud Run 서비스가 쓸 서비스 계정.
# Cloud Run 서비스 자체는 Terraform이 아니라 `gcloud run deploy --source ./api`로
# 배포한다 (컨테이너 빌드/배포는 Terraform이 다루기 번거로워서 — api/README.md 참고).
resource "google_service_account" "search_api" {
  project      = var.project_id
  account_id   = "banca-search-api"
  display_name = "방카 지식검색 /api/search Cloud Run 서비스 계정"
}

resource "google_project_iam_member" "search_api_discoveryengine" {
  project = var.project_id
  role    = "roles/discoveryengine.viewer"
  member  = "serviceAccount:${google_service_account.search_api.email}"
}

resource "google_project_iam_member" "search_api_aiplatform" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.search_api.email}"
}

resource "google_project_iam_member" "search_api_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.search_api.email}"
}
