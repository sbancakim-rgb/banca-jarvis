output "internal_documents_bucket" {
  value       = google_storage_bucket.internal_documents.name
  description = "내부 문서를 업로드할 Cloud Storage 버킷"
}

output "internal_documents_data_store_id" {
  value       = google_discovery_engine_data_store.internal_documents.data_store_id
  description = "내부 문서 import 시 사용할 data store ID"
}

output "website_data_store_ids" {
  value       = { for k, v in google_discovery_engine_data_store.website : k => v.data_store_id }
  description = "출처별 웹사이트 data store ID"
}

output "engine_id" {
  value       = google_discovery_engine_search_engine.knowledge_search.engine_id
  description = "Vertex AI Search 콘솔에서 확인/테스트할 검색 앱(엔진) ID"
}

output "search_api_service_account_email" {
  value       = google_service_account.search_api.email
  description = "/api/search Cloud Run 서비스 배포 시 --service-account로 지정할 서비스 계정"
}

output "external_snapshots_bucket" {
  value       = google_storage_bucket.external_snapshots.name
  description = "fetcher가 직접수집한 사본을 저장할 Cloud Storage 버킷"
}

output "external_snapshots_data_store_id" {
  value       = google_discovery_engine_data_store.external_snapshots.data_store_id
  description = "fetcher가 import할 data store ID"
}

output "external_fetcher_service_account_email" {
  value       = google_service_account.external_fetcher.email
  description = "fetcher Cloud Run 서비스 배포 시 --service-account로 지정할 서비스 계정"
}

output "law_go_kr_sources_json" {
  value       = jsonencode(var.law_go_kr_sources)
  description = "fetcher Cloud Run 서비스의 LAW_SOURCES_JSON 환경변수에 그대로 넣을 값"
}
