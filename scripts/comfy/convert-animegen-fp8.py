#!/usr/bin/env python3
"""Cast AIdeaLab's AnimeGen-I2V bf16 experts to fp8 for a 24 GB card.

  python3 convert-animegen-fp8.py <in.safetensors> <out.safetensors>

Each expert is 28.6 GB in bf16, more than the 4090's VRAM and the GPU box's
16 GB of WSL RAM, so the dashboard's AnimeGen style loads fp8 copies
(~14.3 GB): the 2-D linear weights inside the transformer blocks become
float8_e4m3fn, and everything else (norms, biases, modulation, embeddings,
the head) stays bf16, the way ComfyUI's own Wan fp8 files are cut.

One tensor at a time: the input is memory-mapped by safe_open and the output
is written by hand (8-byte header length, JSON header, raw data), so peak RAM
is one tensor rather than the whole model.
"""
import json, struct, sys
import torch
from safetensors import safe_open

def main(src: str, dst: str) -> None:
    with safe_open(src, framework='pt') as f:
        names = list(f.keys())
        meta, offset, plan = {}, 0, []
        for n in names:
            sl = f.get_slice(n)
            shape = sl.get_shape()
            dt = sl.get_dtype()
            cast = dt == 'BF16' and len(shape) == 2 and n.endswith('.weight') and 'blocks.' in n \
                and 'norm' not in n and 'modulation' not in n
            out_dt = 'F8_E4M3' if cast else dt
            size = 1
            for d in shape: size *= d
            nbytes = size * {'F8_E4M3': 1, 'BF16': 2, 'F16': 2, 'F32': 4}[out_dt]
            meta[n] = {'dtype': out_dt, 'shape': shape, 'data_offsets': [offset, offset + nbytes]}
            plan.append((n, cast))
            offset += nbytes
        header = json.dumps(meta, separators=(',', ':')).encode()
        header += b' ' * ((8 - len(header) % 8) % 8)
        with open(dst + '.part', 'wb') as out:
            out.write(struct.pack('<Q', len(header)))
            out.write(header)
            for i, (n, cast) in enumerate(plan):
                t = f.get_tensor(n)
                if cast:
                    t = t.to(torch.float8_e4m3fn)
                out.write(t.contiguous().reshape(-1).view(torch.uint8).numpy().tobytes())
                if i % 100 == 0:
                    print(f'{i}/{len(plan)} {n}', flush=True)
    import os
    os.replace(dst + '.part', dst)
    print(f'done: {dst} ({offset / 1e9:.1f} GB of tensors)')

if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
