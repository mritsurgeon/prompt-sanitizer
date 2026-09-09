#!/usr/bin/env python3
"""
Vocabulary pruning for the GLiNER checkpoint — `npm run provision:prune`.

More than half the download is one tensor. In `gliner-small-v2.1` the
int8 embedding table `word_embeddings.weight_quantized` is [128004, 768] UINT8
= 98.3 MB of a 182.4 MB checkpoint (54%); every other initializer is under
2.4 MB. So the payload problem is a vocabulary problem, and quantising the
projections further would attack the wrong 46%.

Two facts make this safe, and both were measured rather than assumed:

1. **Nothing degrades to `[UNK]`.** The tokenizer is SentencePiece *Unigram*
   with `byte_fallback: false`, and transformers.js implements byte fallback
   only for BPE — so the documented plan of "keep the byte tokens as a
   fallback" would not have worked. It does not need to: every single
   character sits in the low-id region, so Unigram's Viterbi routes around a
   missing piece using finer-grained surviving pieces.
   `Thandeka Mokoena` goes from ['▁Than','d','eka','▁Moko','ena'] to
   ['▁Than','de','ka','▁Mo','ko','ena'] — longer, not unknown. Zero `[UNK]`
   at every level tested.

2. **The embedding is consumed by a bare `Gather`**, with dequantisation
   downstream of the gathered vectors rather than per vocabulary row. Slicing
   rows therefore cannot invalidate a scale or zero-point.

The trap, which cost a full debugging cycle: **GLiNER's exported graph hardcodes
the `<<ENT>>` token id.** There is a `Constant` holding `128002` feeding
`Equal(input_ids, 128002) -> NonZero`, which is how the model locates the entity
markers that separate the label prompt from the text. Relocate `<<ENT>>` without
patching that constant and the model still loads, still runs, and returns almost
nothing — held-out F1 fell from 95.2%/100% to 30.8%/0%. Embedding rows, token
ids and the tokenizer were all verifiably correct; the graph was comparing
against an id that no longer existed. So the constants are remapped too, and
the result is asserted before the file is written.

Pruning *by vocabulary index* also means no id remapping for the kept prefix:
the top-N tokens are already ids 0..N-1. Only the four appended specials
([MASK], [FLERT], <<ENT>>, <<SEP>>) live at 128000..128003 and move down to
N..N+3.

The cost is token inflation, and it is not evenly distributed — see the README
table. Non-Western names pay it and Anglo names do not, which is worth knowing
before choosing N.

    python3 scripts/prune-vocab.py --keep 32000 \
        --src public/models/gliner-small --out public/models/gliner-small-32k
"""
import argparse
import json
import os
import re
import shutil

import numpy as np
import onnx
from onnx import numpy_helper as nh

SPECIAL_TAIL = 4  # [MASK], [FLERT], <<ENT>>, <<SEP>> at the end of the table


