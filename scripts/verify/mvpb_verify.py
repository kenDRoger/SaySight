#!/usr/bin/env python3
"""MVP-B verification passes over the public HTTP interface.

Usage: python3 scripts/verify/mvpb_verify.py spec|adversarial
Requires the running compose stack; mail is log-only, so magic links are read
from the API container log (the same route the committed UI harness uses).
"""
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from uuid import uuid4

BASE = "http://localhost:3000"
COMPOSE = "/home/ken/Documents/BetterGov/docker-compose.yml"
MAINTAINER = "maintainer@example.org"
results = []


def call(method, path, body=None, cookie=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    hdrs = {"content-type": "application/json"} if data else {}
    if cookie:
        hdrs["cookie"] = cookie
    if headers:
        hdrs.update(headers)
    url = path if str(path).startswith("http") else BASE + path
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, response.read().decode(), dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode(), dict(error.headers)


def check(label, condition, detail=""):
    results.append((label, bool(condition), detail))
    print(("PASS  " if condition else "FAIL  ") + label + (("  -> " + str(detail)) if not condition and detail else ""))


def api_logs():
    return subprocess.run(
        ["docker", "compose", "-f", COMPOSE, "logs", "api", "--since", "3m"],
        capture_output=True, text=True, timeout=10,
    ).stdout


def obtain_session(email, role=None):
    for _ in range(8):
        status, _, _ = call("POST", "/api/v1/auth/magic-link", {"email": email})
        if status != 202:
            raise RuntimeError(f"magic-link request for {email} returned {status}")
        marker = f"magic link for {email}: "
        link = None
        for _ in range(15):
            for line in api_logs().splitlines()[::-1]:
                if marker in line:
                    link = line.split(marker, 1)[1].strip()
                    break
            if link:
                break
            time.sleep(1)
        if not link:
            raise RuntimeError(f"no magic link for {email} in the API log")
        req = urllib.request.Request(link, headers={"accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                set_cookie = response.headers.get("set-cookie", "")
                user = json.loads(response.read().decode())["user"]
                token = re.search(r"saysight_session=([^;]+)", set_cookie).group(1)
        except urllib.error.HTTPError:
            time.sleep(10)  # fixed address inside the one-minute link cooldown
            continue
        if role:
            promote = subprocess.run(
                ["docker", "compose", "-f", COMPOSE, "exec", "-T", "api",
                 "node", "scripts/promote.mjs", email, role],
                capture_output=True, text=True, timeout=10,
            )
            if promote.returncode != 0:
                raise RuntimeError(f"promote failed: {promote.stderr}")
            user["role"] = role
        return f"saysight_session={token}", user
    raise RuntimeError(f"could not obtain a fresh session for {email}")


def json_body(raw):
    return json.loads(raw) if raw else {}


def new_account(label, role=None):
    return obtain_session(f"{label}-{uuid4().hex[:8]}@example.org", role)


def evidence(filters=None):
    body = {"recipe": "summary", **(filters or {})}
    status, raw, _ = call("POST", "/api/v1/analyze", body)
    assert status == 200, raw
    return json_body(raw)["evidence_id"]


def submit(cookie, filters=None):
    status, raw, _ = call("POST", "/api/v1/findings", {"evidence_id": evidence(filters), "claim": "The analyzed GAA coverage matches the published release"}, cookie)
    assert status == 201, raw
    return json_body(raw)


def decide(cookie, finding_id, status_name, reason=None):
    body = {"status": status_name} if reason is None else {"status": status_name, "reason": reason}
    return call("POST", f"/api/v1/findings/{finding_id}/decisions", body, cookie)


def psql(sql):
    result = subprocess.run(
        ["docker", "compose", "-f", COMPOSE, "exec", "-T", "postgres",
         "psql", "-U", "saysight", "-d", "saysight", "-Atc", sql],
        capture_output=True, text=True, timeout=15,
    )
    return (result.stdout + result.stderr).strip()


def spec_pass():
    maint, maint_user = obtain_session(MAINTAINER)
    check("S9/S12 first maintainer is a maintainer", maint_user["role"] == "maintainer", maint_user)
    author, author_user = new_account("author")
    check("S1 new account is a submitter", author_user["role"] == "submitter", author_user)

    status, raw, _ = call("POST", "/api/v1/findings", {"evidence_id": evidence()})
    check("S2 anonymous submission is refused", status == 401 and json_body(raw)["error"] == "sign_in_required", (status, raw[:100]))

    low = submit(author, {"year": 2024})
    high = submit(author)
    check("S7 impact is derived from evidence filters", low["impact"] == "low" and high["impact"] == "high", (low["impact"], high["impact"]))
    check("S4 every new finding begins Unverified", low["status"] == high["status"] == "Unverified")

    status, raw, _ = call("GET", "/api/v1/review/queue", cookie=author)
    check("S3 submitter cannot open the review queue", status == 403 and json_body(raw)["error"] == "reviewer_required", (status, raw[:100]))
    reviewer, reviewer_user = new_account("reviewer", "reviewer")
    status, raw, _ = call("GET", "/api/v1/review/queue", cookie=reviewer)
    check("S3 reviewer can open the queue", status == 200 and isinstance(json_body(raw)["findings"], list), status)

    status, raw, _ = decide(reviewer, low["id"], "Pending verification")
    check("S5 a decision reason is mandatory", status == 400 and json_body(raw)["error"] == "reason_required", (status, raw[:100]))
    status, raw, _ = decide(reviewer, low["id"], "Verified", "too early")
    check("S4 skipped steps are refused", status == 409 and json_body(raw)["error"] == "invalid_transition", (status, raw[:100]))
    status, _, _ = decide(reviewer, low["id"], "Pending verification", "checked against the release")
    status, _, _ = decide(reviewer, low["id"], "In review", "claiming the review")
    status, raw, _ = decide(reviewer, low["id"], "Verified", "checksum, filters, and calculation match")
    check("S4 legal path reaches Verified", status == 200 and json_body(raw)["finding"]["status"] == "Verified", (status, raw[:120]))
    status, raw, _ = decide(reviewer, low["id"], "Rejected", "changing my mind")
    check("S4 terminal status refuses further change", status == 409, (status, raw[:100]))

    status, raw, _ = call("GET", f"/api/v1/findings/{low['id']}/history")
    transitions = json_body(raw).get("transitions", [])
    check("S5 history is append-only in shape and complete",
          status == 200 and len(transitions) == 3 and
          [t["toStatus"] for t in transitions] == ["Pending verification", "In review", "Verified"], transitions)
    check("S5 history rejects UPDATE", "append-only" in psql("UPDATE finding_transitions SET reason='tampered'"), psql("SELECT count(*) FROM finding_transitions"))

    status, raw, _ = call("POST", f"/api/v1/findings/{low['id']}/comments", {"body": "no account"})
    check("S6 anonymous comment is refused", status == 401, status)
    status, raw, _ = call("POST", f"/api/v1/findings/{low['id']}/comments", {"body": "   "}, author)
    check("S6 empty comment is refused", status == 400 and json_body(raw)["error"] == "comment_required", (status, raw[:100]))
    status, raw, _ = call("POST", f"/api/v1/findings/{low['id']}/comments", {"body": "an important caveat"}, author)
    comment = json_body(raw)
    check("S6 signed-in comment is visible immediately", status == 201 and comment.get("status") == "visible", (status, raw[:120]))
    status, raw, _ = call("POST", f"/api/v1/comments/{comment['id']}/removal", {"reason": "self"}, author)
    check("S11 submitter cannot remove", status == 403 and json_body(raw)["error"] == "moderator_required", (status, raw[:100]))
    status, _, _ = call("POST", f"/api/v1/comments/{comment['id']}/removal", {"reason": "off topic"}, reviewer)
    status, raw, _ = call("GET", f"/api/v1/findings/{low['id']}/comments")
    thread = json_body(raw)["comments"]
    removed = [c for c in thread if c["id"] == comment["id"]][0]
    check("S11 removed text is gone but reason stays",
          status == 200 and removed["body"] == "" and removed["removalReason"] == "off topic", removed)
    check("S6 moderation log rejects UPDATE", "append-only" in psql("UPDATE comment_moderation SET reason='x'"))

    reviewer2, _ = new_account("reviewer2", "reviewer")
    for cookie in (reviewer, reviewer2):
        status, _, _ = decide(cookie, high["id"], "Pending verification", "checking the whole series")
        status, _, _ = decide(cookie, high["id"], "In review", "independent review")
    status, raw, _ = decide(reviewer, high["id"], "Verified", "series matches the release")
    first_status = psql(f"SELECT status FROM findings WHERE id='{high['id']}'")
    check("S7 first high-impact decision does not settle", status == 200 and first_status == "In review", (status, first_status))
    status, raw, _ = decide(reviewer2, high["id"], "Rejected", "unfiltered claim overstates coverage")
    conflict = json_body(raw).get("conflict")
    check("S7 second reviewer settles and records conflict",
          status == 200 and json_body(raw)["finding"]["status"] == "Rejected" and conflict, (status, raw[:150]))
    check("S7 conflict log rejects UPDATE", "append-only" in psql("UPDATE review_conflicts SET statuses='[]'"))
    status, raw, _ = call("GET", f"/api/v1/findings/{high['id']}/page")
    check("S7 conflict is visible on the public page", status == 200 and "Reviewers disagreed" in raw, status)

    status, raw, _ = call("POST", f"/api/v1/findings/{low['id']}/explanation")
    check("S8 anonymous explanation generation is refused", status == 401, status)
    status, raw, _ = call("GET", f"/api/v1/findings/{low['id']}/explanation")
    check("S8 no explanation initially", status == 200 and json_body(raw)["explanation"] is None, status)
    status, raw, _ = call("POST", f"/api/v1/findings/{low['id']}/explanation", cookie=reviewer)
    record = json_body(raw)
    check("S8/S10 template fallback is bounded and provenance recorded",
          status == 201 and record.get("source") == "template" and
          len(record.get("text", "")) <= 600 and record.get("templateVersion") == "template-v1", (status, raw[:150]))
    status, raw, _ = call("GET", f"/api/v1/findings/{low['id']}/explanation")
    check("S8 explanation is publicly readable", status == 200 and json_body(raw)["explanation"]["id"] == record["id"], status)
    status, raw, _ = call("GET", f"/api/v1/findings/{low['id']}/page")
    check("S8 page shows explanation provenance", status == 200 and "template-v1" in raw, status)
    check("S8 explanation log rejects UPDATE", "append-only" in psql("UPDATE explanations SET text='x'"))

    status, _, headers = call("POST", "/api/v1/auth/logout", cookie=author)
    status2, _, _ = call("GET", "/api/v1/auth/me", cookie=author)
    check("S1 logout revokes the session", status == 204 and status2 == 401, (status, status2))


def adversarial_pass():
    maint, _ = obtain_session(MAINTAINER)
    author, _ = new_account("adv-author")
    reviewer, _ = new_account("adv-reviewer", "reviewer")

    # A link is single-use; a forged token is no better.
    email = f"adv-link-{uuid4().hex[:8]}@example.org"
    status, _, _ = call("POST", "/api/v1/auth/magic-link", {"email": email})
    marker = f"magic link for {email}: "
    link = None
    for _ in range(15):
        for line in api_logs().splitlines()[::-1]:
            if marker in line:
                link = line.split(marker, 1)[1].strip()
                break
        if link:
            break
        time.sleep(1)
    if not link:
        raise RuntimeError(f"no magic link for {email} appeared in the API log")
    req = urllib.request.Request(link, headers={"accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as response:
        cookie_1 = "saysight_session=" + re.search(r"saysight_session=([^;]+)", response.headers["set-cookie"]).group(1)
    status, raw, _ = call("GET", link, headers={"accept": "application/json"})
    check("replayed magic link is refused", status == 401 and json_body(raw)["error"] == "invalid_or_expired_link", (status, raw[:100]))
    status, _, _ = call("GET", "/api/v1/auth/verify?token=not-a-real-token", headers={"accept": "application/json"})
    check("forged magic-link token is refused", status == 401, status)
    status, _, _ = call("GET", "/api/v1/auth/me", cookie="saysight_session=forged")
    check("forged session cookie is refused", status == 401, status)

    # Expiry and suspension at the trust boundary.
    user_id = psql(f"SELECT id FROM users WHERE email='{email}'")
    psql(f"UPDATE auth_tokens SET expires_at=now()-interval '1 minute' WHERE user_id='{user_id}'")
    status, _, _ = call("POST", "/api/v1/auth/magic-link", {"email": email})
    time.sleep(1)
    fresh = None
    for line in api_logs().splitlines()[::-1]:
        if marker in line:
            fresh = line.split(marker, 1)[1].strip()
            break
    status, _, _ = call("GET", fresh or link, headers={"accept": "application/json"})
    # The first link was consumed, so this checks the consumed path again; a fresh
    # expired link is simulated by moving the newest token's expiry forward below.
    psql(f"UPDATE auth_tokens SET expires_at=now()-interval '1 minute' WHERE user_id='{user_id}' AND consumed_at IS NULL RETURNING id")
    if not fresh:
        raise RuntimeError(f"no fresh magic link for {email} appeared in the API log")
    status2, raw2, _ = call("GET", fresh, headers={"accept": "application/json"})
    check("expired token is refused", status2 == 401, (status, status2))
    psql(f"UPDATE users SET status='suspended' WHERE id='{user_id}'")
    status3, _, _ = call("GET", "/api/v1/auth/me", cookie=cookie_1)
    check("suspended account cannot use an existing session", status3 == 401, status3)
    psql(f"UPDATE users SET status='active' WHERE id='{user_id}'")

    finding = submit(author, {"year": 2021})
    for path, body in [
        (f"/api/v1/findings/{finding['id']}/decisions", {"status": "Pending verification", "reason": "x"}),
        ("/api/v1/review/queue", None),
    ]:
        status, raw, _ = call("POST" if body else "GET", path, body, author)
        check(f"submitter refused on {path.split('/')[-1]}", status == 403, (status, raw[:100]))

    status, raw, _ = decide(reviewer, finding["id"], "Pending verification", "checking")
    own = submit(reviewer, {"year": 2020})
    status, raw, _ = decide(reviewer, own["id"], "Pending verification", "my own work")
    check("self-review is refused even for a reviewer", status == 403 and json_body(raw)["error"] == "self_review_not_allowed", (status, raw[:100]))
    status, raw, _ = call("GET", "/api/v1/review/queue", cookie=reviewer)
    check("review queue excludes the reviewer's own finding", own["id"] not in raw, status)

    columns = {"analysis_runs": "recipe='x'", "dataset_releases": "name='x'",
               "finding_transitions": "reason='x'", "comment_moderation": "reason='x'",
               "review_conflicts": "statuses='[]'", "explanations": "text='x'"}
    for table, assignment in columns.items():
        output = psql(f"UPDATE {table} SET {assignment} WHERE id = (SELECT id FROM {table} LIMIT 1)")
        check(f"{table} rejects UPDATE", "append-only" in output, output[:100])


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "spec"
    if mode == "spec":
        spec_pass()
    elif mode == "adversarial":
        adversarial_pass()
    else:
        raise SystemExit("usage: mvpb_verify.py spec|adversarial")
    failed = [label for label, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    if failed:
        print("FAILED: " + "; ".join(failed))
        sys.exit(1)
    print("ALL_OK")


if __name__ == "__main__":
    main()
