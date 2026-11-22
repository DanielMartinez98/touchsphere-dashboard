"""Prompt-fidelity test: old vs new improver instructions for Qwen-Image 2.1 and MOSS-Image.
For each request, model and variant: ask the improver (Ollama), apply that version's length rule,
render on ComfyUI with a fixed seed, save PNG + the prompt. Usage: python run.py [outdir]"""
import json, re, sys, time, urllib.request, os, random
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out')
OLLAMA = os.environ.get('OLLAMA', 'http://127.0.0.1:11434')
COMFY = os.environ.get('COMFY', 'http://127.0.0.1:8188')
MODEL = os.environ.get('IMPROVER', 'gemma4:26b')
os.makedirs(OUT, exist_ok=True)
fx = json.load(open(os.path.join(HERE, 'fixture.json')))

def post(url, body, timeout=1800):
    req = urllib.request.Request(url, json.dumps(body).encode(), {'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=timeout))

def split(raw):
    t = raw.strip(); lo = t.lower(); o = lo.rfind('<prompt>')
    if o < 0: return t, ''
    c = lo.find('</prompt>', o)
    return t[o+8: c if c >= 0 else None].strip(), t[:o].strip()

def words(t): return len(t.split())

def fit(t, lim):
    m = lim.get('length')
    if not m: return t
    out, n = [], 0
    for s in re.split(r'(?<=[.!?])\s+', t):
        w = words(s)
        if n + w > m['max']: break
        out.append(s); n += w
    return ' '.join(out) or ' '.join(t.split()[:m['max']])

def improve(system, req, lim, variant):
    r = post(f'{OLLAMA}/api/chat', {'model': MODEL, 'stream': False, 'think': False, 'keep_alive': 0,
        'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': req}],
        'options': {'num_ctx': 16384, 'temperature': 0.7, 'num_predict': -1}})
    raw = r['message']['content']; prompt, notes = split(raw); note = ''
    if variant == 'old':
        if len(prompt) > lim['chars']: note = f'OLD RULE: {len(prompt)} chars > 900, rewrite thrown away, raw request drawn'; prompt = req
    else:
        m = lim['length']
        if words(prompt) > m['max'] or len(prompt) > lim['chars']:
            r2 = post(f'{OLLAMA}/api/chat', {'model': MODEL, 'stream': False, 'think': False, 'keep_alive': 0,
                'messages': [{'role': 'system', 'content': system + f"\n\nYOUR PREVIOUS PROMPT WAS {words(prompt)} WORDS LONG; THE LIMIT FOR THIS MODEL IS {m['max']} words (aim for {m['target'][0]} to {m['target'][1]}). This was it:\n{prompt}\n\nShorten it to fit. Keep every word of the user's request, the named characters and their series, the main action and the composition; drop the least important detail first. Put the shortened prompt between <prompt> and </prompt>."},
                             {'role': 'user', 'content': req}], 'options': {'num_ctx': 16384, 'temperature': 0.3, 'num_predict': -1}})
            p2, _ = split(r2['message']['content'])
            if p2 and words(p2) <= m['max']: note = f'NEW RULE: {words(prompt)} words, shortened by the model'; prompt = p2
            else: note = f'NEW RULE: {words(prompt)} words, cut to fit'; prompt = fit(prompt, lim)
    return prompt, notes, raw, note

