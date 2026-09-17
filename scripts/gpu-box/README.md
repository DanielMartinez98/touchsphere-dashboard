# A Windows GPU box with an on/off switch

How lokloComputer (Windows 11, RTX 4090, no Docker Desktop) runs TouchSphere's
GPU services, and how the dashboard switches them on and off. Paths assume the
box keeps everything in `E:\ai`.

```
E:\ai\agent\        agent.js, start-agent.vbs, token.txt, state.json, agent.log
E:\ai\scripts\      comfy-models.sh (+ .log), wsl-setup.sh, install-downloads-unit.sh
E:\ai\wsl\          ext4.vhdx of the touchsphere-ai WSL distro
E:\ai\ollama\models the Ollama app's model folder
```

## What runs where

- **Ollama** is the ordinary Windows app, with its model folder set to
  `E:\ai\ollama\models` and "Expose Ollama to the network" on (port 11434).
- **Kokoro, Whisper, RVC and ComfyUI** are `docker-compose.voice.yml --profile gpu`
  inside a dedicated WSL distro, `touchsphere-ai`, whose disk lives in `E:\ai\wsl`.
  The checkout, the RVC voices and the ComfyUI weights are on that distro's own
  ext4 disk (`/srv/touchsphere`), because ComfyUI mmaps multi-GB safetensors and
  over `/mnt/e` that is many times slower.
- **The agent** (`agent.js`, Node, no dependencies) listens on 127.0.0.1:8190 and
  is what the dashboard's Settings → AI box switch talks to. **On** starts the
  Ollama app and holds the distro open (WSL shuts a distro down once nothing is
  attached to it, containers and all). **Off** unloads the Ollama models, quits
  Ollama and terminates the distro, so every process holding VRAM for the AI is
  gone. It remembers the last choice in `state.json` and restores it at logon.
- `tailscale serve --tcp` puts ports 8190, 8880, 5050, 8000 and 8188 on the
  tailnet (tailnet-only, no firewall rule needed).

## Setting one up

1. `wsl --install Ubuntu-24.04 --name touchsphere-ai --location E:\ai\wsl --no-launch`
2. `wsl -d touchsphere-ai -u root -- bash /mnt/e/ai/scripts/wsl-setup.sh` —
   systemd, Docker Engine and the NVIDIA container toolkit. Then
   `wsl --terminate touchsphere-ai` so systemd starts.
3. Inside the distro: clone the repo to `/srv/touchsphere`, put the RVC voices in
   `rvc-models/`, and `docker compose -f docker-compose.voice.yml --profile gpu up -d --build`.
4. `wsl -d touchsphere-ai -u root -- bash /mnt/e/ai/scripts/install-downloads-unit.sh` —
   the ComfyUI weights as a boot-time unit that resumes whenever the AI is on
   (~125 GB; progress shows on the dashboard's AI box card).
5. Copy `agent.js` and `start-agent.vbs` to `E:\ai\agent`, write a random
   `token.txt` there, and put a shortcut to `start-agent.vbs` in the Startup folder.
6. `tailscale serve --bg --tcp=<port> tcp://127.0.0.1:<port>` for 8190, 8880, 5050,
   8000 and 8188.
7. On the dashboard's host, in `.env`:
   ```
   AI_BOXES=loklo-pc=100.98.235.63, lokloComputer=100.112.40.40
   AI_BOX_AGENTS=lokloComputer=http://100.112.40.40:8190
   AI_BOX_AGENT_TOKEN=<token.txt>
   ```

The agent's API: `GET /status`, `POST /power {"on": true|false}`, both with
`Authorization: Bearer <token.txt>`.
