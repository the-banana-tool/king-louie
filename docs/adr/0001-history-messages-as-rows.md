# History messages are rows, not per-chat blobs

The history store keeps each message as its own SQLite row with a dense
per-chat `seq`, not each chat as one JSON blob. A blob store was built first
(998ebbb) and is simpler, but it rewrites the whole chat on every append and
gives chunks, full-text rows and embeddings no message to hang off, so recall
could not be built on it; it was replaced before any real profile migrated
into it (2026-09-29, recall spec §4.1 and §4.4).
