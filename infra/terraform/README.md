# 방카 지식검색 - Vertex AI Search 인프라

이 Terraform 코드는 방카슈랑스 지식검색 시스템의 검색 데이터 레이어를 만든다:

- **내부 문서 데이터스토어** (`internal-documents`): 회사 내부의 상품약관/업무매뉴얼/세법자료 PDF 등을 보관할 Cloud Storage 버킷 + 이를 색인할 Vertex AI Search 데이터스토어
- **웹사이트 데이터스토어** (`website_sources` 변수로 관리): 생명보험협회 공시실, 금융감독원 표준약관처럼 외부에 공개된 자료를 자동으로 주기적 재크롤링하는 데이터스토어. ⚠️ 도메인 소유권 인증이 필요해서 현재 동작하지 않음 (3번 참고)
- **외부 공개자료 직접수집 데이터스토어** (`external-snapshots-v1`): law.go.kr처럼 도메인 인증이 불가능한 외부 사이트를 위해, 우리가 직접 가져와 저장한 사본을 색인하는 데이터스토어 (4번 참고)
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
DATA_STORE_ID="internal-documents-v4"
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

> ⚠️ **현재 알려진 한계: 아래 Advanced Site Search 방식은 본인이 소유하지 않은 도메인에는 동작하지 않는다.** Advanced Site Search는 GCP 정책상 Google Search Console로 도메인 소유권을 인증해야 색인이 시작되는데, `pub.insure.or.kr`(생명보험협회)·`fss.or.kr`(금융감독원)은 우리 회사 소유 도메인이 아니라서 인증이 불가능하다. 실제로 콘솔에서 두 데이터스토어 모두 "도메인이 확인되지 않았습니다. 색인 생성을 시작할 수 없습니다"로 표시되어 색인이 진행되지 않고 있다 (2026-06-26 확인). 우회 방법으로 "도메인 연결(domain association)" 요청을 그 기관에 보내 승인받는 방법이 있으나, 일반 기업이 금융감독원/생명보험협회로부터 이런 승인을 받기는 현실적으로 어렵다. 해결되기 전까지 이 2개 출처는 검색 결과에 반영되지 않는다 — 후속 작업으로 `fetcher/`와 같은 직접수집 방식으로 전환하는 게 필요하다 (아래 4번 참고).

웹사이트 데이터스토어는 생성 후 별도 조치 없이 자동으로 초기 크롤링을 시작한다 (도메인 인증이 된 경우에 한해 완료까지 수 시간~1일 소요 가능). 이후 Vertex AI Search가 best-effort로 주기적 재크롤링하여 새 글/개정된 약관을 자동으로 반영한다.

웹사이트 데이터스토어는 검색 앱에 묶기 위해 Advanced Site Search로 생성된다 (Basic Site Search는 검색 엔진에 추가할 수 없는 GCP 제약사항). Advanced Site Search는 일반 데이터스토어보다 비용이 더 든다.

새 출처를 추가하려면 `variables.tf`의 `website_sources` 맵에 항목을 추가하고 `terraform apply`만 다시 실행하면 된다 — **단, 본인(회사)이 도메인 소유권을 인증할 수 있는 사이트에만 쓸 것:**

```hcl
website_sources = {
  "klia-disclosure-site-v2"    = { display_name = "생명보험협회 공시실",    uri_pattern = "pub.insure.or.kr/*" }
  "fss-standard-terms-site-v2" = { display_name = "금융감독원 표준약관",    uri_pattern = "fss.or.kr/fss/bbs/B0000115/*" }
}
```

## 4. 외부 공개자료 직접수집 (법제처 3개 법령)

`law.go.kr`(국가법령정보센터)도 위와 같은 도메인 인증 문제가 있어서, 3번의 Advanced Site Search 방식이 아니라 **우리가 주기적으로 직접 가져와서(fetch) 색인하는 별도 파이프라인**으로 처리한다 (`fetch_pipeline.tf` + 저장소 루트의 `fetcher/` 디렉터리). 배포 방법은 `fetcher/README.md` 참고.

대상 법령 목록은 `variables.tf`의 `law_go_kr_sources` 맵으로 관리한다:

```hcl
law_go_kr_sources = {
  "law-go-kr-income-tax"           = { display_name = "소득세법",          url = "https://www.law.go.kr/lsInfoP.do?lsiSeq=188543" }
  "law-go-kr-corporate-tax"        = { display_name = "법인세법",          url = "https://www.law.go.kr/lsInfoP.do?lsiSeq=199738" }
  "law-go-kr-inheritance-gift-tax" = { display_name = "상속세 및 증여세법", url = "https://www.law.go.kr/lsInfoP.do?lsiSeq=109453" }
}
```

