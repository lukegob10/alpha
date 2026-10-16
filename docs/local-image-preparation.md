# Local image preparation

New local image reads share `imageHelpers.ts`, `imageDecoder.ts`, and the existing image-validation worker.
`read_file`, `view_image`, and local image mentions publish the representation admitted by this shared path.
Rasters retain their approved source bytes and MIME type. SVG is fully decoded and prepared as PNG; the source file
is never rewritten.

This contract applies to new local reads. Existing transcripts, user-supplied images, MCP images, and provider-history
projections remain separate ingress paths. Passing the local tests does not establish a universal no-raw-SVG guarantee.

## Reference and intentional extension behavior

The source comparison used [Codex CLI commit f0c5077](https://github.com/openai/codex/tree/f0c5077c34ec7a76b4ad9134835925e6ae3d72ec)
on October 15, 2026. SVG preparation is an intentional Alpha extension capability. Its implementation uses native
TypeScript and the public `@imagemagick/magick-wasm` 0.0.44 API. It does not introduce another agent runtime or an OS
execution sandbox. Existing workspace, approval, and tool-policy protections still own authority.

## Admission and output

- The existing bounded file reader captures the smaller file and remaining aggregate allowance before decoding.
  Read, close, cancellation, and first-error precedence remain in that reader.
- SVG must be unambiguous UTF-8, optionally with a leading UTF-8 BOM. The supported declaration subset is XML 1.0,
  optionally naming UTF-8 and standalone status. NULs, malformed encodings, and DOCTYPE or ENTITY declaration tokens
  are rejected before native initialization. Tokens quoted in comments or CDATA are conservatively rejected too;
  this guard is not a general XML sanitizer.
- The native worker forces MSVG, bounds the image before allocation where possible, fully decodes the first frame,
  and requires warning-free pixel access. SVG keeps transparent pixels, strips nonpixel metadata, and uses fixed PNG
  output settings. Only IHDR, PLTE, tRNS, IDAT, and terminal IEND chunks are admitted.
- SVG alone adds the studied private scratch-path read, MVG read, trusted minimal colors configuration, and PNG
  read/write permission for public in-memory encoding. Raster validation keeps its read-only policy. Delegates,
  filters, arbitrary paths, and path writes remain denied.
- The PNG callback checks the captured output allowance and copies native bytes before their SDK buffer is disposed.
  The owner validates the tagged, source-bound response and snapshots the admitted extent before awaiting worker
  termination. SVG cannot return an `original` result or fall back to source XML after an operational failure.
- Source extension and prepared extension/MIME are distinct fields. Consumers charge the actual published byte length.
  Image-only reads validate the source binding and the prepared format's signature.

The existing owner allows two active jobs and eight queued jobs, uses a five-second timeout, and keeps the existing
native limits and worker V8 limits. Cancellation wins over a result received while teardown is pending. A failed
termination blocks publication; its rejection alone does not prove heap reclamation. Native encoding can allocate
before the encoded length is known, so these bounds are not an absolute RSS guarantee.

## Validation

Build the worker from the current source before running the real-codec tests:

```sh
pnpm bundle
pnpm --dir src test core/tools/helpers/__tests__/imageHelpers.validation.spec.ts
pnpm --dir src test core/tools/helpers/__tests__/imageHelpers.svg-preparation.spec.ts
pnpm --dir src test workers/__tests__/validateImage.svg-preparation.spec.ts
pnpm --dir src test core/tools/helpers/__tests__/imageHelpers.prepared-protocol.spec.ts
pnpm --dir src check-types
```

The affected consumer coverage also includes bounded reads, decoder lifecycle, read-file image-only validation,
view-image receipts, local mention budgets, provider/history media projections, MCP results, and deferred media.
Keep the existing exact PNG/GIF byte checks, controlled cancellation barriers, actual SVG pixels/transparency,
metadata exclusions, output-budget checks, and calibrated native path-denial controls.

Production packaging may rebuild and minify the worker. Record its new bytes and rerun actual-codec checks against
that output before relying on development-build evidence. Packaging verification and the exact VS Code 1.125.0
host gate remain separate obligations under the repository guide.
