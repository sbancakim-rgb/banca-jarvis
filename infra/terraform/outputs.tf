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
