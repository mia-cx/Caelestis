# Share images

The frontend serves Open Graph and Twitter summary card metadata in the initial HTML.
Home and folder links use `apps/frontend/static/social/site.png`. On first access, a published
template gets an artwork GIF stored in object storage. The backend's daily refresh renders its
history and replaces that object. Requests keep serving the stored GIF during refreshes, including
across artwork updates. The site image remains a fallback if storage or initial generation is unavailable.

Every backend owns its refresh, using the renderer in `packages/social`:

- **Cloudflare:** the `37 7 * * *` cron queues each published template on `SOCIAL_REFRESH`. The
  backend Worker's Queue consumer renders one template per invocation, reading its own API
  in-process, and writes to `BLOBS`. A failed render throws, so the queue retries it.
- **Docker and Helm:** a durable daily wakeup renders every template in a backend worker thread,
  which reads the backend over loopback with its private read token.

Render locally without uploading:

```sh
pnpm --filter @caelestis/social... build
node scripts/social-images.mjs --site http://localhost:5173 --template TEMPLATE_ID
```

Use an isolated fixture server for development. Reading production or passing `--publish` requires
the operator's explicit authorization. The output defaults to `.scratch/social-images`.

To refresh the running development frontend's local R2 binding:

```sh
node scripts/social-images.mjs --site http://127.0.0.1:5173 --template TEMPLATE_ID --publish --local
```

Full history renders in the refresh, outside frontend request limits. Frames stream into the encoder,
so a render holds a few frames rather than all 301 and fits a Worker's 128 MB. Failed refreshes retain
the previous object. Conditional writes prevent a first-image request from replacing an existing GIF.

GIFs use the viewer's 16:9 capture bounds and native pixel sampling. History plays for ten seconds,
followed by five seconds on the latest state. Up to 300 historical frames keep playback within 30 fps.
Large captures use fewer frames to keep source image reads and decodes within 4,096 per template,
including the final state. Both history endpoints remain present.
GIF timing distributes 10 ms ticks across the history, preserving its duration even if size limits
require fewer frames. Without history, the GIF holds only the latest state.
Unchanged history frames share their playback delay. Later frames preserve unchanged pixels through
GIF transparency, with an explicit five-second final hold. Dimensions remain 640x360; changed pixels
retain the existing 128-color quantization. See [the benchmark and samples](../docs/timelapse-gif-size.md)
for measured sizes and encoder tradeoffs.
Real OpenStreetMap tiles remain visible through transparent and
unobserved canvas pixels. Every frame includes map attribution. Servers cache map tiles in object
storage under `social/osm/`; the CLI uses `.scratch/social-images/.osm`. All cache for seven days
and identify the renderer in tile requests. Finished templates end at their archived history.
Imported observations join native history, with native buckets taking precedence and missing coverage
revealing the map. Before observations exist, the stored first GIF shows the template artwork.
The renderer reduces the frame count if needed to stay below 4.5 MB. A template failure preserves
its previous image, lets other templates finish, and reports the failure.

Each season and template has one replaceable object under `social/v2/`. The CLI skips uploading
byte-identical outputs. Metadata uses the object's ETag as its image URL version. The serving route
checks the current manifest, so old links cannot retrieve deleted or unpublished template images.
Already copied images in Discord or other platforms remain subject to those platforms' caching.
Animation and autoplay depend on the receiving platform and the reader's settings.

Validate the deployed template URL in Discord before claiming animated unfurl support. Local HTML
and GIF checks cannot prove what Discord's crawler and client will display. Twitter receives the
same GIF as `twitter:image`; a platform that uses only its first frame gets the earliest sampled state.

Regenerate the committed site PNG after editing its SVG:

```sh
node --input-type=module -e 'import sharp from "sharp"; await sharp("apps/frontend/static/social/site.svg").png().toFile("apps/frontend/static/social/site.png")'
```
