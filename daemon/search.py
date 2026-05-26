#!/usr/bin/env python3
"""
Murmur Lite — Search Daemon
Semantic search over imported and archived memories.
ChromaDB + sentence-transformers, runs locally.
"""

import os
import sys
import re
import json
from pathlib import Path
from typing import Optional

try:
    import numpy as np
except ImportError:
    print("Missing: pip install numpy (or install all daemon deps: pip install -r daemon/requirements.txt)")
    sys.exit(1)

try:
    from fastapi import FastAPI
    from pydantic import BaseModel
    import uvicorn
except ImportError:
    print("Missing: pip install fastapi uvicorn")
    sys.exit(1)

try:
    from sentence_transformers import SentenceTransformer
    import chromadb
except ImportError:
    print("Missing: pip install sentence-transformers chromadb")
    sys.exit(1)

# Config
DATA_DIR = Path(os.environ.get('MURMUR_LITE_DATA_DIR', Path(__file__).parent.parent / 'data'))
CHROMA_DIR = DATA_DIR / 'chroma'
PORT = int(os.environ.get('MURMUR_LITE_PORT', '3457'))
MODEL_NAME = "all-MiniLM-L6-v2"
COLLECTION_NAME = "memories"

# State
model = None
chroma_client = None
collection = None
import_progress = {"status": "idle", "current": 0, "total": 0, "conversation": ""}

app = FastAPI()


# --- Models ---

class SearchRequest(BaseModel):
    query: str
    limit: int = 5

class AddRequest(BaseModel):
    content: str
    source: str = "unknown"
    metadata: Optional[dict] = None


# --- Init ---

def init():
    global model, chroma_client, collection

    print(f"Loading embedding model: {MODEL_NAME}...", flush=True)
    model = SentenceTransformer(MODEL_NAME)
    print("Model loaded.", flush=True)

    CHROMA_DIR.mkdir(parents=True, exist_ok=True)
    chroma_client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    collection = chroma_client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"}
    )
    print(f"ChromaDB ready. Collection '{COLLECTION_NAME}' has {collection.count()} entries.", flush=True)


# --- Endpoints ---

@app.get("/health")
def health():
    count = collection.count() if collection else 0
    return {"status": "ok", "entries": count, "model": MODEL_NAME}


@app.post("/search")
def search(req: SearchRequest):
    if not model or not collection:
        return {"results": [], "error": "not initialized"}

    if collection.count() == 0:
        return {"results": []}

    embedding = model.encode(req.query).tolist()
    results = collection.query(
        query_embeddings=[embedding],
        n_results=min(req.limit, collection.count()),
    )

    output = []
    if results and results['documents']:
        query_embedding = embedding
        for i, doc in enumerate(results['documents'][0]):
            meta = results['metadatas'][0][i] if results['metadatas'] else {}
            distance = results['distances'][0][i] if results['distances'] else 0

            # Retrieval-time extraction: preserve paired exchanges, contiguous windows
            trimmed = extract_relevant(doc, query_embedding, max_chars=1200)

            output.append({
                "content": trimmed,
                "source": meta.get("source", "unknown"),
                "score": round(1 - distance, 3),  # cosine similarity
                "metadata": meta,
            })

    return {"results": output}


@app.post("/add")
def add_memory(req: AddRequest):
    if not model or not collection:
        return {"error": "not initialized"}

    # Generate ID from content hash
    import hashlib
    content_hash = hashlib.md5(req.content.encode()).hexdigest()[:12]
    doc_id = f"{req.source}_{content_hash}"

    # Check for duplicate
    try:
        existing = collection.get(ids=[doc_id])
        if existing and existing['ids']:
            return {"status": "duplicate", "id": doc_id}
    except Exception:
        pass

    # Embed and store
    embedding = model.encode(req.content).tolist()
    metadata = {"source": req.source}
    if req.metadata:
        metadata.update(req.metadata)

    collection.upsert(
        ids=[doc_id],
        embeddings=[embedding],
        documents=[req.content],
        metadatas=[metadata],
    )

    return {"status": "added", "id": doc_id, "total": collection.count()}


