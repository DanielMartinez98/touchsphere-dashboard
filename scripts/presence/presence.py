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
    VCC     4           5 V. The module will not fire reliably on 3.3 V.
                        (Pin 2 is the other 5 V pin; the official 7" screen's
                        power lead takes pins 2 and 6, so use 4 and 9.)
    GND     9           ground
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

Commands (the service runs with no arguments):

    touchsphere-presence test [seconds]   live readings + a verdict on the wiring,
                                          then what the dashboard believes. Stops
                                          the service for the duration and starts
                                          it again after.
    touchsphere-presence log              the last lines of the reader's own log
    touchsphere-presence status           service, log tail and the dashboard's view

The reader keeps its own log at ~/.local/state/touchsphere-presence/presence.log
(the user journal on Raspberry Pi OS is often unreadable or volatile), with one
line per heartbeat, so "is it alive" is answered by the last line's timestamp.

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
        # The answer carries whether the dashboard wants LIVE readings — it
        # cannot reach the Pi, so this is the one channel it has to ask.
        try:
            return json.loads(r.read().decode() or '{}')
        except ValueError:
            return {}


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


LOG_DIR = os.path.expanduser('~/.local/state/touchsphere-presence')
LOG_PATH = os.path.join(LOG_DIR, 'presence.log')
LOG_MAX = 256 * 1024


def log(msg, err=False):
    """stdout (the journal, when it works) AND our own file, with a timestamp."""
    line = f'{time.strftime("%Y-%m-%d %H:%M:%S")} presence: {msg}'
    print(line, file=sys.stderr if err else sys.stdout, flush=True)
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        try:
            if os.path.getsize(LOG_PATH) > LOG_MAX:
                os.replace(LOG_PATH, LOG_PATH + '.1')
        except OSError:
            pass
        with open(LOG_PATH, 'a') as f:
            f.write(line + '\n')
    except OSError:
        pass


def claim(lgpio, cfg):
    chip = int(cfg['CHIP'])
    trig, echo = int(cfg['TRIG']), int(cfg['ECHO'])
    h = lgpio.gpiochip_open(chip)
    lgpio.gpio_claim_output(h, trig, 0)
    lgpio.gpio_claim_input(h, echo)
    return h, trig, echo


def server_view(cfg):
    """What the dashboard believes right now, or an error string."""
    try:
        req = urllib.request.Request(cfg['SERVER_URL'].rstrip('/') + '/api/presence')
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001
        return {'error': str(e)}


def describe_server(view):
    if 'error' in view:
        return f'dashboard NOT reachable: {view["error"]}'
    if not view.get('sensor'):
        return 'dashboard reachable, but it has never received a report (is the service running? right SERVER_URL?)'
    age = ''
    try:
        from datetime import datetime, timezone
        t = datetime.fromisoformat(view['updatedAt'].replace('Z', '+00:00'))
        age = f'{(datetime.now(timezone.utc) - t).total_seconds():.0f} s ago'
    except Exception:  # noqa: BLE001
        age = 'unknown age'
    who = 'at the desk' if view.get('present') else 'away'
    stale = ' — STALE, the reader has gone quiet' if view.get('stale') else ''
    return f'dashboard says: {who}, {view.get("distanceCm")} cm, last report {age}{stale}'


