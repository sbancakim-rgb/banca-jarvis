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
  description = "자동 크롤링할 공개 웹사이트 출처 목록. data_store_id => { 표시이름, URL 패턴 }. 새 출처를 추가하려면 이 맵에 항목을 더하면 됨"
}