@app.get("/import-progress")
def get_import_progress():
    """Get current import progress for the frontend progress bar."""
    return import_progress


def batch_add_memories(chunks: list, source: str) -> int:
    """Encode and store chunks in batches. Much faster than one-by-one."""
    import hashlib

    if not chunks or not model or not collection:
        return 0

    BATCH_SIZE = 50
    imported = 0

    for batch_start in range(0, len(chunks), BATCH_SIZE):
        batch = chunks[batch_start:batch_start + BATCH_SIZE]

        # Generate IDs and check for duplicates
        ids = []
        new_chunks = []
        for chunk in batch:
            content_hash = hashlib.md5(chunk.encode()).hexdigest()[:12]
            doc_id = f"{source}_{content_hash}"
            # Quick duplicate check
            try:
                existing = collection.get(ids=[doc_id])
                if existing and existing['ids']:
                    imported += 1  # Count as processed
                    continue
            except Exception:
                pass
            ids.append(doc_id)
            new_chunks.append(chunk)

        if not new_chunks:
            continue

        # Batch encode — this is the big speedup
        embeddings = model.encode(new_chunks).tolist()

        # Batch store (upsert: re-archiving won't crash on duplicate IDs)
        metadatas = [{"source": source} for _ in new_chunks]
        collection.upsert(
            ids=ids,
            embeddings=embeddings,
            documents=new_chunks,
            metadatas=metadatas,
        )
        imported += len(new_chunks)

    return imported


@app.post("/import")
def import_bulk(data: dict):
    """Import a block of text, split by paragraphs with sentence-level fallback for long chunks."""
    text = data.get("text", "")
    if not text:
        return {"imported": 0}

    chunks = smart_chunk(text)
    imported = batch_add_memories(chunks, "import")
    return {"imported": imported, "total": collection.count()}


def _parse_conv_date(convo: dict) -> str:
    """Extract a YYYY-MM-DD date string from a conversation's metadata.
    Added May 16 2026 so chunks carry a timestamp into search results — without
    it, the companion can't tell *when* a memory comes from. Returns "" when
    no usable timestamp is present (chunk just won't display a date).

    Supports both export formats:
      - Claude.ai: top-level `created_at` as ISO string, or first chat_message's
        `created_at`.
      - ChatGPT: earliest `create_time` (Unix timestamp) across mapping nodes,
        or top-level `create_time`.
    """
    from datetime import datetime, timezone

    def _to_date(val):
        try:
            if isinstance(val, (int, float)) and val > 0:
                return datetime.fromtimestamp(val, tz=timezone.utc).strftime("%Y-%m-%d")
            if isinstance(val, str) and len(val) >= 10:
                # ISO 8601 — the first 10 chars are YYYY-MM-DD.
                return val[:10]
        except Exception:
            pass
        return ""

    # Top-level conversation timestamp first — most exports have it.
    for key in ("created_at", "create_time", "createdAt", "created"):
        d = _to_date(convo.get(key))
        if d:
            return d

    # Fallback: first message in chat_messages (Claude.ai) or messages list (simple).
    for msg_key in ("chat_messages", "messages"):
        msgs = convo.get(msg_key)
        if isinstance(msgs, list) and msgs and isinstance(msgs[0], dict):
            for ts_key in ("created_at", "create_time", "timestamp"):
                d = _to_date(msgs[0].get(ts_key))
                if d:
                    return d

    # Fallback: earliest create_time across ChatGPT mapping nodes.
    mapping = convo.get("mapping")
    if isinstance(mapping, dict):
        earliest = None
        for node in mapping.values():
            msg = node.get("message") if isinstance(node, dict) else None
            if isinstance(msg, dict):
                ct = msg.get("create_time")
                if isinstance(ct, (int, float)) and ct > 0:
                    if earliest is None or ct < earliest:
                        earliest = ct
        if earliest is not None:
            return _to_date(earliest)

    return ""


