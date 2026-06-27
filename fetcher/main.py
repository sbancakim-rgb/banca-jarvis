import json
import os
from datetime import datetime, timezone

import requests
from flask import Flask, jsonify
from google.cloud import storage
from google.cloud import discoveryengine_v1 as discoveryengine

# infra/terraform/variables.tf의 law_go_kr_sources와 동일한 목록을 기본값으로 둔다.
# lsiSeq 값이 바뀌어 URL을 갱신할 때는 여기와 variables.tf를 같이 수정하고 재배포할 것.
DEFAULT_LAW_SOURCES = {
    "law-go-kr-income-tax": {
        "display_name": "소득세법",
        "url": "https://www.law.go.kr/lsInfoP.do?lsiSeq=188543",
    },
    "law-go-kr-corporate-tax": {
        "display_name": "법인세법",
        "url": "https://www.law.go.kr/lsInfoP.do?lsiSeq=199738",
    },
    "law-go-kr-inheritance-gift-tax": {
        "display_name": "상속세 및 증여세법",
        "url": "https://www.law.go.kr/lsInfoP.do?lsiSeq=109453",
    },
}

PROJECT_ID = os.environ["PROJECT_ID"]
DISCOVERY_LOCATION = os.environ.get("DISCOVERY_LOCATION", "global")
DATA_STORE_ID = os.environ.get("DATA_STORE_ID", "external-snapshots-v1")
GCS_BUCKET = os.environ["GCS_BUCKET"]
LAW_SOURCES = json.loads(os.environ["LAW_SOURCES_JSON"]) if os.environ.get("LAW_SOURCES_JSON") else DEFAULT_LAW_SOURCES

# law.go.kr 같은 사이트는 일반적인 스크립트 User-Agent를 차단하는 경우가 있어
# 일반 브라우저처럼 보이는 User-Agent를 사용한다. 그래도 차단될 수 있으니
# 첫 실행은 반드시 수동으로 트리거해서 실제로 가져와지는지 확인할 것 (fetcher/README.md).
FETCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
}

app = Flask(__name__)
storage_client = storage.Client(project=PROJECT_ID)
document_client = discoveryengine.DocumentServiceClient()


def fetch_and_store(key: str, source: dict) -> dict:
    url = source["url"]
    display_name = source.get("display_name", key)

    response = requests.get(url, headers=FETCH_HEADERS, timeout=30)
    response.raise_for_status()

    bucket = storage_client.bucket(GCS_BUCKET)
    blob = bucket.blob(f"{key}.html")
    blob.metadata = {
        "collectedAt": datetime.now(timezone.utc).isoformat(),
        "sourceUrl": url,
        "displayName": display_name,
    }
    blob.upload_from_string(response.text, content_type="text/html; charset=utf-8")

    return {"key": key, "url": url, "status": "ok"}


def import_to_discovery_engine() -> str:
    parent = (
        f"projects/{PROJECT_ID}/locations/{DISCOVERY_LOCATION}/"
        f"collections/default_collection/dataStores/{DATA_STORE_ID}/branches/0"
    )
    request = discoveryengine.ImportDocumentsRequest(
        parent=parent,
        gcs_source=discoveryengine.GcsSource(
            input_uris=[f"gs://{GCS_BUCKET}/*"],
            data_schema="content",
        ),
        reconciliation_mode=discoveryengine.ImportDocumentsRequest.ReconciliationMode.INCREMENTAL,
    )
    operation = document_client.import_documents(request=request)
    return operation.operation.name


@app.route("/run", methods=["POST"])
def run():
    results = []
    for key, source in LAW_SOURCES.items():
        try:
            results.append(fetch_and_store(key, source))
        except requests.RequestException as exc:
            results.append({"key": key, "url": source.get("url"), "status": "failed", "error": str(exc)})

    succeeded = [r for r in results if r["status"] == "ok"]
    import_operation = import_to_discovery_engine() if succeeded else None

    return jsonify({"results": results, "importOperation": import_operation})


@app.route("/healthz", methods=["GET"])
def healthz():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
