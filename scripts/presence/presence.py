#!/usr/bin/env python3
"""Desk presence from an HC-SR04 ultrasonic sensor on the Raspberry Pi.

Runs on the PI (the kiosk), not on the dashboard server: the sensor is wired
to the Pi's GPIO, and the server is another machine. It measures the distance
to whatever is in front of the sensor a couple of times a second, decides
"someone is at the desk" with some hysteresis so a lean-back doesn't read as
leaving, and reports every change (plus a heartbeat) to the dashboard's
POST /api/presence. The dashboard does the rest — dims the screen when you
have been away a while, tells the assistant whether you are there.

Wiring (HC-SR04, 5 V module — the ECHO pin MUST be divided down to 3.3 V):
    VCC  → 5 V        (header pin 2)
    GND  → GND        (header pin 6)
    TRIG → GPIO 23    (header pin 16)   3.3 V from the Pi is enough to trigger
    ECHO → 1 kΩ → GPIO 24 (header pin 18), with 2 kΩ from GPIO 24 to GND
           (5 V × 2k/(1k+2k) = 3.3 V — the Pi's inputs are NOT 5 V tolerant)

Config: /etc/touchsphere-presence.conf (written by install.sh), KEY=VALUE:
    SERVER_URL=https://lokloserver.taileefe4.ts.net   where the dashboard is
    TOKEN=…                                            PRESENCE_TOKEN from the server's .env, if set
    TRIG=23  ECHO=24                                   BCM numbers
    THRESHOLD_CM=90                                    nearer than this = at the desk
    INTERVAL_S=0.5                                     measurement period

Needs python3-gpiozero (which on a Pi 5 uses lgpio underneath) and
python3-requests; both are in Raspberry Pi OS Bookworm's repos.
"""
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

CONF = '/etc/touchsphere-presence.conf'


def read_conf():
    cfg = {'SERVER_URL': 'http://localhost:3001', 'TOKEN': '', 'TRIG': '23', 'ECHO': '24',
           'THRESHOLD_CM': '90', 'INTERVAL_S': '0.5', 'HEARTBEAT_S': '30'}
    try:
        with open(CONF) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    cfg[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return cfg


def post(url, token, body):
    req = urllib.request.Request(
        url.rstrip('/') + '/api/presence',
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', **({'X-Presence-Token': token} if token else {})},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=8) as r:
        return r.status


def main():
    cfg = read_conf()
    try:
        from gpiozero import DistanceSensor
    except ImportError:
        print('presence: python3-gpiozero is not installed (sudo apt install python3-gpiozero python3-lgpio)', file=sys.stderr)
        sys.exit(78)

    trig, echo = int(cfg['TRIG']), int(cfg['ECHO'])
    threshold = float(cfg['THRESHOLD_CM'])
    interval = float(cfg['INTERVAL_S'])
    heartbeat = float(cfg['HEARTBEAT_S'])
    # max_distance bounds the echo wait; 2 m is plenty for a desk and keeps a
    # missed echo from stalling a reading for a whole second.
    sensor = DistanceSensor(echo=echo, trigger=trig, max_distance=2.0, queue_len=1)
    print(f'presence: HC-SR04 on TRIG={trig} ECHO={echo}, at-desk under {threshold:.0f} cm, reporting to {cfg["SERVER_URL"]}')

    window = []          # last few readings, in cm
    present = None       # None until the first decision
    near_streak = far_streak = 0
    last_sent = 0.0
    NEAR_NEEDED = 3      # ~1.5 s of "near" to arrive
    FAR_NEEDED = 40      # ~20 s of "far" to leave — a lean-back is not leaving

    while True:
        try:
            d = sensor.distance * 100.0        # metres → cm; == max_distance when nothing echoes
        except Exception as e:                 # a bad pulse; skip it
            print(f'presence: read failed: {e}', file=sys.stderr)
            time.sleep(interval)
            continue
        window.append(d)
        if len(window) > 5:
            window.pop(0)
        med = statistics.median(window)
        near = med < threshold
        near_streak = near_streak + 1 if near else 0
        far_streak = far_streak + 1 if not near else 0

        new = present
        if present is not True and near_streak >= NEAR_NEEDED:
            new = True
        elif present is not False and far_streak >= FAR_NEEDED:
            new = False
        if present is None and new is None and len(window) >= 3:
            new = near                          # first decision, quickly

        now = time.time()
        if new is not None and (new != present or now - last_sent >= heartbeat):
            body = {'present': bool(new), 'distanceCm': round(med, 1), 'thresholdCm': threshold}
            try:
                post(cfg['SERVER_URL'], cfg['TOKEN'], body)
                if new != present:
                    print(f'presence: {"at the desk" if new else "away"} ({med:.0f} cm)')
                last_sent = now
                present = new
            except (urllib.error.URLError, OSError) as e:
                print(f'presence: could not reach the dashboard: {e}', file=sys.stderr)
                last_sent = now - heartbeat + 5   # retry in a few seconds, not a full heartbeat
        time.sleep(interval)


if __name__ == '__main__':
    main()
