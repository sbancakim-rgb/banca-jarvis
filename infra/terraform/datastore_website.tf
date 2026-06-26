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

  # 검색 엔진(앱)에 묶으려면 Advanced Site Search가 필수 (Basic Site Search 데이터스토어는
  # google_discovery_engine_search_engine에 추가할 수 없음 — GCP 제약사항).
  create_advanced_site_search = true

  # GCP가 생성 후 이 블록을 기본값으로 채워서 돌려주는데, 선언을 안 해두면 Terraform이
  # "설정에서 제거됨"으로 보고 매 plan마다 강제 재생성(replace)을 일으킴.
  advanced_site_search_config {
    disable_automatic_refresh = false
    disable_initial_index     = false
  }

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
