# 검색어/클릭 통계 저장용 (주제별 클릭 우선순위, 인기 검색어 집계에 사용).
resource "google_firestore_database" "default" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.apis]
}

# search_clicks 컬렉션에서 "검색어(query)로 필터링 + 최근 N일(clickedAt)로 필터링"을
# 동시에 하려면 복합 색인이 필요함 (Firestore는 단일 필드 색인은 자동 생성하지만
# 두 필드를 함께 거르는 조회는 명시적 색인이 있어야 함).
resource "google_firestore_index" "search_clicks_by_query_and_time" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "search_clicks"

  fields {
    field_path = "query"
    order      = "ASCENDING"
  }
  fields {
    field_path = "clickedAt"
    order      = "ASCENDING"
  }
}
