import json
import math
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, request
from google.cloud import discoveryengine_v1 as discoveryengine
from google.cloud import firestore
from google.cloud import storage
import vertexai
from vertexai.generative_models import GenerativeModel

PROJECT_ID = os.environ["PROJECT_ID"]
REGION = os.environ.get("REGION", "us-central1")  # Gemini 모델 호출용 Vertex AI 리전. gemini-2.0-flash-001은 asia-northeast3에서 제공되지 않음.
DISCOVERY_LOCATION = os.environ.get("DISCOVERY_LOCATION", "global")
ENGINE_ID = os.environ.get("ENGINE_ID", "banca-knowledge-search")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
CLICK_WINDOW_DAYS = int(os.environ.get("CLICK_WINDOW_DAYS", "30"))
POPULAR_SEARCH_LIMIT = int(os.environ.get("POPULAR_SEARCH_LIMIT", "8"))
CLICK_BOOST_WEIGHT = float(os.environ.get("CLICK_BOOST_WEIGHT", "5"))

# 내부문서/직접수집 데이터스토어 ID. 출처 배지("내부 자료" vs "외부 공개자료")를
# 결정하는 데 쓴다 — infra/terraform의 datastore_internal.tf, fetch_pipeline.tf와 ID를 맞출 것.
INTERNAL_DATA_STORE_ID = os.environ.get("INTERNAL_DATA_STORE_ID", "internal-documents-v4")
EXTERNAL_SNAPSHOT_DATA_STORE_ID = os.environ.get("EXTERNAL_SNAPSHOT_DATA_STORE_ID", "external-snapshots-v1")

LAST_REVISED_NOTE = "원문 발행일/최종 개정일은 자동으로 추출되지 않습니다 — 원문 링크에서 직접 확인하세요."
AI_DISCLAIMER = "위 분류와 제목은 AI가 자동 생성한 것으로 부정확할 수 있습니다. 실제 적용 시 원문 약관/법령을 반드시 확인하세요."

GCS_URI_RE = re.compile(r"^gs://([^/]+)/(.+)$")
DATA_STORE_ID_RE = re.compile(r"/dataStores/([^/]+)/")

app = Flask(__name__)
db = firestore.Client(project=PROJECT_ID)
storage_client = storage.Client(project=PROJECT_ID)
vertexai.init(project=PROJECT_ID, location=REGION)
search_client = discoveryengine.SearchServiceClient()

SERVING_CONFIG = (
    f"projects/{PROJECT_ID}/locations/{DISCOVERY_LOCATION}/collections/default_collection/"
    f"engines/{ENGINE_ID}/servingConfigs/default_search"
)


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


def normalize_query(q: str) -> str:
    return re.sub(r"\s+", " ", q.strip().lower())


def search_documents(query: str, page_size: int = 20):
    req = discoveryengine.SearchRequest(
        serving_config=SERVING_CONFIG,
        query=query,
        page_size=page_size,
    )
    response = search_client.search(req)

    raw_results = []
    for r in response.results:
        struct = dict(r.document.derived_struct_data.items()) if r.document.derived_struct_data else {}
        raw_results.append((r.document.name, r.document.id, struct))

    with ThreadPoolExecutor(max_workers=8) as pool:
        sources = list(pool.map(lambda item: _build_source_info(item[0], item[2]), raw_results))

    results = []
    for (doc_name, doc_id, struct), source in zip(raw_results, sources):
        results.append(
            {
                "docId": doc_id,
                "title": struct.get("title") or struct.get("htmlTitle") or doc_id,
                "link": struct.get("link", ""),
                "snippet": _extract_snippet(struct),
                "source": source,
            }
        )
    return results


def _extract_snippet(struct: dict) -> str:
    snippets = struct.get("snippets")
    if snippets:
        return snippets[0].get("snippet", "")
    return ""


def _parse_gcs_uri(uri: str):
    match = GCS_URI_RE.match(uri or "")
    if not match:
        return None
    return match.group(1), match.group(2)


def _data_store_id_from_name(document_name: str) -> str:
    match = DATA_STORE_ID_RE.search(document_name or "")
    return match.group(1) if match else ""


def _fetch_gcs_object_info(bucket_name: str, object_name: str) -> dict:
    try:
        blob = storage_client.bucket(bucket_name).get_blob(object_name)
        if blob is None:
            return {}
        return {
            "updated": blob.updated.isoformat() if blob.updated else None,
            "customMetadata": blob.metadata or {},
        }
    except Exception:
        return {}


def _build_source_info(document_name: str, struct: dict) -> dict:
    data_store_id = _data_store_id_from_name(document_name)
    if data_store_id == INTERNAL_DATA_STORE_ID:
        source_type, label = "internal", "내부 자료"
    elif data_store_id == EXTERNAL_SNAPSHOT_DATA_STORE_ID:
        source_type, label = "external_snapshot", "외부 공개자료 (직접수집 사본)"
    else:
        source_type, label = "external_website", "외부 웹사이트"

    link = struct.get("link", "")
    collected_at = None

    parsed = _parse_gcs_uri(link)
    if parsed:
        bucket_name, object_name = parsed
        gcs_info = _fetch_gcs_object_info(bucket_name, object_name)
        custom_metadata = gcs_info.get("customMetadata", {})
        link = custom_metadata.get("sourceUrl") or (
            f"https://console.cloud.google.com/storage/browser/_details/{bucket_name}/{object_name}"
            f"?project={PROJECT_ID}"
        )
        collected_at = custom_metadata.get("collectedAt") or gcs_info.get("updated")

    return {
        "type": source_type,
        "label": label,
        "link": link,
        "collectedAt": collected_at,
        "lastRevisedNote": LAST_REVISED_NOTE,
    }


