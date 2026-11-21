#!/usr/bin/env python3
"""MVP-C verification passes over the public HTTP interface."""
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).parent))
import mvpb_verify as base

base.results = []
check = base.check
call = base.call
psql = base.psql
obtain_session = base.obtain_session
new_account = base.new_account
json_body = base.json_body

BASE = base.BASE
MAINTAINER = base.MAINTAINER
METADATA = {
    "publisher": "BetterGov",
    "sourceUrl": "https://data.bettergov.ph/datasets/27",
    "license": "CC0 1.0 Universal",
    "coverage": {"fiscalYears": [2024, 2025]},
    "fields": [{"name": "year", "type": "integer", "description": "Fiscal year"}],
    "limitations": ["parse-only validation"],
}


def raw_upload(filename, body, cookie=None):
    url = f"{BASE}/api/v1/imports/register?filename={filename}&name=verify"
    headers = {"content-type": "application/octet-stream"}
    if cookie:
        headers["cookie"] = cookie
    req = urllib.request.Request(url, data=body.encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def draft(cookie, filename="data.csv", body="year,status\n2024,GAA\n2025,GAA\n"):
    status, raw = raw_upload(filename, body, cookie)
    assert status == 201, raw
    return json_body(raw)


def spec():
    maint, maint_user = obtain_session(MAINTAINER)
    author, author_user = new_account("mvpc-author")
    check("S1/S5 owner session exists", maint_user["role"] == "maintainer" and author_user["role"] == "submitter")

    status, raw = raw_upload("data.csv", "year,status\n2024,GAA\n")
    check("S1 anonymous upload refused", status == 401 and json_body(raw)["error"] == "sign_in_required", (status, raw[:100]))
    status, raw = raw_upload("data.txt", "year,status\n2024,GAA\n", author)
    check("S1 unsupported format refused", status == 400 and json_body(raw)["error"] == "unsupported_format", (status, raw[:100]))

    one = draft(author)
    check("S1/S2 valid CSV validated and normalized",
          one["status"] == "validated" and one.get("normalized_rows") == 2, one)
    stored = psql(f"SELECT count(*) FROM import_rows WHERE draft_id='{one['id'].removeprefix('draft-')}'")
    check("S2 rows stored relationally", stored == "2", stored)

    empty = draft(author, "empty.csv", "year,status\n")
    check("S3 empty dataset quarantined", empty["status"] == "quarantined" and empty["checkRows"] == "empty_dataset", empty)
    reason = psql(f"SELECT reason FROM quarantine_records WHERE draft_id='{empty['id'].removeprefix('draft-')}'")
    check("S3 quarantine reason recorded", reason == "schema_invalid", reason)
    check("S3 quarantine log rejects UPDATE", "append-only" in psql("UPDATE quarantine_records SET reason='x'"))

    json_file = draft(author, "data.json", '[{"year":2024,"status":"GAA"}]')
    check("S1 JSON import normalized", json_file.get("normalized_rows") == 1, json_file)

    status, raw, _ = call("POST", f"/api/v1/imports/{one['id']}/publish",
                          {"reason": "checked", "metadata": {**METADATA, "publisher": ""}}, maint)
    check("S4 incomplete publication metadata refused", status == 400 and json_body(raw)["error"] == "invalid_metadata", (status, raw[:100]))
    status, raw, _ = call("POST", f"/api/v1/imports/{one['id']}/publish",
                          {"reason": "source and reuse terms checked", "metadata": METADATA}, maint)
    published = json_body(raw)
    check("S5 maintainer publishes a new release",
          status == 201 and published["draft"]["status"] == "published" and published["release_id"].startswith("release-"), (status, raw[:150]))
    check("S5 publication log rejects UPDATE", "append-only" in psql("UPDATE publication_decisions SET reason='x'"))

    status, raw, _ = call("GET", "/api/v1/agencies")
    agencies = json_body(raw).get("agencies", [])
    check("S6 agencies are public", status == 200 and any(a["id"] == "bettergov" for a in agencies), agencies)

    status, raw, _ = call("GET", "/api/v1/datasets")
    datasets = json_body(raw)["datasets"]
    canonical = [d for d in datasets if d["id"] == "bettergov-gaa-coverage-2026-11-07"]
    check("S12 verified freshness metadata exposed",
          bool(canonical) and canonical[0]["agencyId"] == "bettergov" and canonical[0]["freshnessStatus"] == "current",
          canonical[0] if canonical else None)
    check("S5 private drafts stay out of the catalog", not any(d["id"].startswith("draft-") for d in datasets))

    status, raw, _ = call("GET", "/api/v1/saved-views")
    check("S12 saved views require an owner", status == 401, status)
    status, raw, _ = call("POST", "/api/v1/saved-views", {
        "name": "FY2024", "datasetReleaseId": "bettergov-gaa-coverage-2026-11-07", "filters": {"year": 2024}}, author)
    view = json_body(raw)
    check("S12 saved view created", status == 201 and view.get("filters") == {"year": 2024}, (status, raw[:150]))
    status, raw, _ = call("GET", "/api/v1/saved-views", cookie=author)
    check("S12 saved view listed for its owner", status == 200 and any(v["id"] == view["id"] for v in json_body(raw)["views"]), status)

    status, raw, _ = call("GET", "/api/v1/datasets")
    all_rows = json_body(raw)["datasets"]
    status, raw, _ = call("GET", "/api/v1/datasets?limit=2")
    limited = json_body(raw)["datasets"]
    status, raw, _ = call("GET", "/api/v1/datasets?offset=1&limit=1")
    offset = json_body(raw)["datasets"]
    check("S7 pagination is opt-in and ordered",
          len(limited) == 2 and len(offset) == 1 and offset[0]["id"] == all_rows[1]["id"], (len(all_rows), len(limited), offset))
    status, raw, _ = call("GET", "/api/v1/datasets?limit=0")
    check("S7 invalid pagination refused", status == 400 and json_body(raw)["error"] == "invalid_pagination", (status, raw[:100]))


def adversarial():
    maint, _ = obtain_session(MAINTAINER)
    author, _ = new_account("mvpc-adv-author")
    reviewer, _ = new_account("mvpc-adv-reviewer", "reviewer")

    for path in ("/api/v1/saved-views", "/api/v1/review/queue"):
        status, _, _ = call("GET", path, cookie="saysight_session=forged")
        check(f"forged session refused on {path}", status == 401, status)
    status, _ = raw_upload("data.csv", "year,status\n2024,GAA\n", "saysight_session=forged")
    check("forged session refused on upload", status == 401, status)

    good = draft(author)
    for cookie, role in ((reviewer, "reviewer"), (author, "submitter")):
        status, raw, _ = call("POST", f"/api/v1/imports/{good['id']}/publish", {"reason": "x", "metadata": METADATA}, cookie)
        check(f"{role} cannot publish", status == 403 and json_body(raw)["error"] == "maintainer_required", (status, raw[:100]))

    quarantined = draft(author, "empty.csv", "year,status\n")
    status, raw, _ = call("POST", f"/api/v1/imports/{quarantined['id']}/publish", {"reason": "x", "metadata": METADATA}, maint)
    check("quarantined draft cannot be published", status == 409 and json_body(raw)["error"] == "draft_not_validated", (status, raw[:100]))

    status, raw, _ = call("POST", "/api/v1/imports/draft-00000000-0000-0000-0000-000000000000/publish",
                          {"reason": "x", "metadata": METADATA}, maint)
    check("unknown draft returns 404", status == 404 and json_body(raw)["error"] == "draft_not_found", (status, raw[:100]))

    status, raw, _ = call("POST", "/api/v1/saved-views", {"name": "x", "datasetReleaseId": "x", "filters": {}}, author)
    check("unknown dataset release returns 404", status == 404 and json_body(raw)["error"] == "dataset_release_not_found", (status, raw[:100]))
    url = f"{BASE}/api/v1/saved-views"
    req = urllib.request.Request(url, data=b'{"name":"big","filters":{},"datasetReleaseId":"bettergov-gaa-coverage-2026-11-07","pad":"' + b'x' * (1024 * 1024 + 100) + b'"}',
                                 headers={"content-type": "application/json", "cookie": author}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=20)
        status = 200
    except urllib.error.HTTPError as error:
        status = error.code
    check("oversized JSON body capped", status == 413, status)

    for table in ("quarantine_records", "publication_decisions"):
        output = psql(f"UPDATE {table} SET reason='x' WHERE id=(SELECT id FROM {table} LIMIT 1)")
        check(f"{table} rejects UPDATE", "append-only" in output, output[:100])


mode = sys.argv[1] if len(sys.argv) > 1 else "spec"
(spec if mode == "spec" else adversarial if mode == "adversarial" else lambda: sys.exit("usage: mvpc_verify.py spec|adversarial"))()
failed = [label for label, ok, _ in base.results if not ok]
print(f"\n{len(base.results) - len(failed)}/{len(base.results)} passed")
if failed:
    print("FAILED: " + "; ".join(failed))
    sys.exit(1)
print("ALL_OK")
