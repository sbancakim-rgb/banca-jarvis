variable "project_id" {
  type        = string
  description = "GCP 프로젝트 ID (콘솔에서 미리 생성하고 결제 계정을 연결해 두어야 함)"
}

variable "region" {
  type        = string
  default     = "asia-northeast3"
  description = "Cloud Storage 등 리전형 리소스의 위치 (서울)"
}

variable "discovery_location" {
  type        = string
  default     = "global"
  description = "Vertex AI Search(Discovery Engine) 리소스 위치. 생성형 답변(LLM) 기능을 쓰려면 global 고정"
}

variable "company_name" {
  type        = string
  description = "검색 엔진(Vertex AI Search 앱)에 표시할 회사명"
}

variable "internal_bucket_name" {
  type        = string
  description = "내부 문서(상품약관/업무매뉴얼/세법자료 PDF) 업로드용 Cloud Storage 버킷 이름. 전역적으로 고유해야 함"
}

variable "website_sources" {
  type = map(object({
    display_name = string
    uri_pattern  = string
  }))
  default = {
    "klia-disclosure-site-v2" = {
      display_name = "생명보험협회 공시실"
      uri_pattern  = "pub.insure.or.kr/*"
    }
    "fss-standard-terms-site-v2" = {
      display_name = "금융감독원 표준약관"
      uri_pattern  = "fss.or.kr/fss/bbs/B0000115/*"
    }
  }
  description = "자동 크롤링할 공개 웹사이트 출처 목록. data_store_id => { 표시이름, URL 패턴 }. 새 출처를 추가하려면 이 맵에 항목을 더하면 됨. ⚠️ Advanced Site Search는 본인 소유가 아닌 도메인은 Search Console 인증이 안 되어 색인이 시작되지 않을 수 있음 — 위 2개 출처도 현재 이 문제로 막혀 있음 (README 참고). 본인 소유가 아닌 외부 사이트는 이 방식 대신 fetch_pipeline.tf의 직접수집 방식을 쓸 것"
}

# law.go.kr은 본인 소유 도메인이 아니라서 위 website_sources(Advanced Site Search) 방식으로는
# 색인이 시작되지 않음 (도메인 소유권 인증 불가 — README "외부 공개자료 직접수집" 참고).
# 대신 fetch_pipeline.tf의 Cloud Run(fetcher)이 이 목록을 주기적으로 직접 가져와 색인한다.
variable "law_go_kr_sources" {
  type = map(object({
    display_name = string
    url          = string
  }))
  default = {
    "law-go-kr-income-tax" = {
      display_name = "소득세법"
      url          = "https://www.law.go.kr/lsInfoP.do?lsiSeq=188543"
    }
    "law-go-kr-corporate-tax" = {
      display_name = "법인세법"
      url          = "https://www.law.go.kr/lsInfoP.do?lsiSeq=199738"
    }
    "law-go-kr-inheritance-gift-tax" = {
      display_name = "상속세 및 증여세법"
      url          = "https://www.law.go.kr/lsInfoP.do?lsiSeq=109453"
    }
  }
  description = "직접 수집(fetch)할 법제처 법령 목록. lsiSeq 값이 바뀌면 url을 갱신 후 terraform apply"
}

variable "external_fetcher_url" {
  type        = string
  default     = ""
  description = "fetcher Cloud Run 서비스 배포 후 나오는 Service URL. 처음 apply할 때는 비워두고, fetcher를 배포(fetcher/README.md 참고)한 뒤 그 URL을 이 값에 채워서 terraform apply를 다시 실행하면 Cloud Scheduler가 연결됨"
}