@app.post("/import-conversations")
def import_conversations(data: dict):
    """Import a conversations.json file (claude.ai or ChatGPT export).
    Uses batch encoding for speed + progress tracking for the frontend."""
    global import_progress

    conversations = data.get("conversations", [])
    if not conversations:
        return {"imported": 0, "error": "no conversations array found"}

    # Collect all chunks first so we can report accurate progress
    all_chunks = []  # (chunk_text, source, date) — date is YYYY-MM-DD or ""
    for convo in conversations:
        title = convo.get("name", convo.get("title", "Untitled"))
        messages = convo.get("mapping", convo.get("messages", {}))

        chat_messages = convo.get("chat_messages", [])
        if chat_messages:
            exchanges = pair_messages_claude(chat_messages, title)
        elif isinstance(messages, dict):
            exchanges = pair_messages_gpt(messages, title)
        elif isinstance(messages, list):
            exchanges = pair_messages_simple(messages, title)
        else:
            continue

        source = f"conversation:{title[:50]}"
        conv_date = _parse_conv_date(convo)
        for exchange in exchanges:
            if len(exchange) >= 30:
                all_chunks.append((exchange, source, conv_date))

    total = len(all_chunks)
    import_progress = {"status": "running", "current": 0, "total": total, "conversation": f"{len(conversations)} conversations"}

    # Process in batches with progress updates
    import hashlib
    BATCH_SIZE = 50
    imported = 0

    for batch_start in range(0, total, BATCH_SIZE):
        batch = all_chunks[batch_start:batch_start + BATCH_SIZE]

        # Deduplicate against the existing DB AND against the current batch.
        # The in-batch check is the new piece (May 16 2026): the previous logic
        # only checked existing IDs in the collection, so duplicate exchanges
        # WITHIN one batch (common in Claude.ai exports — repeated messages or
        # short exchanges that hash identically) produced the same doc_id twice
        # in `ids`, and chromadb's upsert rejected the call with DuplicateIDError.
        # That killed the whole batch and the frontend's misleading "Done!" UI
        # reported 0 imported.
        # First pass: dedup within batch, build the candidate id/chunk lists.
        candidate_ids = []
        candidate_chunks = []
        candidate_sources = []
        candidate_dates = []
        seen_in_batch = set()
        for chunk_text, source, date in batch:
            content_hash = hashlib.md5(chunk_text.encode()).hexdigest()[:12]
            doc_id = f"{source}_{content_hash}"
            if doc_id in seen_in_batch:
                continue
            seen_in_batch.add(doc_id)
            candidate_ids.append(doc_id)
            candidate_chunks.append(chunk_text)
            candidate_sources.append(source)
            candidate_dates.append(date)

        # Single batched existence check (was per-chunk before — 12k chunks
        # produced 12k+ sequential chromadb roundtrips, taking ~15 minutes on
        # a metadata-backfill re-import. Batching brings it down to one get
        # per 50-chunk batch.)
        existing_meta_by_id = {}
        try:
            if candidate_ids:
                existing = collection.get(ids=candidate_ids, include=["metadatas"])
                if existing and existing.get('ids'):
                    metas = existing.get('metadatas') or []
                    for i, eid in enumerate(existing['ids']):
                        existing_meta_by_id[eid] = (metas[i] if i < len(metas) else None) or {}
        except Exception:
            pass

        # Second pass: partition into new (need embed + upsert) vs existing
        # (count as imported, queue metadata backfill if a new field is now
        # available — currently the `date` field).
        new_chunks = []
        new_ids = []
        new_metadatas = []
        backfill_ids = []
        backfill_metadatas = []
        for i, doc_id in enumerate(candidate_ids):
            source = candidate_sources[i]
            date = candidate_dates[i]
            if doc_id in existing_meta_by_id:
                existing_date = existing_meta_by_id[doc_id].get('date')
                if date and not existing_date:
                    backfill_ids.append(doc_id)
                    backfill_metadatas.append({"source": source, "date": date})
                imported += 1
            else:
                new_ids.append(doc_id)
                new_chunks.append(candidate_chunks[i])
                new_metadatas.append({"source": source, "date": date})

        # Batched metadata-only backfill (no re-embedding required).
        if backfill_ids:
            try:
                collection.update(ids=backfill_ids, metadatas=backfill_metadatas)
            except Exception:
                pass

        # Batched upsert of newly-seen chunks (encoded fresh).
        if new_chunks:
            embeddings = model.encode(new_chunks).tolist()
            collection.upsert(
                ids=new_ids,
                embeddings=embeddings,
                documents=new_chunks,
                metadatas=new_metadatas,
            )
            imported += len(new_chunks)

        # Update progress
        import_progress["current"] = min(batch_start + BATCH_SIZE, total)

    import_progress = {"status": "done", "current": total, "total": total, "conversation": ""}
    return {"imported": imported, "total": collection.count()}


