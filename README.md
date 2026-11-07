# Veo3Tool — Cinematic Workspace

A local workspace for planning cinematic music videos and short films, adapted from [haorrr/Veo3Tool](https://github.com/haorrr/Veo3Tool).

Organize scripts, character continuity, numbered scenes, and image/video prompts in one project. Export your plans and prepare scene jobs for the existing generation engine.

**Workflow:** Script → Characters → Scene board → Image prompts → Video prompts → Production exports

> The cinematic workspace currently plans projects and exports generation jobs. It does not automatically render a complete film, synchronize scenes to audio, or import generated media.

## Features

- **Project planning:** music-video and short-film projects, lyrics/scripts, and global continuity notes.
- **Character continuity:** identity descriptions, apparent age, wardrobe, reference notes, and per-scene cast selection.
- **Scene board:** numbered scenes, reordering, action, location, camera direction, and transition/continuity notes.
- **Timing:** planned durations with separate draft and verified labels.
- **Prompt preparation:** assembled image/video prompts with editable overrides.
- **Project management:** save, reopen, import, and export projects.
- **Generation handoff:** export selected scenes as image, text-to-video, or image-to-video workflow graphs.

### Visual presets

| Preset | Direction |
| --- | --- |
| Cinematic realism | Natural skin, motivated practical lighting, gentle haze, and an ARRI Alexa 35 / Sony Venice 2 inspired look |
| Vietnam 1990s | Period wardrobe and environments, warm amber lighting, muted cyan shadows, and analog film texture |
| Nostalgic MV | Romantic late-1980s / 1990s atmosphere, amber/cyan lighting, soft halation, and expressive close-ups |

Camera and film references are prompt directions, not claims about the equipment used to generate images.

## Getting started

### 1. Clone your fork

```sh
git clone https://github.com/vinasoftplus/Veo3Tool.git
cd Veo3Tool
```

### 2. Create a Python environment

The source uses Python 3.10+ syntax. Use an environment compatible with the dependencies in [requirements.txt](requirements.txt); the full application has not yet been verified across Python versions or operating systems.

**Windows PowerShell:**

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Using the environment's Python directly avoids needing to activate it.

### 3. Start the browser interface

From the repository root:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app:create_app --factory --host 127.0.0.1 --port 8765
```

Then open:

- **Cinematic workspace:** http://127.0.0.1:8765/cinematic
- **Original studio:** http://127.0.0.1:8765/

Keep the terminal running while you use the app. Press `Ctrl+C` to stop it.

For an existing configured environment, use its Python executable with the same Uvicorn command.

### Optional desktop launcher

The upstream desktop entry point is:

```powershell
.\.venv\Scripts\python.exe main.py
```

It uses PyWebView and platform-specific desktop components. The launcher also attempts to terminate processes listening on port 8765 on Windows; use the browser startup command above when you want to avoid that behavior.

### Provider and application access

The original application's license checks and provider configuration still apply. Configure the required access through the original studio before using protected project APIs or generation features.

The cinematic add-on does not supply a license, API credentials, provider subscriptions, or generation credits. Actual generation may consume provider credits.

## Create your first cinematic project

1. Open **Cinematic Workspace** and choose **New project**.
2. Enter a title, project type, frame format, and visual preset.
3. Paste your lyrics or script and add global continuity notes.
4. Add characters with identity and wardrobe descriptions.
5. Choose **Append scenes from paragraphs** or add scenes manually.
6. Refine each scene's action, cast, location, camera, duration, and continuity.
7. Save the project, then export your shot list, prompts, or generation workflow.

Appending scenes creates one draft scene per nonempty paragraph. It does not interpret story beats or measure audio timing.

Only mark timing **verified** after checking it against your source audio or edit.

### Character references and prompt overrides

Reference filenames and URLs are planning notes. They are not automatically uploaded or attached to generation requests.

Leave prompt overrides blank to assemble prompts from the preset, selected characters, and scene notes. An override replaces the assembled prompt completely, so include any identity and continuity instructions you still need.

Identity descriptions can help maintain consistency, but do not guarantee identical faces across generated shots.

## Exports

| Export | Purpose |
| --- | --- |
| Project JSON | Back up a project or import it as a new project |
| Shot list CSV | Review scene numbers, planned timing, prompts, and asset references |
| Prompt Markdown | Copy-ready image and video prompts for each scene |
| Generation workflow JSON | Prepare selected scenes for the existing workflow runner |

### Generation handoff

Choose scenes and a generation stage, then select **Export generation workflow**. Exporting alone makes no provider calls.

To run a graph, submit it through the existing `POST /api/workflow/run` endpoint, wrapped as the `workflow` property and using the application's current `X-App-Token` header. Poll `/api/workflow/status/{job_id}` for results.

Check every entry in `job.outputs.node_outputs` for errors: the upstream runner may report the overall job as done even if individual nodes failed. Select only failed scenes when preparing a retry.

For image-to-video, upload the chosen keyframe with the existing `/api/workflow/upload-image` tools and enter its returned provider `media_id` in the scene.

See the [detailed cinematic workflow guide](docs/cinematic-workspace.md) for usage and limitations.

## Current limitations

- Supported workspace frames are **16:9** and **9:16**. Make a 2.39:1 delivery crop during editing if needed.
- Video graph exports currently require **8-second clips**. Other planned durations must be split or trimmed.
- Generated assets are not automatically imported into the scene board; record chosen filenames or URLs manually.
- No automatic audio alignment, full-film assembly, or image-based identity verification is included.
- Designed for one local editor. Concurrent saves of the same project in multiple tabs can overwrite changes.

## Project storage

Projects are stored as JSON files in `data/cinematic_projects/`. Use **Project JSON** to back up your work.

Keep private scripts, reference assets, account settings, cookies, tokens, and generated project data out of public commits.

## Development checks

With the project dependencies installed:

```sh
python -m unittest discover -s tests -p test_cinematic.py -v
```

With Node.js available:

```sh
node --check static/js/cinematic.js
```

Eight cinematic backend tests and JavaScript syntax validation passed during development. Backend tests used FastAPI 0.141.1 and Pydantic 2.13.4 in the available environment, rather than the complete upstream pinned environment.

Full application startup, browser interaction, and live provider generation remain unverified.

### Cinematic workspace files

| Path | Role |
| --- | --- |
| `routers/cinematic.py` | Project validation, persistence, prompts, and exports |
| `routers/ui.py` | Workspace page and router integration |
| `templates/cinematic.html` | Workspace interface |
| `static/js/cinematic.js` | Scene editing and project actions |
| `tests/test_cinematic.py` | Backend tests |
| `docs/cinematic-workspace.md` | Detailed workflow guide |

## Attribution and licensing

This fork builds on [haorrr/Veo3Tool](https://github.com/haorrr/Veo3Tool). Credit for the original application belongs to its original contributors.

This README does not grant a license to upstream code or change the original application's license enforcement. Confirm applicable permissions before redistributing a modified application.
