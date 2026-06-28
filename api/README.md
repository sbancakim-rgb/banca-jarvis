# 방카 지식검색 - `/api/search` (Cloud Run)

검색어를 받아서 Vertex AI Search로 조회 → Gemini로 주제별 그룹 분류 → 클릭 통계로 그룹 순서 재정렬해서 돌려주는 백엔드.

먼저 `infra/terraform`이 배포되어 있어야 한다 (검색 엔진, Firestore, 서비스 계정이 거기서 만들어짐).

## 1. 배포

```bash
cd api

gcloud run deploy banca-search-api \
  --source . \
  --region asia-northeast3 \
  --service-account <terraform output search_api_service_account_email 값> \
  --memory 1Gi \
  --set-env-vars PROJECT_ID=<project_id>,REGION=us-central1,DISCOVERY_LOCATION=global,ENGINE_ID=banca-knowledge-search \
  --allow-unauthenticated
```

> ⚠️ **`--region asia-northeast3`(Cloud Run 서비스 자체가 뜨는 위치)와 환경변수 `REGION`(Gemini 모델 호출 위치)은 서로 다른 값이어야 한다.** `gemini-2.0-flash-001`은 `asia-northeast3`(서울)에서 제공되지 않아 `REGION`을 거기로 설정하면 검색 시 `404 Publisher model ... was not found` 에러가 난다 — 반드시 `us-central1`처럼 Gemini가 제공되는 리전으로 지정할 것. Discovery Engine 검색 자체는 `DISCOVERY_LOCATION=global`을 따로 쓰므로 이 설정과는 무관하다.
>
> ⚠️ **`--memory 1Gi`를 빼면 기본 512MiB로 배포되는데, Gemini 호출 중 메모리 초과(`Memory limit ... exceeded`)로 요청이 실패할 수 있다.** 반드시 `--memory 1Gi` 이상으로 지정할 것.

`--service-account` 값은 `infra/terraform`에서 아래로 확인:

```bash
cd ../infra/terraform
terraform output search_api_service_account_email
```

배포가 끝나면 `gcloud run deploy`가 서비스 URL(`https://banca-search-api-xxxx.a.run.app`)을 출력한다. 이 URL이 프론트엔드가 호출할 주소.

> ⚠️ **`--allow-unauthenticated`는 인증 없이 누구나 호출 가능하다는 뜻.** 지금은 빠르게 동작 확인을 위해 이렇게 열어두지만, 실제 운영 전에는 호출 인증(API 키, Firebase App Check 등)을 추가해야 한다 — 그렇지 않으면 외부에서 검색 API를 무한정 호출해 Gemini/Firestore 비용이 의도치 않게 늘어날 수 있다.

## 2. API

### `POST /api/search`

요청:
```json
{ "query": "비과세" }
```

응답:
```json
{
  "query": "비과세",
  "topics": [
    {
      "title": "연금보험 비과세 한도",
      "primaryDocId": "...",
      "clickCount": 3,
      "items": [
        {
          "docId": "...",
          "title": "...",
          "link": "...",
          "snippet": "...",
          "source": {
            "type": "internal",
            "label": "내부 자료",
            "link": "https://console.cloud.google.com/storage/browser/_details/<bucket>/<object>?project=<project_id>",
            "collectedAt": "2026-06-20T01:23:45.000000+00:00",
            "lastRevisedNote": "원문 발행일/최종 개정일은 자동으로 추출되지 않습니다 — 원문 링크에서 직접 확인하세요."
          }
        }
      ]
    }
  ],
  "popularSearches": ["비과세", "실손보험 갱신", "..."],
  "disclaimer": "위 분류와 제목은 AI가 자동 생성한 것으로 부정확할 수 있습니다. 실제 적용 시 원문 약관/법령을 반드시 확인하세요."
}
```

프론트엔드는 처음에는 `topics[].title` 목록만 보여주고, 클릭하면 해당 `items`를 펼쳐서 보여주면 된다. `popularSearches`는 검색창 아래 추천 검색어로 그대로 노출. `disclaimer`는 AI 답변/분류 하단에 항상 표시해야 한다 (infra/terraform/README.md의 출처 정보 요구사항 5번).

#### `items[].source` 필드

각 결과 항목의 출처를 화면에 표시하기 위한 정보 (infra/terraform/README.md의 출처 정보 요구사항 1~4번 대응):

- `type` / `label`: 결과가 어느 데이터스토어에서 왔는지에 따라 자동 분류됨 — `internal`("내부 자료"), `external_snapshot`("외부 공개자료 (직접수집 사본)" — law.go.kr 등 fetcher가 가져온 사본), `external_website`("외부 웹사이트" — 향후 생명보험협회/금감원 Advanced Site Search가 동작하면 해당).
- `link`: 원문으로 이동할 링크. 내부 PDF는 공개 URL이 없으므로 GCP 콘솔의 객체 상세 페이지 링크로 대체(사내 직원만 접근 가능, GCP 콘솔 권한 필요). fetcher가 수집한 외부 공개자료는 `sourceUrl` 커스텀 메타데이터가 있으면 실제 원문 URL을 그대로 보여준다.
- `collectedAt`: "수집 시점". fetcher가 기록한 `collectedAt` 커스텀 메타데이터가 있으면 그 값을, 없으면 GCS 객체의 시스템 `updated` 타임스탬프(가장 최근 업로드/재인덱싱 시각)를 대체로 사용한다. ⚠️ 후자는 "마지막으로 GCS에 쓰여진 시각"일 뿐 "실제 크롤링된 시각"과는 다를 수 있어 보수적인 근사값이다.
- `lastRevisedNote`: 원문 발행일/최종 개정일은 자동으로 추출되지 않는다는 고정 안내 문구 (요구사항 4번 — 아직 미해결, 항상 이 문구로 안내).

⚠️ 이 메타데이터 조회는 결과마다 GCS API를 호출하는 best-effort 동작이라, 실패해도(예: 권한 문제, 객체 삭제됨) 검색 자체는 멈추지 않고 해당 필드만 비어있게 채워진다.

### `POST /api/click`

사용자가 특정 주제(그룹)를 클릭했을 때 호출 — 이게 누적되어야 다음 검색부터 클릭 많은 주제가 위로 올라온다.

요청:
```json
{ "query": "비과세", "docId": "<클릭한 주제의 primaryDocId>" }
```

## 3. 클릭 우선순위 동작 방식

검색어가 같아도 Gemini가 매번 주제 제목을 똑같이 짓지 않기 때문에, 클릭 통계는 제목 텍스트가 아니라 **그 그룹의 대표 문서(`primaryDocId`)** 기준으로 쌓인다. 같은 검색어로 다시 검색했을 때, 새로 만들어진 그룹 중 과거에 클릭이 많았던 문서를 대표로 가진 그룹이 위로 올라온다. 처음 보는 검색어는 클릭 데이터가 없으므로 Vertex AI Search가 매긴 관련도 순서 그대로 노출된다.

## 4. 코드 수정 후 재배포

`main.py`를 수정한 뒤에는 위 1번의 `gcloud run deploy` 명령을 그대로 다시 실행하면 된다 (새로 빌드해서 배포).