def cluster_with_gemini(query: str, results: list) -> list:
    if not results:
        return []

    numbered = "\n".join(
        f"[{i}] docId={r['docId']} title={r['title']} snippet={r['snippet'][:200]}"
        for i, r in enumerate(results)
    )
    prompt = f"""다음은 검색어 "{query}"에 대한 검색 결과 목록이다. 내용이 비슷한 것끼리 묶어서
주제별 그룹으로 분류하고, 각 그룹에 사용자가 클릭하고 싶어질 만한 짧은 한글 제목을 붙여라.
"primaryIndex"는 그 그룹을 대표하는 가장 핵심적인 결과의 번호([] 안의 숫자)다.
반드시 아래 JSON 형식으로만 답하라:

{{"groups": [{{"title": "...", "indices": [0, 2, 5], "primaryIndex": 0}}]}}

검색 결과:
{numbered}
"""
    model = GenerativeModel(GEMINI_MODEL)
    response = model.generate_content(
        prompt,
        generation_config={"response_mime_type": "application/json"},
    )

    try:
        groups = json.loads(response.text).get("groups", [])
    except (ValueError, AttributeError, TypeError):
        groups = [{"title": query, "indices": list(range(len(results))), "primaryIndex": 0}]

    topics = []
    for g in groups:
        indices = [i for i in g.get("indices", []) if 0 <= i < len(results)]
        if not indices:
            continue
        primary_index = g.get("primaryIndex", indices[0])
        if primary_index not in indices:
            primary_index = indices[0]
        topics.append(
            {
                "title": g.get("title") or "기타",
                "primaryDocId": results[primary_index]["docId"],
                "items": [results[i] for i in indices],
            }
        )
    return topics


def attach_click_ranking(norm_query: str, topics: list) -> list:
    cutoff = datetime.now(timezone.utc) - timedelta(days=CLICK_WINDOW_DAYS)
    clicks = (
        db.collection("search_clicks")
        .where("query", "==", norm_query)
        .where("clickedAt", ">=", cutoff)
        .stream()
    )
    click_counts: dict[str, int] = {}
    for click in clicks:
        doc_id = click.get("docId")
        click_counts[doc_id] = click_counts.get(doc_id, 0) + 1

    ranked = []
    for relevance_rank, topic in enumerate(topics):
        click_count = click_counts.get(topic["primaryDocId"], 0)
        topic["clickCount"] = click_count
        score = -relevance_rank + CLICK_BOOST_WEIGHT * math.log1p(click_count)
        ranked.append((score, topic))

    ranked.sort(key=lambda pair: pair[0], reverse=True)
    return [topic for _, topic in ranked]


def record_search(norm_query: str) -> None:
    db.collection("search_queries").add(
        {"query": norm_query, "searchedAt": datetime.now(timezone.utc)}
    )


def get_popular_searches(limit: int = POPULAR_SEARCH_LIMIT) -> list:
    cutoff = datetime.now(timezone.utc) - timedelta(days=CLICK_WINDOW_DAYS)
    docs = db.collection("search_queries").where("searchedAt", ">=", cutoff).stream()

    counts: dict[str, int] = {}
    for doc in docs:
        q = doc.get("query")
        counts[q] = counts.get(q, 0) + 1

    ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    return [q for q, _ in ranked[:limit]]


@app.route("/api/search", methods=["POST", "OPTIONS"])
def api_search():
    if request.method == "OPTIONS":
        return "", 204

    body = request.get_json(silent=True) or {}
    query = (body.get("query") or "").strip()
    if not query:
        return jsonify({"error": "query is required"}), 400

    norm_query = normalize_query(query)
    results = search_documents(query)
    topics = cluster_with_gemini(query, results)
    topics = attach_click_ranking(norm_query, topics)
    record_search(norm_query)

    return jsonify(
        {
            "query": query,
            "topics": topics,
            "popularSearches": get_popular_searches(),
            "disclaimer": AI_DISCLAIMER,
        }
    )


@app.route("/api/click", methods=["POST", "OPTIONS"])
def api_click():
    if request.method == "OPTIONS":
        return "", 204

    body = request.get_json(silent=True) or {}
    query = (body.get("query") or "").strip()
    doc_id = body.get("docId")
    if not query or not doc_id:
        return jsonify({"error": "query and docId are required"}), 400

    db.collection("search_clicks").add(
        {
            "query": normalize_query(query),
            "docId": doc_id,
            "clickedAt": datetime.now(timezone.utc),
        }
    )
    return jsonify({"ok": True})


@app.route("/healthz", methods=["GET"])
def healthz():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
