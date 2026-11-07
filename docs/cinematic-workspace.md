# Cinematic Workspace

Start the source application normally, then visit `/cinematic` on its local address. The original studio remains at `/`.

## Plan a project

1. Choose music video or short film, 16:9 or 9:16, and a visual preset.
2. Enter your lyrics/script and global continuity notes.
3. Add characters with identity, wardrobe and reference notes.
4. Append one draft scene per nonempty paragraph or add scenes manually. This is a text split, not AI storyboarding or audio alignment.
5. Edit action, location, camera and continuity; select the cast for each scene. Reorder scenes as needed.
6. Set planned durations. Mark timing verified only after checking it against source audio.
7. Save the project. Export JSON for backup/import, CSV for editing, or Markdown for copy-ready image/video prompts.

Prompt overrides replace the assembled preset/character/scene prompt completely. Leave them blank to use the assembled prompt. Reference filenames, URLs and asset notes are planning metadata; they do not attach images to provider requests.

## Prepare generation

Select scenes and export an image, text-to-video or image-to-video workflow graph. Export does not generate media or spend credits. Submit the graph using the existing application endpoint:

`POST /api/workflow/run`, with the current `X-App-Token` header and JSON body `{"workflow": <exported graph>}`.

Poll `/api/workflow/status/{job_id}`. Check each entry under `job.outputs.node_outputs` for errors: the upstream runner may mark the overall job done even if a node failed. Export only failed scenes to prepare a retry. Rendered assets are not automatically imported into this workspace; record your chosen asset paths or URLs in each scene.

For image-to-video, upload the chosen keyframe with the existing `/api/workflow/upload-image` tools and enter the returned provider `media_id` in the scene. Identity descriptions alone cannot guarantee identical faces.

Video workflow exports conservatively require 8-second clips, matching the inspected adapter default. Other planned durations must be split or trimmed. Frames supported here are 16:9 and 9:16; make a 2.39:1 delivery crop during editing if needed.

## Persistence and access

Projects are JSON files under `data/cinematic_projects`. Back them up using project export. Designed for one local editor: simultaneous saves of the same project in multiple tabs can overwrite one another.

API routes are under `/api/workflow/cinematic`, preserving the existing token and license checks. Original license and provider access requirements still apply.

## Validation

Run `python -m unittest discover -s tests -p test_cinematic.py -v` and `node --check static/js/cinematic.js`.

Eight backend tests and JavaScript syntax validation passed in the available FastAPI 0.141.1 / Pydantic 2.13.4 environment. The upstream pinned environment, complete application startup and live generation were not tested. Browser testing was blocked by this execution environment's Chromium process-socket restriction; visual and interaction QA remains required in the installed application.
