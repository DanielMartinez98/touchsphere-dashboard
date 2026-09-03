#!/usr/bin/env python3
"""Copy the media stack's API keys into touchsphere's .env — without printing any.

Run ON THE BOX that hosts Plex / Sonarr / Radarr / Bazarr / Seerr / qBittorrent:

    python3 scripts/collect-media-env.py [path/to/touchsphere/.env]

It reads each service's own config on disk, appends the MEDIA_* lines to the env
file (skipping any key already present, so re-running is safe), and reports only
WHICH keys were found — never their values. qBittorrent stores its password only
hashed, so that one is taken from Sonarr's download-client settings over
Sonarr's API instead, which is where it is kept in the clear.

The paths below are the layout on lokloserver; override any of them with the
environment variables named beside each, or edit the defaults.
"""
import json, os, re, sys, urllib.request

ENV = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('TOUCHSPHERE_ENV', '/home/loklo/touchsphere-dashboard/.env')
# The docker host, as the touchsphere CONTAINER sees it (docker's default
# bridge gateway). Plex runs on the host network; the rest publish ports.
GW = os.environ.get('MEDIA_GATEWAY', 'http://172.18.0.1')

PLEX_PREFS  = os.environ.get('PLEX_PREFS',  '/home/loklo/plex/Library/Application Support/Plex Media Server/Preferences.xml')
SONARR_CFG  = os.environ.get('SONARR_CFG',  '/mnt/Plex/Docker/Sonarr/data/config.xml')
RADARR_CFG  = os.environ.get('RADARR_CFG',  '/mnt/Plex/Docker/Radarr/data/config.xml')
BAZARR_DIR  = os.environ.get('BAZARR_DIR',  '/mnt/Plex/Docker/Bazarr/config/config')
SEERR_CFG   = os.environ.get('SEERR_CFG',   '/mnt/Plex/Docker/Overseerr/config/settings.json')
SONARR_HOST = os.environ.get('SONARR_HOST', 'http://127.0.0.1:8989')

found = {}

def grab(name, fn):
    try:
        v = fn()
        if v:
            found[name] = v
            print(f'  {name}: found ({len(v)} chars)')
        else:
            print(f'  {name}: NOT FOUND')
    except Exception as e:
        print(f'  {name}: error {type(e).__name__}: {e}')

def xml_tag(path, tag):
    m = re.search(rf'<{tag}>([^<]+)</{tag}>', open(path, encoding='utf-8').read())
    return m.group(1).strip() if m else ''

def plex_token():
    m = re.search(r'PlexOnlineToken="([^"]+)"', open(PLEX_PREFS, encoding='utf-8').read())
    return m.group(1) if m else ''

def bazarr_key():
    p = os.path.join(BAZARR_DIR, 'config.yaml')
    if os.path.exists(p):
        m = re.search(r'apikey:\s*["\']?([A-Za-z0-9]+)', open(p, encoding='utf-8').read())
        if m: return m.group(1)
    p = os.path.join(BAZARR_DIR, 'config.ini')
    if os.path.exists(p):
        m = re.search(r'apikey\s*=\s*([A-Za-z0-9]+)', open(p, encoding='utf-8').read())
        if m: return m.group(1)
    return ''

def seerr_key():
    d = json.load(open(SEERR_CFG, encoding='utf-8'))
    return (d.get('main') or {}).get('apiKey', '')

print('Reading service configs…')
grab('MEDIA_PLEX_TOKEN', plex_token)
grab('MEDIA_SONARR_KEY', lambda: xml_tag(SONARR_CFG, 'ApiKey'))
grab('MEDIA_RADARR_KEY', lambda: xml_tag(RADARR_CFG, 'ApiKey'))
grab('MEDIA_BAZARR_KEY', bazarr_key)
grab('MEDIA_SEERR_KEY',  seerr_key)

def qbit_creds():
    key = found.get('MEDIA_SONARR_KEY')
    if not key: return None
    req = urllib.request.Request(f'{SONARR_HOST}/api/v3/downloadclient', headers={'X-Api-Key': key})
    clients = json.load(urllib.request.urlopen(req, timeout=10))
    for c in clients:
        if (c.get('implementation') or '').lower() != 'qbittorrent': continue
        f = {x['name']: x.get('value') for x in c.get('fields', [])}
        return f.get('username') or '', f.get('password') or ''
    return None

creds = None
try:
    creds = qbit_creds()
except Exception as e:
    print(f'  qBittorrent via Sonarr: error {type(e).__name__}: {e}')
if creds:
    found['MEDIA_QBIT_USER'], found['MEDIA_QBIT_PASS'] = creds
    print(f'  MEDIA_QBIT_USER: found ({creds[0]!r} — the username is not secret)')
    print(f'  MEDIA_QBIT_PASS: {"found" if creds[1] else "EMPTY"}')
else:
    print('  qBittorrent: no qBittorrent download client in Sonarr')

# Non-secret URLs, the way the touchsphere container reaches each service.
urls = {
    'MEDIA_PLEX_URL':   f'{GW}:32400',
    'MEDIA_SONARR_URL': f'{GW}:8989',
    'MEDIA_RADARR_URL': f'{GW}:7878',
    'MEDIA_BAZARR_URL': f'{GW}:6767',
    'MEDIA_SEERR_URL':  f'{GW}:5055',
    'MEDIA_QBIT_URL':   f'{GW}:8080',
}

existing = open(ENV, encoding='utf-8').read() if os.path.exists(ENV) else ''
present = set(re.findall(r'^([A-Z_]+)=', existing, re.M))
lines = []
for k, v in {**urls, **found}.items():
    if k in present:
        print(f'  {k}: already in .env, left alone')
        continue
    lines.append(f'{k}={v}')
if lines:
    with open(ENV, 'a', encoding='utf-8') as fh:
        if existing and not existing.endswith('\n'): fh.write('\n')
        fh.write('\n# Media stack (Plex / *arr / qBittorrent) — written by scripts/collect-media-env.py\n')
        fh.write('\n'.join(lines) + '\n')
    print(f'appended {len(lines)} line(s) to {ENV} — restart the app container to pick them up')
else:
    print('nothing to append')