# --- Retrieval extraction ---

def extract_relevant(doc: str, query_embedding: list, max_chars: int = 1200) -> str:
    """Extract the most relevant region from a stored chunk, capped at max_chars.

    Strategy:
      1. If doc already fits — return whole doc.
      2. If doc contains paired-exchange markers (Partner:/Companion:),
         score each FULL pair and keep as many top-scoring pairs as fit,
         preserving their original order. This stops the 'only one side
         of the conversation comes back' failure mode.
      3. Otherwise fall back to a contiguous sliding window over sentences —
         we never sentence-shred a chunk so its structure stays intact.

    Full content stays in the DB — we just serve less to the companion.
    """
    if len(doc) <= max_chars:
        return doc

    query_np = np.array(query_embedding)
    query_norm = np.linalg.norm(query_np) + 1e-8

    # --- Path 1: paired exchanges ---------------------------------------
    # Split on the boundary BEFORE a 'Partner:' line so each pair survives intact.
    if "Partner:" in doc and "Companion:" in doc:
        # Optional [title] prefix on first segment is preserved with the first pair.
        pairs = re.split(r'(?=^Partner:)', doc, flags=re.MULTILINE)
        pairs = [p.strip() for p in pairs if p.strip()]

        if len(pairs) >= 2:
            embeddings = model.encode(pairs)
            scored = []
            for j, emb in enumerate(embeddings):
                sim = float(np.dot(query_np, emb) / (query_norm * (np.linalg.norm(emb) + 1e-8)))
                scored.append((j, sim, pairs[j]))

            scored.sort(key=lambda x: x[1], reverse=True)
            selected = []
            total = 0
            for idx, _score, pair in scored:
                # Always allow at least one pair through, even if oversized.
                if selected and total + len(pair) + 2 > max_chars:
                    continue
                selected.append((idx, pair))
                total += len(pair) + 2

            selected.sort(key=lambda x: x[0])
            return "\n\n".join(p for _, p in selected)

    # --- Path 2: contiguous sliding window over sentences ---------------
    sentences = re.split(r'(?<=[.!?])\s+', doc)
    if len(sentences) <= 1:
        return doc[:max_chars]

    sentence_embeddings = model.encode(sentences)
    sims = []
    for emb in sentence_embeddings:
        sim = float(np.dot(query_np, emb) / (query_norm * (np.linalg.norm(emb) + 1e-8)))
        sims.append(sim)

    # Find the contiguous window of sentences whose total length fits in
    # max_chars and whose mean similarity is highest. Preserves narrative flow.
    best_score = -1.0
    best_range = (0, 1)
    n = len(sentences)
    for start in range(n):
        total_len = 0
        score_sum = 0.0
        count = 0
        for end in range(start, n):
            slen = len(sentences[end]) + 1
            if count and total_len + slen > max_chars:
                break
            total_len += slen
            score_sum += sims[end]
            count += 1
            mean = score_sum / count
            if mean > best_score:
                best_score = mean
                best_range = (start, end + 1)

    s, e = best_range
    return ' '.join(sentences[s:e])


# --- Chunking helpers ---

