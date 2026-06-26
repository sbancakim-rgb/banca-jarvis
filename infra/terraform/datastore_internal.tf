# 회사 내부 자료(상품약관/업무매뉴얼/세법자료 PDF 등) 전용 데이터스토어.
# 실제 문서는 Terraform이 아니라, 버킷에 업로드한 뒤 별도로 import 작업을 실행해야 반영됨
# (README.md "내부 문서 색인하기" 참고).
resource "google_discovery_engine_data_store" "internal_documents" {
  project          = var.project_id
  location         = var.discovery_location
  data_store_id    = "internal-documents-v4"
  display_name     = "내부 업무자료 (약관/매뉴얼/세법)"
  industry_vertical = "GENERIC"
  content_config   = "CONTENT_REQUIRED"
  solution_types   = ["SOLUTION_TYPE_SEARCH"]

  depends_on = [google_project_service.apis]
}