def cmd_test(cfg, seconds):
    try:
        import lgpio
    except ImportError:
        print('python3-lgpio is missing (sudo apt install python3-lgpio)', file=sys.stderr)
        return 78
    import subprocess
    trig, echo = int(cfg['TRIG']), int(cfg['ECHO'])
    max_cm = float(cfg['MAX_CM'])
    threshold = float(cfg['THRESHOLD_CM'])
    timeout_s = (max_cm * 2 / 34300) * 1.5 + 0.005
    print(f'config: TRIG=GPIO{trig} (pin 16)  ECHO=GPIO{echo} (pin 18)  threshold {threshold:.0f} cm  '
          f'max {max_cm:.0f} cm  server {cfg["SERVER_URL"]}')

    # The service holds the pins; borrow them for the test and give them back.
    was_active = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'touchsphere-presence']).returncode == 0
    if was_active:
        print('stopping the touchsphere-presence service for the test (it is started again after)…')
        subprocess.run(['systemctl', '--user', 'stop', 'touchsphere-presence'])
        time.sleep(0.5)
    h = None
    try:
        try:
            h, trig, echo = claim(lgpio, cfg)
        except Exception as e:  # noqa: BLE001
            print(f'could not claim GPIO {trig}/{echo}: {e}')
            print('→ is the user in the "gpio" group? is another program using those pins?')
            return 77
        print(f'reading for {seconds:.0f} s — wave a hand in front of the sensor:')
        readings, none_count = [], 0
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            d = measure(lgpio, h, trig, echo, max_cm, timeout_s)
            if d is None:
                none_count += 1
                print('  no echo')
            else:
                readings.append(d)
                bar = '#' * max(1, min(60, int(d / max_cm * 60)))
                print(f'  {d:6.1f} cm  {bar}{"  <- at the desk" if d < threshold else ""}')
            time.sleep(0.25)
    finally:
        if h is not None:
            try:
                lgpio.gpiochip_close(h)
            except Exception:  # noqa: BLE001
                pass
        if was_active:
            subprocess.run(['systemctl', '--user', 'start', 'touchsphere-presence'])
            print('service started again.')

    total = len(readings) + none_count
    print()
    if total and not readings:
        print('VERDICT: NO ECHO — the sensor never answered.')
        print('  Check: VCC on pin 4 (5 V), GND on pin 9, TRIG on pin 16, ECHO on pin 18 through the divider.')
        print('  TRIG and ECHO swapped looks exactly like this. So does a module fed 3.3 V instead of 5 V.')
        return 1
    if readings and min(readings) > max_cm * 0.9:
        print(f'VERDICT: the sensor answers but sees nothing nearer than {max_cm:.0f} cm.')
        print('  Is it pointing at where you sit? Anything within about 2 m should show up.')
        return 1
    if readings:
        med = statistics.median(readings)
        lo, hi = min(readings), max(readings)
        miss = f', {none_count} of {total} readings had no echo' if none_count else ''
        print(f'VERDICT: WORKING — median {med:.0f} cm (range {lo:.0f}–{hi:.0f}){miss}.')
        print(f'  With the threshold at {threshold:.0f} cm you count as {"AT THE DESK" if med < threshold else "AWAY"} right now.')
        if none_count > total / 4:
            print('  Many missed echoes: a soft or angled surface, or a loose ECHO wire.')
    print(describe_server(server_view(cfg)))
    return 0


def cmd_log(n=40):
    try:
        with open(LOG_PATH) as f:
            lines = f.readlines()
    except OSError:
        print(f'no log yet at {LOG_PATH} — has the service ever run?')
        return 1
    sys.stdout.write(''.join(lines[-n:]))
    return 0


def cmd_status(cfg):
    import subprocess
    r = subprocess.run(['systemctl', '--user', 'is-active', 'touchsphere-presence'], capture_output=True, text=True)
    print(f'service: {r.stdout.strip() or r.stderr.strip()}')
    print(f'log ({LOG_PATH}):')
    cmd_log(8)
    print(describe_server(server_view(cfg)))
    return 0