def smart_chunk(text: str, max_chars: int = 500) -> list:
    """Split text by paragraphs, with sentence fallback for long chunks."""
    paragraphs = [p.strip() for p in text.split("\n\n") if len(p.strip()) > 20]
    chunks = []

    for para in paragraphs:
        if len(para) <= max_chars:
            chunks.append(para)
        else:
            # Split long paragraphs at sentence boundaries
            sentences = re.split(r'(?<=[.!?])\s+', para)
            current = ""
            for sentence in sentences:
                if len(current) + len(sentence) > max_chars and current:
                    chunks.append(current.strip())
                    current = sentence
                else:
                    current = (current + " " + sentence).strip()
            if current and len(current) > 20:
                chunks.append(current)

    return chunks


def combine_exchanges(messages: list, title: str) -> list:
    """Combine user+assistant into single units, then smart_chunk the whole sequence.
    Full content stored — retrieval handles capping. No truncation at import."""

    # Build a continuous text from paired exchanges
    paired_text = []
    i = 0
    while i < len(messages):
        role = messages[i].get("role", messages[i].get("sender", ""))
        text = messages[i].get("content", messages[i].get("text", ""))
        if isinstance(text, list):
            text = " ".join(str(t) for t in text)

        if role in ("user", "human"):
            user_msg = text or ""
            i += 1

            # Collect assistant response(s)
            assistant_parts = []
            while i < len(messages):
                r = messages[i].get("role", messages[i].get("sender", ""))
                if r not in ("assistant", "ai"):
                    break
                t = messages[i].get("content", messages[i].get("text", ""))
                if isinstance(t, list):
                    t = " ".join(str(x) for x in t)
                if t and str(t).strip():
                    assistant_parts.append(str(t))
                i += 1

            if user_msg and assistant_parts:
                assistant_msg = " ".join(assistant_parts)
                paired_text.append(f"Partner: {user_msg}\nCompanion: {assistant_msg}")
        else:
            i += 1

    if not paired_text:
        return []

    # Join all exchanges with double newline, then smart_chunk handles boundaries
    full_text = f"[{title}]\n\n" + "\n\n".join(paired_text)
    return smart_chunk(full_text)


def pair_messages_claude(messages: list, title: str) -> list:
    """Parse claude.ai export and combine into smart chunks."""
    # Normalise claude.ai format to simple role+content
    normalised = []
    for msg in messages:
        sender = msg.get("sender", "")
        text = msg.get("text", "")
        if isinstance(text, list):
            text = " ".join(str(t) for t in text)
        if sender == "human":
            normalised.append({"role": "user", "content": text})
        elif sender == "assistant" and text.strip():
            normalised.append({"role": "assistant", "content": text})
    return combine_exchanges(normalised, title)


def pair_messages_gpt(mapping: dict, title: str) -> list:
    """Parse ChatGPT export (mapping format) and combine into smart chunks."""
    ordered = []
    for node_id, node in mapping.items():
        msg = node.get("message")
        if not msg:
            continue
        role = msg.get("author", {}).get("role", "")
        content = msg.get("content", {})
        parts = content.get("parts", [])
        text = " ".join(str(p) for p in parts if isinstance(p, str))
        if role in ("user", "assistant") and text.strip():
            ordered.append({"role": role, "content": text, "create_time": msg.get("create_time", 0)})

    ordered.sort(key=lambda x: x.get("create_time", 0))
    return combine_exchanges(ordered, title)


def pair_messages_simple(messages: list, title: str) -> list:
    """Fallback: normalise any role+content array and combine into smart chunks."""
    normalised = []
    for msg in messages:
        role = msg.get("role", msg.get("sender", ""))
        text = msg.get("content", msg.get("text", ""))
        if isinstance(text, list):
            text = " ".join(str(t) for t in text)
        if role in ("user", "human"):
            normalised.append({"role": "user", "content": text})
        elif role in ("assistant", "ai") and text.strip():
            normalised.append({"role": "assistant", "content": text})
    return combine_exchanges(normalised, title)


# --- Main ---

if __name__ == "__main__":
    init()
    print(f"Search daemon running on http://127.0.0.1:{PORT}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