> ⚠️ `lsiSeq` 값은 검색을 통해 찾은 것으로, **실제 해당 법령의 현행 본문 페이지가 맞는지 브라우저로 직접 열어서 한 번 확인**해야 한다 (`https://www.law.go.kr/lsInfoP.do?lsiSeq=<값>` 로 접속해 페이지 상단의 법령명·시행 상태 확인). 법이 개정되면 이 ID가 바뀔 수 있다.
>
> 이 ID는 자동으로 갱신되지 않으므로(현재는 수동 확인 방식으로 운영하기로 함), **매년 세법 개정 시기(보통 12월~1월)에 한 번씩** law.go.kr에서 위 3개 법령의 현재 `lsiSeq` 값을 확인하고, 바뀌었다면 이 맵의 `url`과 `fetcher/main.py`의 `DEFAULT_LAW_SOURCES`를 같이 갱신한 뒤 `terraform apply` + fetcher 재배포로 반영하는 것을 권장한다.
>
> ⚠️ law.go.kr이 이 fetcher의 요청 자체를 차단할 가능성도 배제할 수 없다 (이 환경에서 law.go.kr을 직접 열어봤을 때 한 번 차단된 적이 있음). 실제로 가져와지는지는 `fetcher/README.md`의 수동 테스트 단계에서 반드시 확인할 것.

## 5. 동작 확인

GCP 콘솔 > Vertex AI Search > Apps 에서 `banca-knowledge-search` 앱을 열고 "미리보기"로 질문을 입력해 검색/답변이 잘 나오는지 확인한다.

## 다음 단계

이 인프라와 이 검색 엔진을 연결하는 Cloud Run API는 `/api/search`(저장소 루트의 `api/` 디렉터리)에 구현되어 있다. 배포 방법은 `api/README.md` 참고. 이 API는 검색 결과를 주제별로 묶어서 제목으로 보여주고, 클릭 통계로 자주 찾는 주제를 우선 노출하며, 인기 검색어를 집계한다 — 이를 위해 `firestore.tf`(클릭/검색어 로그), `search_api.tf`(Cloud Run용 서비스 계정)가 추가되어 있다.

남은 일: 프론트엔드(`index.html`)에서 이 API를 호출하도록 연결하는 작업.

### `/api/search` 구현 시 반드시 화면에 표시해야 할 출처 정보

방카슈랑스(보험상품 약관/세법) 도메인은 정보가 틀리거나 오래되면 불완전판매·소비자 피해로 이어질 수 있으므로, 검색 결과/AI 답변에는 아래 항목을 빠짐없이 노출해야 한다.

1. **출처 구분 배지** — 결과가 "내부 자료(상품약관/매뉴얼/세법자료)"인지 "외부 공개 웹사이트(생명보험협회/금감원 등)"인지 한눈에 구분되게 표시
2. **원문 링크** — 내부 PDF는 원본 파일(또는 사내 보관 위치), 웹사이트 자료는 크롤링한 실제 원문 URL로 바로 이동 가능하게 표시
3. **수집 시점(크롤링/색인 시각)** — "이 정보는 OOOO년 OO월 OO일 기준으로 수집됨"을 표시. ⚠️ Vertex AI Search가 기본적으로 이 값을 API 응답에 내려주지 않으므로, 별도 메타데이터 관리가 필요함 (내부 문서는 import 시점을 직접 기록, 웹사이트는 크롤링 이력을 따로 추적하거나 보수적으로 "최근 N일 내 자동 재크롤링됨" 같은 안내로 대체)
4. **원문 발행일/개정일** — 약관·세법은 개정이 빈번하므로 "수집 시점"과는 별도로 원문 자체의 발행/최종개정일을 표시해야 함. ⚠️ 이 값도 자동으로 추출되지 않으므로, 내부 문서는 업로드 시 메타데이터로 직접 입력(구조화 import 필요), 웹사이트는 페이지에 명시된 날짜를 파싱하거나 표시 불가 시 "원문 페이지에서 최종 개정일 확인 필요"로 안내
5. **AI 답변 디스클레이머** — 생성형 답변(LLM) 결과 하단에 "AI가 생성한 요약이며 부정확할 수 있습니다. 실제 적용 시 원문 약관/법령을 반드시 확인하세요" 같은 고지 문구를 상시 노출

위 1~5번 중 3, 4번은 Vertex AI Search 기본 기능만으로는 채워지지 않는 부분이라, `/api/search` 백엔드에서 별도 메타데이터 저장소(또는 구조화 import 시 커스텀 필드)로 관리하는 작업이 필요하다.