def main():
    cfg = read_conf()
    try:
        import lgpio
    except ImportError:
        log('python3-lgpio is missing (sudo apt install python3-lgpio)', err=True)
        sys.exit(78)

    chip = int(cfg['CHIP'])
    threshold = float(cfg['THRESHOLD_CM'])
    interval = float(cfg['INTERVAL_S'])
    heartbeat = float(cfg['HEARTBEAT_S'])
    max_cm = float(cfg['MAX_CM'])
    timeout_s = (max_cm * 2 / 34300) * 1.5 + 0.005

    try:
        h, trig, echo = claim(lgpio, cfg)
    except Exception as e:  # noqa: BLE001
        log(f'could not claim GPIO {cfg["TRIG"]}/{cfg["ECHO"]} on chip {chip}: {e}', err=True)
        log('is the user in the "gpio" group, and are those pins free? (touchsphere-presence test)', err=True)
        sys.exit(77)

    log(f'HC-SR04 on TRIG=GPIO{trig} ECHO=GPIO{echo} (chip {chip}); '
        f'at the desk under {threshold:.0f} cm; reporting to {cfg["SERVER_URL"]}')

    window = []
    present = None
    near_streak = far_streak = 0
    last_sent = 0.0
    never_echoed = 0
    accepted_once = False
    # Live mode: the dashboard's sensor card is open and wants every reading,
    # not one every 30 s. Asked for in each POST's answer, and dropped again
    # the moment an answer stops asking, so a closed card costs nothing.
    live = False
    # Since the last report: for the heartbeat line and the dashboard's card.
    period = {'readings': 0, 'noEcho': 0, 'min': None, 'max': None}
    NEAR_NEEDED = 3      # ~1.5 s of "near" to count as arriving
    FAR_NEEDED = 40      # ~20 s of "far" to count as leaving

    try:
        while True:
            d = measure(lgpio, h, trig, echo, max_cm, timeout_s)
            period['readings'] += 1
            if d is None:
                never_echoed += 1
                period['noEcho'] += 1
                d = max_cm            # out of range reads as "nobody there"
            else:
                never_echoed = 0
                period['min'] = d if period['min'] is None else min(period['min'], d)
                period['max'] = d if period['max'] is None else max(period['max'], d)
            # A sensor that has NEVER answered is almost certainly not wired
            # yet. Say so once a minute rather than reporting a confident
            # "away" that happens to be right for the wrong reason.
            if never_echoed and never_echoed % 120 == 0:
                log(f'no echo for {never_echoed} readings — check the wiring '
                    f'(TRIG=GPIO{trig} pin 16, ECHO=GPIO{echo} pin 18 through a divider); '
                    f'run: touchsphere-presence test', err=True)

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
            due = new != present or now - last_sent >= heartbeat
            # In live mode every reading goes up — the raw one, not the median,
            # because what the person at the screen wants to see is the number
            # moving as their hand does.
            if new is not None and (due or live):
                stats = {
                    'readings': period['readings'],
                    'noEcho': period['noEcho'],
                    'minCm': round(period['min'], 1) if period['min'] is not None else None,
                    'maxCm': round(period['max'], 1) if period['max'] is not None else None,
                }
                body = {'present': bool(new), 'distanceCm': round(d if live and not due else med, 1),
                        'thresholdCm': threshold, 'live': live,
                        **({'stats': stats} if due else {})}
                try:
                    answer = post(cfg['SERVER_URL'], cfg['TOKEN'], body)
                    want_live = bool(answer.get('live')) if isinstance(answer, dict) else False
                    if want_live != live:
                        log('live readings ' + ('on — the dashboard\'s sensor card is open' if want_live else 'off'))
                        live = want_live
                    if not accepted_once:
                        accepted_once = True
                        log(f'first report accepted by {cfg["SERVER_URL"]}')
                    if new != present:
                        log(f'{"at the desk" if new else "away"} ({med:.0f} cm)')
                    elif due:
                        rng = (f'{stats["minCm"]:.0f}–{stats["maxCm"]:.0f} cm' if stats['minCm'] is not None else 'no echo')
                        log(f'heartbeat: {"at the desk" if new else "away"}, {med:.0f} cm, {stats["readings"]} readings '
                            f'({rng}), {stats["noEcho"]} without echo')
                    if due:
                        last_sent = now
                        period = {'readings': 0, 'noEcho': 0, 'min': None, 'max': None}
                    present = new
                except (urllib.error.URLError, OSError) as e:
                    log(f'could not reach the dashboard: {e}', err=True)
                    # Retry in a few seconds rather than a whole heartbeat.
                    last_sent = now - heartbeat + 5
            time.sleep(interval)
    finally:
        try:
            lgpio.gpiochip_close(h)
        except Exception:  # noqa: BLE001
            pass


if __name__ == '__main__':
    args = sys.argv[1:]
    if args and args[0] == 'test':
        secs = float(args[1]) if len(args) > 1 else 8.0
        sys.exit(cmd_test(read_conf(), secs))
    elif args and args[0] == 'log':
        sys.exit(cmd_log(int(args[1]) if len(args) > 1 else 40))
    elif args and args[0] == 'status':
        sys.exit(cmd_status(read_conf()))
    elif args:
        print('usage: touchsphere-presence [test [seconds] | log [lines] | status]', file=sys.stderr)
        sys.exit(64)
    main()