def prune(src: str, out: str, keep: int) -> None:
    os.makedirs(os.path.join(out, "onnx"), exist_ok=True)

    tokenizer = json.load(open(os.path.join(src, "tokenizer.json")))
    vocab = tokenizer["model"]["vocab"]
    if keep >= len(vocab):
        raise SystemExit(f"--keep {keep} is not smaller than the vocabulary ({len(vocab)})")

    # Byte tokens live at 4..259 and every single character is in the low-id
    # region, so any sane `keep` retains the machinery Viterbi needs to
    # decompose an unseen word. Refuse a value that does not.
    byte_ids = [i for i, (t, _) in enumerate(vocab) if re.fullmatch(r"<0x[0-9A-F]{2}>", t)]
    if max(byte_ids) >= keep:
        raise SystemExit(f"--keep {keep} would drop byte tokens (they end at id {max(byte_ids)})")

    model = onnx.load(os.path.join(src, "onnx", "model.onnx"))
    inits = {i.name: i for i in model.graph.initializer}
    emb_name = next(
        (n for n, t in inits.items() if len(t.dims) == 2 and t.dims[0] == len(vocab) + SPECIAL_TAIL),
        None,
    )
    if emb_name is None:
        raise SystemExit("could not find the embedding table")

    consumers = [n.op_type for n in model.graph.node if emb_name in n.input]
    if consumers != ["Gather"]:
        raise SystemExit(f"expected the embedding to feed a single Gather, found {consumers}")

    table = nh.to_array(inits[emb_name])
    kept = np.concatenate([table[:keep], table[-SPECIAL_TAIL:]], axis=0)
    print(f"embedding {list(table.shape)} -> {list(kept.shape)}  "
          f"{table.nbytes / 1e6:.1f} MB -> {kept.nbytes / 1e6:.1f} MB")

    new_init = nh.from_array(kept, name=emb_name)
    inits[emb_name].CopyFrom(new_init)

    # --- follow the special tokens through the graph -------------------------
    vocab_len = len(vocab)
    remap = {vocab_len + k: keep + k for k in range(SPECIAL_TAIL)}
    patched = []
    for node in model.graph.node:
        for attr in node.attribute:
            if attr.type != onnx.AttributeProto.TENSOR:
                continue
            arr = nh.to_array(attr.t)
            if arr.shape != () or arr.dtype.kind not in "iu":
                continue
            old = int(arr)
            if old in remap:
                attr.t.CopyFrom(
                    nh.from_array(np.array(remap[old], dtype=arr.dtype), name=attr.t.name)
                )
                patched.append((node.name, old, remap[old]))
    for name, old, new in patched:
        print(f"patched constant {name}: {old} -> {new}")
    if not patched:
        print("warning: no graph constant referenced a relocated special token")

    # Nothing may still point past the end of the new table.
    limit = keep + SPECIAL_TAIL
    for node in model.graph.node:
        for attr in node.attribute:
            if attr.type == onnx.AttributeProto.TENSOR:
                arr = nh.to_array(attr.t)
                if arr.shape == () and arr.dtype.kind in "iu" and vocab_len <= int(arr) < 200_000:
                    raise SystemExit(
                        f"{node.name} still references token id {int(arr)}, "
                        f"outside the pruned table of {limit}"
                    )

    onnx.save(model, os.path.join(out, "onnx", "model.onnx"))

    # --- tokenizer: truncate, and move the appended specials down -----------
    tokenizer["model"]["vocab"] = vocab[:keep]
    for added in tokenizer.get("added_tokens", []):
        if added["id"] >= len(vocab):
            added["id"] = keep + (added["id"] - len(vocab))
    json.dump(tokenizer, open(os.path.join(out, "tokenizer.json"), "w"))

    added_path = os.path.join(src, "added_tokens.json")
    added = json.load(open(added_path))
    json.dump(
        {k: keep + (v - len(vocab)) if v >= len(vocab) else v for k, v in added.items()},
        open(os.path.join(out, "added_tokens.json"), "w"),
        indent=2,
        sort_keys=True,
    )

    for name in ("config.json", "gliner_config.json", "special_tokens_map.json",
                 "tokenizer_config.json"):
        path = os.path.join(src, name)
        if not os.path.exists(path):
            continue
        try:
            data = json.load(open(path))
        except json.JSONDecodeError:
            shutil.copy(path, os.path.join(out, name))
            continue
        if isinstance(data, dict) and data.get("vocab_size") == len(vocab) + SPECIAL_TAIL:
            data["vocab_size"] = keep + SPECIAL_TAIL
            print(f"{name}: vocab_size -> {keep + SPECIAL_TAIL}")
        json.dump(data, open(os.path.join(out, name), "w"), indent=2)

    before = os.path.getsize(os.path.join(src, "onnx", "model.onnx"))
    after = os.path.getsize(os.path.join(out, "onnx", "model.onnx"))
    print(f"model.onnx {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB "
          f"({100 * (1 - after / before):.0f}% smaller)")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--keep", type=int, default=32000)
    p.add_argument("--src", default="public/models/gliner-small")
    p.add_argument("--out", default="public/models/gliner-small-pruned")
    a = p.parse_args()
    prune(a.src, a.out, a.keep)
