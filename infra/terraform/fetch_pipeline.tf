# 외부 공개자료(현재는 법제처 3개 법령) 직접수집 파이프라인.
#
# Advanced Site Search(datastore_website.tf)는 도메인 소유권을 Search Console로
# 인증해야 색인이 시작되는데, law.go.kr은 우리 소유 도메인이 아니라서 인증이 불가능함
# (콘솔에 "도메인이 확인되지 않았습니다" 로 표시되며 색인이 영영 시작되지 않음).
#
# 그래서 Google 크롤러가 직접 도는 방식 대신, 우리가 주기적으로 해당 페이지를 직접
# 가져와("fetch") 우리 GCS 버킷에 저장한 뒤, 내부문서와 동일한 documents:import로
# 색인하는 방식을 쓴다. 이러면 외부 도메인을 크롤링하는 게 아니라 "우리 소유의 복사본"을
# 색인하는 것이 되어 도메인 인증 문제가 발생하지 않는다.
#
# fetcher 자체(컨테이너)는 api/ 와 동일한 이유로 Terraform이 아니라
# `gcloud run deploy --source ./fetcher`로 배포한다 (fetcher/README.md 참고).
# 이 파일은 fetcher가 쓸 버킷/데이터스토어/서비스계정과, fetcher를 주기적으로
# 호출하는 Cloud Scheduler만 관리한다.

resource "google_storage_bucket" "external_snapshots" {
  name                        = "${var.project_id}-banca-external-snapshots"
  project                     = var.project_id
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false

  depends_on = [google_project_service.apis]
}

# fetcher가 가져온 사본을 색인할 데이터스토어 (내부문서와 동일한 CONTENT_REQUIRED 방식).
resource "google_discovery_engine_data_store" "external_snapshots" {
  project           = var.project_id
  location          = var.discovery_location
  data_store_id     = "external-snapshots-v1"
  display_name      = "외부 공개자료 (직접수집 사본)"
  industry_vertical = "GENERIC"
  content_config    = "CONTENT_REQUIRED"
  solution_types    = ["SOLUTION_TYPE_SEARCH"]

  # GCP가 생성 후 이 블록을 기본값으로 채워서 돌려주는데, 선언을 안 해두면 Terraform이
  # "설정에서 제거됨"으로 보고 매 plan마다 강제 재생성(replace)을 일으킴
  # (datastore_internal.tf와 동일한 패턴).
  document_processing_config {
    default_parsing_config {
      digital_parsing_config {}
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_service_account" "external_fetcher" {
  project      = var.project_id
  account_id   = "banca-external-fetcher"
  display_name = "외부 공개자료 직접수집(fetcher) Cloud Run 서비스 계정"
}

resource "google_storage_bucket_iam_member" "external_fetcher_bucket_admin" {
  bucket = google_storage_bucket.external_snapshots.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.external_fetcher.email}"
}

resource "google_project_iam_member" "external_fetcher_discoveryengine" {
  project = var.project_id
  role    = "roles/discoveryengine.editor"
  member  = "serviceAccount:${google_service_account.external_fetcher.email}"
}

# Cloud Scheduler가 fetcher를 호출할 때 OIDC 토큰에 이 서비스 계정을 쓰려면,
# Terraform을 실행하는 계정이 이 서비스 계정을 "대신 사용(actAs)"할 권한이 있어야 함.
resource "google_service_account_iam_member" "terraform_can_act_as_fetcher" {
  service_account_id = google_service_account.external_fetcher.name
  role                = "roles/iam.serviceAccountUser"
  member              = "serviceAccount:banca-terraform@${var.project_id}.iam.gserviceaccount.com"
}

# fetcher를 처음 apply할 때는 아직 Cloud Run URL이 없으므로 external_fetcher_url이 비어 있음.
# fetcher 배포 후 그 URL을 terraform.tfvars에 채우고 다시 apply하면 아래 리소스들이 생성됨.
resource "google_cloud_scheduler_job" "external_fetcher" {
  count    = var.external_fetcher_url != "" ? 1 : 0
  project  = var.project_id
  region   = var.region
  name     = "banca-external-fetcher-weekly"
  schedule = "0 4 * * 1"
  time_zone = "Asia/Seoul"

  http_target {
    http_method = "POST"
    uri         = "${var.external_fetcher_url}/run"

    oidc_token {
      service_account_email = google_service_account.external_fetcher.email
    }
  }

  depends_on = [google_project_service.apis]
}

# fetcher는 --no-allow-unauthenticated로 배포하므로(공개 노출할 이유가 없음),
# Cloud Scheduler가 쓰는 서비스 계정에 호출 권한을 명시적으로 줘야 함.
resource "google_cloud_run_v2_service_iam_member" "external_fetcher_invoker" {
  count    = var.external_fetcher_url != "" ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = "banca-external-fetcher"
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.external_fetcher.email}"
}
