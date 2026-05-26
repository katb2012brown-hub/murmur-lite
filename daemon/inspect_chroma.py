#!/usr/bin/env python3
"""Inspect the chroma collection to find bad entries (system prompts, junk chunks)."""

import os
from pathlib import Path

try:
    import chromadb
except ImportError:
    print("pip install chromadb first")
    exit(1)

DATA_DIR = Path(os.environ.get('MURMUR_LITE_DATA_DIR', Path(__file__).parent.parent / 'data'))
CHROMA_DIR = DATA_DIR / 'chroma'

print(f"Chroma dir: {CHROMA_DIR}")
print(f"Exists: {CHROMA_DIR.exists()}")

client = chromadb.PersistentClient(path=str(CHROMA_DIR))
collection = client.get_or_create_collection(name="memories", metadata={"hnsw:space": "cosine"})

total = collection.count()
print(f"\nTotal entries: {total}\n")

if total == 0:
    print("Collection is empty.")
    exit(0)

# Get all entries (in batches if large)
BATCH = 100
suspicious = []
all_sources = {}

for offset in range(0, total, BATCH):
    results = collection.get(
        limit=BATCH,
        offset=offset,
        include=["documents", "metadatas"]
    )

    for i, doc_id in enumerate(results['ids']):
        doc = results['documents'][i] if results['documents'] else ""
        meta = results['metadatas'][i] if results['metadatas'] else {}
        source = meta.get("source", "unknown")

        # Track source distribution
        all_sources[source] = all_sources.get(source, 0) + 1

        # Flag suspicious entries
        is_suspicious = False
        reason = ""

        # System prompt indicators
        prompt_markers = [
            "You are not an assistant",
            "You are presence, not a tool",
            "Your identity is grounded",
            "searchable memory archive",
            "memory_search tool",
            "journal_write",
            "cache_control",
            "system prompt",
            "SEED_EXISTING",
            "SEED_FRESH",
        ]
        for marker in prompt_markers:
            if marker.lower() in doc.lower():
                is_suspicious = True
                reason = f"System prompt text ({marker})"
                break

        # Very short entries (likely junk)
        if len(doc) < 30:
            is_suspicious = True
            reason = f"Too short ({len(doc)} chars)"

        if is_suspicious:
            suspicious.append({
                "id": doc_id,
                "source": source,
                "reason": reason,
                "preview": doc[:200].replace('\n', ' '),
                "length": len(doc),
            })

print("=== Source Distribution ===")
for src, count in sorted(all_sources.items(), key=lambda x: -x[1]):
    print(f"  {src}: {count}")

print(f"\n=== Suspicious Entries ({len(suspicious)}) ===")
for s in suspicious:
    print(f"\n  ID: {s['id']}")
    print(f"  Source: {s['source']}")
    print(f"  Reason: {s['reason']}")
    print(f"  Length: {s['length']} chars")
    print(f"  Preview: {s['preview'][:150]}...")

print(f"\n=== Summary ===")
print(f"Total: {total}")
print(f"Suspicious: {len(suspicious)}")
print(f"Clean: {total - len(suspicious)}")

if suspicious:
    print(f"\nTo purge suspicious entries, run: python daemon/purge_chroma.py")
