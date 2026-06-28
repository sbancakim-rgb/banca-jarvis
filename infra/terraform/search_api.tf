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

# 검색 결과의 "수집 시점"(GCS 객체의 updated 타임스탬프)과 fetcher가 기록한
# collectedAt/sourceUrl 커스텀 메타데이터를 읽기 위한 버킷 단위 읽기 권한.
# 프로젝트 전체 storage 권한 대신 필요한 버킷에만 최소 권한으로 부여.
resource "google_storage_bucket_iam_member" "search_api_internal_documents_viewer" {
  bucket = google_storage_bucket.internal_documents.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.search_api.email}"
}

resource "google_storage_bucket_iam_member" "search_api_external_snapshots_viewer" {
  bucket = google_storage_bucket.external_snapshots.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.search_api.email}"
}
