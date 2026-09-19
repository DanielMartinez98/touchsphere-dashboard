# A GPU box with an on/off switch

How TouchSphere's GPU boxes run its GPU services, and how the dashboard switches
them on and off from Settings → AI box. There are two, both Windows 11 with an
RTX 4090, and they are laid out differently; the same agent (`agent.js`) serves
both, told what differs by `agent.json` beside it.

- **lokloComputer** — the Ollama Windows app, and the containers inside a WSL
  distro of their own (`touchsphere-ai`) that runs nothing else. Everything in
  `E:\ai`. Had the switch first.
- **loklo-pc** — the original GPU box: the containers in its own Ubuntu distro
  from the repo checkout there, the way lokloComputer's distro was set up to
  copy. Its switch arrived 2026-09-19; until then the agent knew only
  lokloComputer's layout.

## What the switch does

- **On** starts Ollama and brings the containers up — Kokoro, Whisper, RVC and
  ComfyUI — and reports each service as it answers.
- **Off** unloads every Ollama model (so the VRAM comes back even if stopping
  it misbehaves), stops Ollama, and stops the containers. Every process holding
  VRAM for the AI is gone, so the memory goes back to whatever else the PC is
  doing (a game). The dashboard treats a switched-off box as down at once.
- The agent remembers the last choice in `state.json` and restores it at
  sign-in, so a PC comes back from a reboot the way it was left.

The agent's API: `GET /status`, `POST /power {"on": true|false}`, both with
`Authorization: Bearer <token.txt>`. It listens on 127.0.0.1:8190 and
`tailscale serve --bg --tcp=8190 tcp://127.0.0.1:8190` puts it on the tailnet
(tailnet-only, no firewall rule needed); or set `"bind"` in `agent.json` to the
box's tailnet IP and skip that.

**One token for every box.** The dashboard has a single `AI_BOX_AGENT_TOKEN`,
so every agent's `token.txt` must hold the same string — the installer takes
the other box's with `-Token`.

## agent.json

Optional; every key has a default, and lokloComputer's install has no file at
all. The installer writes it from its switches.

```json
{
  "port": 8190,
  "bind": "127.0.0.1",
  "containers": "wsl",
  "distro": "touchsphere-ai",
  "ollama": "app",
  "compose": { "dir": "/srv/touchsphere", "file": "docker-compose.voice.yml", "profile": "gpu" },
  "services": { "comfyui": 8188 },
  "modelsScript": "../scripts/comfy-models.sh",
  "modelsLog": "../scripts/comfy-models.log"
}
```

- **`containers`** — the setting that matters, how the GPU containers run:
  - `wsl` (the Windows default; lokloComputer): the containers live in a WSL
    distro of their own. On holds the distro open — WSL shuts a distro down
    once nothing is attached to it, containers and all — and its systemd
    brings dockerd and the containers back; off **terminates the distro**.
    Only for a distro that runs nothing else.
  - `wsl-compose` (loklo-pc): the containers live in a distro that also does
    other things. On holds the distro open and runs `docker compose up -d`
    inside it; off runs `docker compose stop` inside it and lets go of the
    distro. It is never terminated — it is somebody's Ubuntu, not ours.
  - `compose` (the Linux default): `docker compose up -d` / `stop` straight on
    this host — a Linux box, or Windows with Docker Desktop.
- `distro` — the WSL distro (`wsl -l -v` lists them), for the two `wsl` modes.
- `ollama` — how Ollama runs here: `app` (the Windows app; the default on
  Windows), `systemd` (the `ollama` service — on Windows, inside the distro;
  the default on Linux), `compose` (one of the containers, so it comes and
  goes with them), or `none` (this box does not run Ollama, so it is neither
  started nor waited for).
- `compose` — what `docker compose` is run on, for `wsl-compose` and `compose`.
  `dir` is a path inside the distro for `wsl-compose`, on the host otherwise;
  it defaults to the checkout this file is in.
- `services` — the ports "on" waits for, merged over the defaults (`ollama`
  11434, `kokoro` 8880, `whisper` 8000, `rvc` 5050, `comfyui` 8188). A `null`
  removes one: a box that does not run RVC should not wait for it.
- `modelsScript` / `modelsLog` — the ComfyUI download and its log, for the
  progress line on the card. Found on their own beside the agent (in
  `../scripts` as on lokloComputer, or in this folder); a box whose models are
  already there has no log and shows no progress line.

## loklo-pc (Windows, a shared Ubuntu distro)

Three things to know first, in PowerShell:

```powershell
wsl -l -v                              # the distro's name (the one with Docker in it)
wsl -d <distro> -- docker compose ls    # where the checkout is (its config file path)
Get-Process ollama*                     # the Windows app running? else it is inside the distro
```

Then, from a checkout of this repo on Windows (`git clone` it anywhere, say
`C:\ai\touchsphere-dashboard`; the box's own checkout is inside the distro and
PowerShell cannot run from there):

1. ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\gpu-box\install-agent.ps1 `
     -Dir C:\ai\agent -Distro Ubuntu -Containers wsl-compose -ComposeDir /srv/touchsphere `
     -Token <lokloComputer's token.txt>
   ```
   with the distro name, the checkout's directory inside it and, if Ollama is
   not the Windows app, `-Ollama systemd` (a service inside the distro),
   `compose` (one of the containers) or `none`. It copies the agent, writes
   `agent.json` and `token.txt`, puts a "TouchSphere AI agent" shortcut in the
   Startup folder, starts the agent and prints its status.
2. `tailscale serve --bg --tcp=8190 tcp://127.0.0.1:8190` (once).
3. On lokloserver, in `.env`:
   ```
   AI_BOXES=loklo-pc=100.98.235.63, lokloComputer=100.112.40.40
   AI_BOX_AGENTS=loklo-pc=http://100.98.235.63:8190, lokloComputer=http://100.112.40.40:8190
   AI_BOX_AGENT_TOKEN=<the token>
   ```
   then `docker compose up -d app`. The card gains its On/Off row on the next
   open of Settings → AI box.

`C:\ai\agent\agent.log` says what the agent did; `supervisor.log` why it ever
exited. The start-up line names the mode it read from `agent.json`.

## lokloComputer (Windows, a distro of its own)

Paths assume the box keeps everything in `E:\ai`.

```
E:\ai\agent\        agent.js, start-agent.vbs, token.txt, state.json, agent.log
E:\ai\scripts\      comfy-models.sh (+ .log), wsl-setup.sh, install-downloads-unit.sh
E:\ai\wsl\          ext4.vhdx of the touchsphere-ai WSL distro
E:\ai\ollama\models the Ollama app's model folder
```

### What runs where

- **Ollama** is the ordinary Windows app, with its model folder set to
  `E:\ai\ollama\models` and "Expose Ollama to the network" on (port 11434).
- **Kokoro, Whisper, RVC and ComfyUI** are `docker-compose.voice.yml --profile gpu`
  inside a dedicated WSL distro, `touchsphere-ai`, whose disk lives in `E:\ai\wsl`.
  The checkout, the RVC voices and the ComfyUI weights are on that distro's own
  ext4 disk (`/srv/touchsphere`), because ComfyUI mmaps multi-GB safetensors and
  over `/mnt/e` that is many times slower.
- **The agent** (`agent.js`, Node, no dependencies) listens on 127.0.0.1:8190 and
  is what the dashboard's Settings → AI box switch talks to. **On** starts the
  Ollama app and holds the distro open. **Off** unloads the Ollama models, quits
  Ollama and terminates the distro, so every process holding VRAM for the AI is
  gone.
- `tailscale serve --tcp` puts ports 8190, 8880, 5050, 8000 and 8188 on the
  tailnet (tailnet-only, no firewall rule needed).

### Setting one up

1. `wsl --install Ubuntu-24.04 --name touchsphere-ai --location E:\ai\wsl --no-launch`
2. `wsl -d touchsphere-ai -u root -- bash /mnt/e/ai/scripts/wsl-setup.sh` —
   systemd, Docker Engine and the NVIDIA container toolkit. Then
   `wsl --terminate touchsphere-ai` so systemd starts.
3. Inside the distro: clone the repo to `/srv/touchsphere`, put the RVC voices in
   `rvc-models/`, and `docker compose -f docker-compose.voice.yml --profile gpu up -d --build`.
4. `wsl -d touchsphere-ai -u root -- bash /mnt/e/ai/scripts/install-downloads-unit.sh` —
   the ComfyUI weights as a boot-time unit that resumes whenever the AI is on
   (~125 GB; progress shows on the dashboard's AI box card).
5. `powershell -ExecutionPolicy Bypass -File scripts\gpu-box\install-agent.ps1 -Dir E:\ai\agent`
   (the defaults are this box's: `wsl`, `touchsphere-ai`, the Ollama app), or by
   hand: copy `agent.js` and `start-agent.vbs` to `E:\ai\agent`, write a random
   `token.txt` there, and put a shortcut to `start-agent.vbs` in the Startup folder.
   `start-agent.vbs` is also the agent's supervisor: it starts `agent.js` again 10 s
   after it exits and writes each exit and its code to `supervisor.log` (-1 = killed
   from outside; an uncaught error is written to `agent.log` first).
   **Never start the agent from a terminal that belongs to another app.** A packaged
   app (the Claude desktop app is one) runs its children inside its own Windows job,
   and they all die when that app restarts: the agent, and with it the WSL keeper and
   every GPU container (2026-09-17). Sign-in starts it from the Startup folder; to
   start it by hand, use that shortcut, or WMI (which is what the installer does):
   `Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{CommandLine='wscript.exe "E:\ai\agent\start-agent.vbs"'}`
6. `tailscale serve --bg --tcp=<port> tcp://127.0.0.1:<port>` for 8190, 8880, 5050,
   8000 and 8188.
7. On the dashboard's host, in `.env`, add the box to `AI_BOXES` and its agent to
   `AI_BOX_AGENTS` as in the loklo-pc steps above, with the same `AI_BOX_AGENT_TOKEN`.

## A Linux box

The same agent with `"containers": "compose"` (the Linux default) and Ollama as
the `ollama` systemd service. From the checkout that runs the voice stack:
`sudo bash scripts/gpu-box/install-agent-linux.sh` installs it as
`touchsphere-ai-agent.service` (root, `Restart=always`) and writes a `token.txt`
when there is none — copy the other box's in first. Then `tailscale serve` and
the `.env` lines as above. `journalctl -u touchsphere-ai-agent -f` and
`scripts/gpu-box/agent.log` say what it did.
