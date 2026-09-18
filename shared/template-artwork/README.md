# Template artwork

30 original PNG photographs cover all 20 image, video, and slideshow categories.
Generated using the built-in imagegen tool. No fal.ai API or project generation key was used.
Video and slideshow assets here are still cover images.

Open `index.html` for the category gallery. Images are stored under `image/`, `video/`,
and `slideshow/`, with a subfolder for each category. `prompts.json` records the full
generation prompts; `manifest.json` maps the image files to stable template IDs.

The mobile app loads published images and prompts dynamically from the backend, and
bundles these files for initial/offline catalog display. The backend serves images at
`/seed-assets/template-<id>.png`, using verified R2 copies when installed, and local
files otherwise. Custom image URLs set in the admin continue to override the bundled artwork.

To install on another configured backend, with the backend stopped:

```sh
cd backend
npm run templates:install
```

This uploads and verifies artwork in R2, then updates published and draft template
images independently. It adds missing default templates, including Animal, and keeps
other edits, prompts, and settings. It saves a content backup under `backend/data/backups/`
and creates an auditable revision when published content changes. Repeating the command
verifies existing uploads and does not create duplicate templates or revisions.
It does not start the backend or generation worker or call an image/video provider.
