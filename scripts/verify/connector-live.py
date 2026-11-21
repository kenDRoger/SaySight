#!/usr/bin/env python3
"""Live connector probe for MVP-E (S8, S11).

Opt-in and NOT part of `npm test`: this script needs network access and talks to
the four real portal APIs. It reads each portal's documented endpoint and prints
`<connector> <http status> <dataset count or error>`. It exits non-zero if any API
portal fails, so a maintainer can tell a real outage from a test fixture.

Usage: python3 scripts/verify/connector-live.py
"""
import json
import sys
import urllib.error
import urllib.request

TIMEOUT_SECONDS = 20
USER_AGENT = 'saysight-connector-probe/1.0'


def get(url):
    request = urllib.request.Request(url, headers={'user-agent': USER_AGENT, 'accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return response.status, json.loads(response.read().decode('utf-8'))


def count_bettergov(payload):
    return len(payload['data'])


def count_hdx(payload):
    return len(payload['result']['results'])


def count_worldbank(payload):
    # World Bank answers [metadata, rows]; one indicator is one dataset.
    return len({row['indicator']['id'] for row in payload[1] if row.get('indicator')})


def count_openstat(payload):
    return len(payload)


PORTALS = [
    ('bettergov', 'https://data.bettergov.ph/api/v1/datasets', count_bettergov),
    ('hdx', 'https://data.humdata.org/api/3/action/package_search?fq=groups:phl&rows=1000', count_hdx),
    ('worldbank', 'https://api.worldbank.org/v2/country/PHL/indicator/SP.POP.TOTL?format=json&per_page=1000', count_worldbank),
    ('openstat', 'https://openstat.psa.gov.ph/PXWeb/api/v1/en', count_openstat),
]


def main():
    failures = 0
    for connector, url, count in PORTALS:
        try:
            status, payload = get(url)
            print(f'{connector} {status} {count(payload)}')
        except urllib.error.HTTPError as error:
            failures += 1
            print(f'{connector} {error.code} error: {error.reason}')
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            failures += 1
            print(f'{connector} - error: {error}')
        except (ValueError, KeyError, TypeError, IndexError) as error:
            failures += 1
            print(f'{connector} 200 error: unexpected payload ({error})')
    # Link-out sources are never fetched; the probe does not pretend to read them.
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
