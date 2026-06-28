# 방카 지식검색 - 외부 공개자료 직접수집(fetcher)

법제처(law.go.kr) 3개 법령은 Vertex AI Search의 Advanced Site Search(자동 크롤링)로 색인할 수 없다 — 그 방식은 도메인 소유권을 Google Search Console로 인증해야 하는데, law.go.kr은 우리 소유 도메인이 아니라서 인증이 안 된다 (콘솔에서 "도메인이 확인되지 않았습니다"로 표시됨).

그래서 이 서비스가 주기적으로 해당 법령 페이지를 **직접 가져와서(fetch)** 우리 GCS 버킷에 저장하고, 내부문서와 동일한 방식으로 색인한다.

⚠️ **law.go.kr은 법령 본문을 자바스크립트로 비동기 로딩한다.** 단순 HTTP GET(`requests.get`)으로 받은 HTML에는 메뉴/틀만 있고 실제 조문 텍스트가 없어서, 검색 결과에 제목만 나오고 snippet/AI 답변이 항상 비어 있는 문제가 있었다. 그래서 `requests` 대신 Playwright 헤드리스 브라우저로 페이지를 실제로 띄워 자바스크립트 실행이 끝난 뒤의 최종 HTML을 캡처하도록 바꿨다 (`networkidle` 대기 + 2초 추가 대기). 이 때문에 컨테이너 이미지가 Chromium을 포함해서 더 커지고 무거워졌다 — Cloud Run 메모리를 1Gi 이상으로 잡아야 한다(아래 배포 명령 참고).

먼저 `infra/terraform`이 배포되어 있어야 한다 (버킷, 데이터스토어, 서비스 계정이 거기서 만들어짐).

## 1. 배포 (1단계 - fetcher 자체)

```bash
cd ../infra/terraform
terraform output external_fetcher_service_account_email
terraform output external_snapshots_bucket
terraform output external_snapshots_data_store_id
```

위 3개 값을 받아서:

```bash
cd ../../fetcher

gcloud run deploy banca-external-fetcher --source . --region asia-northeast3 --service-account <external_fetcher_service_account_email 값> --no-allow-unauthenticated --memory 2Gi --timeout 180 --set-env-vars PROJECT_ID=<project_id>,DISCOVERY_LOCATION=global,DATA_STORE_ID=<external_snapshots_data_store_id 값>,GCS_BUCKET=<external_snapshots_bucket 값>
```

> ⚠️ `/api/search`(api/)와 달리 이 서비스는 `--no-allow-unauthenticated`로 배포한다. 사람이 직접 호출할 일이 없고 Cloud Scheduler만 호출하면 되므로 공개로 열어둘 이유가 없다.
>
> ⚠️ **`--memory 2Gi`/`--timeout 180`은 헤드리스 브라우저(Chromium) 때문에 필요하다.** 기본 메모리(512MiB)로는 Chromium 실행 중 메모리 초과가 날 수 있고, 페이지 렌더링 대기 시간(`networkidle` + 여유 대기)까지 감안하면 기본 요청 제한시간(300초 이내이긴 하지만 빌드/콜드스타트까지 겹치면 빠듯함)도 넉넉히 잡아두는 게 안전하다.

## 2. 수동으로 한 번 테스트 (꼭 먼저 해볼 것)

⚠️ **law.go.kr이 우리 fetcher의 요청도 차단할 가능성이 있다.** 이 환경에서 law.go.kr 페이지를 직접 열어봤을 때 403(차단)이 났던 적이 있어서, Cloud Run에서 보내는 요청도 막힐 수 있다 — 미리 확인이 안 된 부분이라 실제로 돌려보기 전에는 확신할 수 없다. 그래서 스케줄러에 연결하기 전에 반드시 수동으로 한 번 호출해서 실제로 가져와지는지 확인해야 한다.

⚠️ **헤드리스 브라우저로 바꾼 뒤에도 실제로 본문이 제대로 캡처되는지는 직접 확인이 필요하다.** `networkidle` 대기로 대부분의 자바스크립트 렌더링은 끝나지만, law.go.kr이 이걸로도 충분하지 않게(예: 사용자 클릭 등 추가 동작이 있어야 본문이 나오는 구조라면) 만들어져 있을 가능성은 남아있다. 아래 테스트 후 GCS에 저장된 `.html` 파일을 열어서 실제 법조문(예: "비과세", "제1조")이 들어있는지 꼭 확인할 것.

새 cmd 창에서:

```bash
gcloud run services proxy banca-external-fetcher --region=asia-northeast3 --project=<project_id>
```

"Proxying to ... http://127.0.0.1:8080" 같은 메시지가 뜨면 그 cmd 창은 그대로 두고, **다른 cmd 창**에서:

```bash
curl -X POST http://127.0.0.1:8080/run
```

결과 JSON의 `results` 배열에서 각 법령이 `"status": "ok"`인지 `"status": "failed"`인지 확인한다.

- 전부 `"ok"`면: GCS 버킷에 `law-go-kr-*.html` 3개 파일이 생겼는지, Vertex AI Search 콘솔에서 `external-snapshots-v1` 데이터스토어 문서 수가 올라갔는지 확인하면 끝.
- `"failed"`가 있으면: `error` 내용을 같이 보내주면 원인 파악(차단/타임아웃/페이지 구조 변경 등)을 도와줄 수 있다. law.go.kr이 정말 막고 있다면, 이전에 논의했던 "법제처 Open API 사용" 방식으로 전환하는 게 더 나은 대안이 될 수 있다.

## 3. 배포 (2단계 - 주기적 자동 실행 연결)

수동 테스트가 성공했으면, 1단계 `gcloud run deploy`가 출력한 Service URL을 `infra/terraform/terraform.tfvars`에 추가:

```hcl
external_fetcher_url = "<gcloud run deploy가 출력한 Service URL>"
```

그리고:

```bash
cd ../infra/terraform
terraform apply
```

이러면 Cloud Scheduler가 매주 월요일 새벽 4시(한국시간)에 자동으로 `/run`을 호출하도록 연결된다.

## 4. 코드 수정 후 재배포

`main.py`를 수정한 뒤에는 1번의 `gcloud run deploy` 명령을 그대로 다시 실행하면 된다.

## 5. 수집 시점 메타데이터

각 GCS 객체에는 `collectedAt`(가져온 시각), `sourceUrl`(원문 URL), `displayName`(법령명) 메타데이터가 자동으로 기록된다. `/api/search`에서 "수집 시점"을 표시하려면 이 메타데이터를 읽어와야 한다 (아직 `/api/search`는 이 메타데이터를 읽지 않음 — 추후 연결 필요).

⚠️ **원문 발행일/최종 개정일은 여전히 자동으로 추출되지 않는다.** HTML 페이지에 적힌 시행일/개정일을 파싱하는 로직은 아직 없어서, 이 부분은 추후 별도 작업이 필요하다 (infra/terraform/README.md의 출처 정보 요구사항 4번 참고).
