resource "google_discovery_engine_search_engine" "knowledge_search" {
  project       = var.project_id
  location      = var.discovery_location
  collection_id = "default_collection"
  engine_id     = "banca-knowledge-search"
  display_name  = "방카 지식검색"
  industry_vertical = "GENERIC"

  data_store_ids = concat(
    [google_discovery_engine_data_store.internal_documents.data_store_id],
    [for k, v in google_discovery_engine_data_store.website : v.data_store_id]
  )

  common_config {
    company_name = var.company_name
  }

  search_engine_config {
    search_add_ons = ["SEARCH_ADD_ON_LLM"]
    # Advanced Site Search 데이터스토어(웹사이트 출처)를 묶으려면 Enterprise tier 필수.
    search_tier    = "SEARCH_TIER_ENTERPRISE"
  }
}
