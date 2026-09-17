# Vertex indexing performance

## Contract and scope

Measured on 2026-09-15 against the 2.1.41 implementation. Vertex embeddings retain
their existing model, gateway routing, authentication, embedding input, and vector
dimensions. This change does not require rebuilding an existing index.

Google's [text embedding documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings),
retrieved 2026-09-15, specifies one input text per request for `gemini-embedding-001`.
The installed Google SDK is `@google/genai` 1.29.1. We retain the single-text request
shape for gateway aliases as well.

## Pipeline

- File enumeration still runs before parsing. Embedding starts with the first parsed
  file; it does not wait for every file to be parsed.
- Vertex advertises a preferred indexing group of eight blocks. Whole files remain
  together even when larger than this target. Other providers retain their batching.
- The adapter shares a maximum of eight active requests across indexing batches and
  search calls on the same embedder instance. Each caller queues at most eight tasks.
  A completed request frees its slot immediately, without waiting for a group of
  slower responses. Results remain in input order.
- Configured request spacing, authentication refresh, and retry backoff still apply.
  Eight concurrent slots do not override an enabled rate-limit delay. For example,
  a one-second delay still permits at most about one request start per second.
- All embeddings for a file group must validate before existing points are removed.
  File hashes are committed after writes succeed. Progress counts stored blocks;
  the existing search service permits searches while indexing is in progress.
- Failed calls drain accepted requests before rejecting, and stop scheduling new
  texts for that call. Existing scanner cancellation and write boundaries remain.

## Reproducible offline measurement

```sh
pnpm --dir src exec vitest run services/code-index/processors/__tests__/vertex-indexing.benchmark.spec.ts --no-silent
```

The fixture uses the real scanner and Vertex adapter, with mocked file reads,
parser, Google SDK responses, and vector writes. It represents a cold index of 85
files with 20 blocks each (1,700 blocks). Each parse takes 20 ms; each request takes
100 ms, except every seventeenth block takes 400 ms; each vector write takes 2 ms.
Fake timers make the comparison deterministic. Rate-limit delay is disabled; no
retries or live network calls occur. Every run produces 1,700 requests and vectors.

| Implementation                                        | First request | First stored results |     Total | Peak requests |
| ----------------------------------------------------- | ------------: | -------------------: | --------: | ------------: |
| 2.1.41: groups of 60, four request slots              |         20 ms |            16,722 ms | 50,022 ms |             4 |
| Smaller groups, continuous refill, four slots         |         20 ms |             5,022 ms | 50,022 ms |             4 |
| Final: smaller groups, continuous refill, eight slots |         20 ms |             2,522 ms | 25,022 ms |             8 |

The four-slot comparison isolates earlier availability from higher throughput.
The total-time improvement in this fixture comes from increasing the bounded
request concurrency. These are scheduling measurements, not a claim that live GCP
will run twice as fast. Gateway latency, quotas, retries, rate-limit settings,
large individual files, parsing, and database performance can dominate a real run.

Focused regressions cover embedding while another file is still parsing, refill
before slow responses complete, ordering, shared concurrency, request spacing,
failure draining, and whole-file replacement. The benchmark guards first stored
results below 3 seconds and total simulated time below 26 seconds.
