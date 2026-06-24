# 공개 웹사이트(생명보험협회 공시실, 금융감독원 표준약관 등) 출처.
# 생성 후 Vertex AI Search가 자동으로 초기 크롤링을 시작하고,
# 이후 best-effort로 주기적 재크롤링하며 새/변경된 페이지를 알아서 반영함 (별도 스케줄러 불필요).
resource "google_discovery_engine_data_store" "website" {
  for_each = var.website_sources

  project          = var.project_id
  location         = var.discovery_location
  data_store_id    = each.key
  display_name     = each.value.display_name
  industry_vertical = "GENERIC"
  content_config   = "PUBLIC_WEBSITE"
  solution_types   = ["SOLUTION_TYPE_SEARCH"]

  create_advanced_site_search = false

  depends_on = [google_project_service.apis]
}

resource "google_discovery_engine_target_site" "website" {
  for_each = var.website_sources

  project       = var.project_id
  location      = var.discovery_location
  data_store_id = google_discovery_engine_data_store.website[each.key].data_store_id

  provided_uri_pattern = each.value.uri_pattern
  type                  = "INCLUDE"
  exact_match           = false
}
