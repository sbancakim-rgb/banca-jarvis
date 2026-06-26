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
  --set-env-vars PROJECT_ID=<project_id>,REGION=asia-northeast3,DISCOVERY_LOCATION=global,ENGINE_ID=banca-knowledge-search \
  --allow-unauthenticated
```

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
        { "docId": "...", "title": "...", "link": "...", "snippet": "..." }
      ]
    }
  ],
  "popularSearches": ["비과세", "실손보험 갱신", "..."]
}
```

프론트엔드는 처음에는 `topics[].title` 목록만 보여주고, 클릭하면 해당 `items`를 펼쳐서 보여주면 된다. `popularSearches`는 검색창 아래 추천 검색어로 그대로 노출.

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
