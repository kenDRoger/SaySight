#!/usr/bin/env python3
"""MVP-D verification: spec acceptance and adversarial integrity."""
import json, sys, urllib.error, urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import mvpb_verify as base

base.results = []
check, call, psql, json_body = base.check, base.call, base.psql, base.json_body
BASE = base.BASE
REL = '11111111-2222-3333-4444-555555555555'


def join(payload=None):
    return call('POST', '/api/v1/join/analyze', payload if payload is not None else {})


def spec():
    status, raw, _ = join()
    body = json_body(raw)
    check('S1 curated join runs', status == 200, (status, raw[:150]))
    check('S1/S3 all fixture rows match with no conflicts',
          body.get('matched_rows') == 27 and body.get('unmatched_left') == 0 and
          body.get('unmatched_right') == 0 and body.get('duplicate_right_keys') == 0, body)
    check('S1/S4 reproducibility recorded', body.get('reproducibility_status') == 'Passed', body.get('reproducibility_status'))
    check('S4 joined evidence id returned', bool(body.get('evidence_id')), body.get('evidence_id'))
    status, raw, _ = call('GET', f"/api/v1/evidence/{body['evidence_id']}")
    evidence = json_body(raw)
    check('S4 evidence is a joined_summary run', status == 200 and evidence.get('recipe') == 'joined_summary', (status, evidence.get('recipe')))
    rel = psql(f"SELECT status FROM dataset_relationships WHERE id='{REL}'")
    keys = psql(f"SELECT join_keys FROM dataset_relationships WHERE id='{REL}'")
    check('S1/S3 relationship is validated with explicit keys',
          rel == 'validated' and 'fiscal_year' in keys, (rel, keys))
    check('S4 joined_evidence rejects UPDATE', 'append-only' in psql("UPDATE joined_evidence SET result='{}'"))
    count = psql('SELECT count(*) FROM joined_evidence')
    check('S4 evidence row persisted', int(count) >= 1, count)


def adversarial():
    status, raw, _ = join({'relationship_id': '00000000-0000-0000-0000-000000000000'})
    check('unknown relationship refused', status == 404 and json_body(raw)['error'] == 'relationship_not_found', (status, raw[:100]))
    psql(f"INSERT INTO dataset_relationships (id,name,primary_release_id,related_release_id,join_keys,status) "
         f"VALUES ('22222222-3333-4444-5555-666666666666','adv-draft','bettergov-gaa-coverage-2026-11-07',"
         f"'join-fixture-2026-11-07','[\"fiscal_year\"]'::jsonb,'draft') ON CONFLICT (id) DO NOTHING")
    status, raw, _ = join({'relationship_id': '22222222-3333-4444-5555-666666666666'})
    check('draft relationship refused', status == 409 and json_body(raw)['error'] == 'relationship_not_validated', (status, raw[:120]))
    psql("DELETE FROM dataset_relationships WHERE id='22222222-3333-4444-5555-666666666666'")

    first, second = join(), join()
    a = json_body(first[1]); b = json_body(second[1])
    fields = ['matched_rows', 'unmatched_left', 'unmatched_right', 'duplicate_right_keys']
    check('reruns produce identical diagnostics', all(a.get(k) == b.get(k) for k in fields), (a, b))

    req = urllib.request.Request(BASE + '/api/v1/join/analyze', data=b'{not json', headers={'content-type': 'application/json'}, method='POST')
    try:
        urllib.request.urlopen(req, timeout=10); status = 200
    except urllib.error.HTTPError as error:
        status = error.code
    check('invalid JSON refused', status == 400, status)

    check('joined_evidence rejects TRUNCATE', 'append-only' in psql('TRUNCATE joined_evidence'))
    check('synthetic fixture is labeled in catalog', 'synthetic' in call('GET', '/api/v1/datasets')[1].lower())


mode = sys.argv[1] if len(sys.argv) > 1 else 'spec'
(spec if mode == 'spec' else adversarial if mode == 'adversarial' else lambda: sys.exit('usage'))()
failed = [label for label, ok, _ in base.results if not ok]
print(f"\n{len(base.results) - len(failed)}/{len(base.results)} passed")
if failed:
    print('FAILED: ' + '; '.join(failed)); sys.exit(1)
print('ALL_OK')
