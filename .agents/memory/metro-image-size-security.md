---
name: Metro image-size security compatibility
description: Why Metro uses a bounded local image-size compatibility shim rather than the current upstream package.
---

Use the bounded local image-size compatibility implementation for Metro until the upstream package publishes a version that is both security-fixed and compatible with Metro’s default callable API.

**Why:** The current upstream release remains listed for the image-size parser CVE, while its 2.x default export breaks Metro’s normal file-path asset flow. Metro only needs dimension extraction for its documented raster and SVG asset formats, so a bounded parser that rejects malformed and unsupported input is safer than retaining the vulnerable transitive package or upgrading into a broken bundle.

**How to apply:** When upgrading Expo or Metro, test asset bundling with file-path and buffer inputs before removing the override. Replace the shim only when the upstream release clears the advisory and preserves Metro’s callable `image-size(pathOrBuffer)` contract.