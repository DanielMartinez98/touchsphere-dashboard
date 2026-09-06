#!/usr/bin/env python3
"""Desk presence from an HC-SR04 ultrasonic sensor on the Raspberry Pi.

Runs on the PI (the kiosk), not on the dashboard server: the sensor is wired
to the Pi's GPIO and the server is another machine. It measures the distance
to whatever is in front of the sensor a couple of times a second, decides
"someone is at the desk" with enough hysteresis that leaning back is not
leaving, and reports every change (plus a heartbeat) to the dashboard's
POST /api/presence. The dashboard does the rest: dims the screen after a
while away, and tells the assistant whether you are there.

WIRING (HC-SR04, a 5 V module — the ECHO pin MUST be divided down to 3.3 V):

    sensor  header pin  what
    ------  ----------  ------------------------------------------------
    VCC     2           5 V. The module will not fire reliably on 3.3 V.
    GND     6           ground
    TRIG    16          GPIO 23. The Pi's 3.3 V is enough to trigger it.
    ECHO    18          GPIO 24, THROUGH A DIVIDER — see below.

    ECHO outputs 5 V and the Pi's inputs are NOT 5 V tolerant, so:

        ECHO ──[ 1 kΩ ]──┬── GPIO 24 (pin 18)
                         │
                      [ 2 kΩ ]
                         │
                        GND (pin 20)

    Any 1:2 ratio works (330 Ω / 680 Ω, 10 kΩ / 20 kΩ). Wiring ECHO straight
    to the Pi can damage it.

Talks to the GPIO through lgpio, which Raspberry Pi OS ships and which is the
Pi 5's native interface. gpiozero would be the obvious choice and its
DistanceSensor does exactly this, but it is not installed here and installing
it needs root — and the measurement is twenty lines. Reading the pin from
Python gives tens of microseconds of jitter, which is millimetres: irrelevant
against a threshold most of a metre away.

Config, first of these that exists:
    ~/.config/touchsphere-presence.conf
    /etc/touchsphere-presence.conf
"""
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

CONF_PATHS = [
    os.path.expanduser('~/.config/touchsphere-presence.conf'),
    '/etc/touchsphere-presence.conf',
]

DEFAULTS = {
    'SERVER_URL': 'http://localhost:3001',
    'TOKEN': '',
    'CHIP': '0',            # Pi 5: gpiochip0 (gpiochip4 is a symlink to it)
    'TRIG': '23',
    'ECHO': '24',
    'THRESHOLD_CM': '90',
    'INTERVAL_S': '0.5',
    'HEARTBEAT_S': '30',
    'MAX_CM': '250',        # beyond this, treat as "nothing there"
}


def read_conf():
    cfg = dict(DEFAULTS)
    for p in CONF_PATHS:
        try:
            with open(p) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        k, v = line.split('=', 1)
                        cfg[k.strip()] = v.strip().strip('"').strip("'")
            break
        except OSError:
            continue
    return cfg


def post(url, token, body):
    req = urllib.request.Request(
        url.rstrip('/') + '/api/presence',
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json',
                 **({'X-Presence-Token': token} if token else {})},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=8) as r:
        return r.status


def measure(lg, h, trig, echo, max_cm, timeout_s):
    """One round trip, in cm. None when no echo came back in time.

    None is not an error: it is what an HC-SR04 reports when the nearest
    surface is beyond its range, and also when nothing is wired up yet. Both
    mean the same thing to the caller — nobody is close — so the caller
    treats it as max range rather than as a failure to be logged.
    """
    lg.gpio_write(h, trig, 0)
    time.sleep(0.000_002)
    lg.gpio_write(h, trig, 1)
    time.sleep(0.000_010)          # the datasheet's 10 µs trigger pulse
    lg.gpio_write(h, trig, 0)

    deadline = time.monotonic() + timeout_s
    while lg.gpio_read(h, echo) == 0:
        if time.monotonic() > deadline:
            return None            # the module never answered
    start = time.monotonic()
    while lg.gpio_read(h, echo) == 1:
        if time.monotonic() > deadline:
            return None            # echo stuck high: nothing in range
    # 343 m/s, and the sound made the trip twice.
    cm = (time.monotonic() - start) * 34300 / 2
    return cm if 1 < cm <= max_cm else None


def main():
    cfg = read_conf()
    try:
        import lgpio
    except ImportError:
        print('presence: python3-lgpio is missing (sudo apt install python3-lgpio)', file=sys.stderr)
        sys.exit(78)

    chip = int(cfg['CHIP'])
    trig, echo = int(cfg['TRIG']), int(cfg['ECHO'])
    threshold = float(cfg['THRESHOLD_CM'])
    interval = float(cfg['INTERVAL_S'])
    heartbeat = float(cfg['HEARTBEAT_S'])
    max_cm = float(cfg['MAX_CM'])
    timeout_s = (max_cm * 2 / 34300) * 1.5 + 0.005

    try:
        h = lgpio.gpiochip_open(chip)
        lgpio.gpio_claim_output(h, trig, 0)
        lgpio.gpio_claim_input(h, echo)
    except Exception as e:
        print(f'presence: could not claim GPIO {trig}/{echo} on chip {chip}: {e}', file=sys.stderr)
        print('presence: is the user in the "gpio" group, and are those pins free?', file=sys.stderr)
        sys.exit(77)

    print(f'presence: HC-SR04 on TRIG=GPIO{trig} ECHO=GPIO{echo} (chip {chip}); '
          f'at the desk under {threshold:.0f} cm; reporting to {cfg["SERVER_URL"]}', flush=True)

    window = []
    present = None
    near_streak = far_streak = 0
    last_sent = 0.0
    never_echoed = 0
    NEAR_NEEDED = 3      # ~1.5 s of "near" to count as arriving
    FAR_NEEDED = 40      # ~20 s of "far" to count as leaving

    try:
        while True:
            d = measure(lgpio, h, trig, echo, max_cm, timeout_s)
            if d is None:
                never_echoed += 1
                d = max_cm            # out of range reads as "nobody there"
            else:
                never_echoed = 0
            # A sensor that has NEVER answered is almost certainly not wired
            # yet. Say so once a minute rather than reporting a confident
            # "away" that happens to be right for the wrong reason.
            if never_echoed and never_echoed % 120 == 0:
                print(f'presence: no echo for {never_echoed} readings — check the wiring '
                      f'(TRIG=GPIO{trig}, ECHO=GPIO{echo} through a divider)', file=sys.stderr, flush=True)

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
                new = near

            now = time.time()
            if new is not None and (new != present or now - last_sent >= heartbeat):
                body = {'present': bool(new), 'distanceCm': round(med, 1), 'thresholdCm': threshold}
                try:
                    post(cfg['SERVER_URL'], cfg['TOKEN'], body)
                    if new != present:
                        print(f'presence: {"at the desk" if new else "away"} ({med:.0f} cm)', flush=True)
                    last_sent = now
                    present = new
                except (urllib.error.URLError, OSError) as e:
                    print(f'presence: could not reach the dashboard: {e}', file=sys.stderr, flush=True)
                    # Retry in a few seconds rather than a whole heartbeat.
                    last_sent = now - heartbeat + 5
            time.sleep(interval)
    finally:
        try:
            lgpio.gpiochip_close(h)
        except Exception:
            pass


if __name__ == '__main__':
    main()