def graph(style, prompt, seed):
    if style == 'wf:qwen-image-2.1':
        return {
          '1': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'qwen_image_2.1_int8_convrot.safetensors', 'weight_dtype': 'default'}},
          '2': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'qwen3vl_8b_int8_convrot.safetensors', 'type': 'qwen_image', 'device': 'default'}},
          '3': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'qwen_image_2.1_vae_bf16.safetensors'}},
          '4': {'class_type': 'QwenImage21Cache', 'inputs': {'model': ['1', 0], 'device': 'auto', 'dtype': 'default'}},
          '5': {'class_type': 'TextEncodeQwenImage21', 'inputs': {'clip': ['2', 0], 'prompt': prompt, 'negative_prompt': '', 'resolution': 1024}},
          '6': {'class_type': 'EmptyLatentImage', 'inputs': {'width': 1024, 'height': 1024, 'batch_size': 1}},
          '7': {'class_type': 'KSampler', 'inputs': {'seed': seed, 'steps': 25, 'cfg': 1, 'sampler_name': 'euler', 'scheduler': 'simple', 'denoise': 1,
                'model': ['4', 0], 'positive': ['5', 0], 'negative': ['5', 1], 'latent_image': ['6', 0]}},
          '8': {'class_type': 'VAEDecode', 'inputs': {'samples': ['7', 0], 'vae': ['3', 0]}},
          '9': {'class_type': 'SaveImage', 'inputs': {'filename_prefix': 'fidelity', 'images': ['8', 0]}}}
    return {
      '1': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'moss_image_sft_int8_convrot.safetensors', 'weight_dtype': 'default'}},
      '2': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'qwen3.5_9b_w4a8_gptq.safetensors', 'type': 'moss_image', 'device': 'default'}},
      '3': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'flux2-vae_small.safetensors'}},
      '4': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['2', 0]}},
      '5': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'nsfw, worst quality, bad anatomy, watermark, jpeg artifact', 'clip': ['2', 0]}},
      '6': {'class_type': 'EmptyFlux2LatentImage', 'inputs': {'width': 1024, 'height': 1024, 'batch_size': 1}},
      '7': {'class_type': 'KSampler', 'inputs': {'seed': seed, 'steps': 25, 'cfg': 2.5, 'sampler_name': 'er_sde', 'scheduler': 'simple', 'denoise': 1,
            'model': ['1', 0], 'positive': ['4', 0], 'negative': ['5', 0], 'latent_image': ['6', 0]}},
      '8': {'class_type': 'VAEDecode', 'inputs': {'samples': ['7', 0], 'vae': ['3', 0]}},
      '9': {'class_type': 'SaveImage', 'inputs': {'filename_prefix': 'fidelity', 'images': ['8', 0]}}}

def render(style, prompt, seed, path):
    pid = post(f'{COMFY}/prompt', {'prompt': graph(style, prompt, seed), 'client_id': 'fidelity'})['prompt_id']
    t0 = time.time()
    while time.time() - t0 < 1500:
        h = json.load(urllib.request.urlopen(f'{COMFY}/history/{pid}', timeout=30))
        if pid in h:
            st = h[pid].get('status', {})
            if st.get('status_str') == 'error': raise RuntimeError(json.dumps(st)[:500])
            for node in h[pid]['outputs'].values():
                for im in node.get('images', []):
                    q = f"filename={im['filename']}&subfolder={im['subfolder']}&type={im['type']}"
                    open(path, 'wb').write(urllib.request.urlopen(f'{COMFY}/view?{q}').read()); return
        time.sleep(3)
    raise TimeoutError(pid)

report = []
for style in ['wf:qwen-image-2.1', 'wf:moss-image-sft']:
    short = 'qwen' if 'qwen' in style else 'moss'
    for i, req in enumerate(fx['cases']):
        seed = 1000 + i
        for variant in ['old', 'new']:
            name = f'{short}-{i+1}-{variant}'
            try:
                prompt, notes, raw, note = improve(fx['system'][variant][style], req, fx['limits'][variant][style], variant)
                open(os.path.join(OUT, name + '.txt'), 'w', encoding='utf-8').write(
                    f'REQUEST: {req}\nNOTE: {note}\nWORDS: {words(prompt)} CHARS: {len(prompt)}\n\nPROMPT SENT:\n{prompt}\n\n---- RAW IMPROVER ANSWER ----\n{raw}\n')
                render(style, prompt, seed, os.path.join(OUT, name + '.png'))
                report.append({'name': name, 'request': req, 'words': words(prompt), 'chars': len(prompt), 'note': note})
                print('done', name, words(prompt), note, flush=True)
            except Exception as e:
                report.append({'name': name, 'request': req, 'error': str(e)}); print('FAIL', name, e, flush=True)
            json.dump(report, open(os.path.join(OUT, 'report.json'), 'w'), indent=1)
