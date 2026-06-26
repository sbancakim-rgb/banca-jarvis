# 방카 지식검색 - Vertex AI Search 인프라

이 Terraform 코드는 방카슈랑스 지식검색 시스템의 검색 데이터 레이어를 만든다:

- **내부 문서 데이터스토어** (`internal-documents`): 회사 내부의 상품약관/업무매뉴얼/세법자료 PDF 등을 보관할 Cloud Storage 버킷 + 이를 색인할 Vertex AI Search 데이터스토어
- **웹사이트 데이터스토어** (`website_sources` 변수로 관리): 생명보험협회 공시실, 금융감독원 표준약관처럼 외부에 공개된 자료를 자동으로 주기적 재크롤링하는 데이터스토어
- **검색 엔진** (`banca-knowledge-search`): 위 데이터스토어들을 묶어 하나의 검색 앱으로 노출. 생성형 답변(LLM) 기능 포함

## 0. 사전 준비 (콘솔에서 직접)

1. GCP 프로젝트 생성
2. 결제 계정(billing) 연결
3. 로컬에서 `gcloud auth application-default login` 실행 (Terraform이 사용할 인증)

## 1. 배포

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# terraform.tfvars 값을 실제 project_id / company_name / internal_bucket_name으로 수정

terraform init
terraform plan
terraform apply
```

## 2. 내부 문서 색인하기

내부 문서(약관/매뉴얼/세법자료)는 Terraform이 아니라 아래 절차로 반영한다:

```bash
# 1) PDF를 버킷에 업로드
gsutil cp ./내부문서/*.pdf gs://<internal_documents_bucket 출력값>/

# 2) Vertex AI Search에 import 요청 (REST API 호출)
PROJECT_ID="<project_id>"
DATA_STORE_ID="internal-documents-v3"
BUCKET="<internal_documents_bucket 출력값>"

curl -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://discoveryengine.googleapis.com/v1/projects/${PROJECT_ID}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}/branches/0/documents:import" \
  -d '{
    "gcsSource": {
      "inputUris": ["gs://'"${BUCKET}"'/*"],
      "dataSchema": "content"
    },
    "reconciliationMode": "INCREMENTAL"
  }'
```

문서를 새로 추가하거나 교체할 때마다 위 import 호출을 다시 실행하면 된다. (이 단계는 추후 "PDF 업로드 시 자동 import" Cloud Function으로 자동화 가능 — 현재는 1단계 범위 밖)

## 3. 웹사이트 자동 크롤링 확인

웹사이트 데이터스토어는 생성 후 별도 조치 없이 자동으로 초기 크롤링을 시작한다 (완료까지 수 시간~1일 소요 가능). 이후 Vertex AI Search가 best-effort로 주기적 재크롤링하여 새 글/개정된 약관을 자동으로 반영한다.

웹사이트 데이터스토어는 검색 앱에 묶기 위해 Advanced Site Search로 생성된다 (Basic Site Search는 검색 엔진에 추가할 수 없는 GCP 제약사항). Advanced Site Search는 일반 데이터스토어보다 비용이 더 든다.

새 출처를 추가하려면 `variables.tf`의 `website_sources` 맵에 항목을 추가하고 `terraform apply`만 다시 실행하면 된다:

```hcl
website_sources = {
  "klia-disclosure-site-v2"     = { display_name = "생명보험협회 공시실",   uri_pattern = "pub.insure.or.kr/*" }
  "fss-standard-terms-site-v2"  = { display_name = "금융감독원 표준약관",   uri_pattern = "fss.or.kr/fss/bbs/B0000115/*" }
  "law-go-kr-income-tax"     = { display_name = "국가법령정보센터 소득세법", uri_pattern = "law.go.kr/lsInfoP.do*" }
}
```

## 4. 동작 확인

GCP 콘솔 > Vertex AI Search > Apps 에서 `banca-knowledge-search` 앱을 열고 "미리보기"로 질문을 입력해 검색/답변이 잘 나오는지 확인한다.

## 다음 단계

이 인프라가 검증되면, 프론트엔드(텍스트 검색 화면)와 이 검색 엔진을 연결하는 Cloud Run API(`/api/search`)를 추가한다.
