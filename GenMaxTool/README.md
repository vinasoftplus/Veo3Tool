# GenMaxTool

Python GUI tool for GenMax API.

## Run

```powershell
cd GenMaxTool
python -m pip install -r requirements.txt
python genmax_tool.py
```

## Batch Text To Speech TXT format

Each non-empty line:

```text
output_file_name|Character name|Text to convert
```

Example:

```text
intro|Alice|Hello world
line_002|Bob|Another sentence
```

Configure character voices in the **TTS Batch** tab. If a character is not found, the default voice settings are used.

## Voice/model settings

In **TTS Batch > Settings**:

- Choose `ElevenLabs` or `MiniMax`.
- Click **Select Voice** to open the filterable voice browser, then double-click or press **Use selected**.
- Click **Select Model** to load models for the current provider and choose one.
- Click **Load** beside language to fetch language options for the current provider.
- Use **Play preview** in the voice browser when the API returns a preview URL.

## GenMax docs covered

Base URL: `https://api.genmax.io`

Authentication for API features: `xi-api-key: YOUR_API_KEY`

Implemented endpoint groups:

- Text to speech: `/v1/text-to-speech/{voice_id}`, `/v1/history`, `/v1/history/{id}`, retry/delete
- Dialogue: `/v1/dialogue`
- ElevenLabs voices: `/v1/shared-voices`, `/v1/default-voices`
- MiniMax voices: `/v1/minimax/system-voices`, cloned voice list/clone/retry/delete
- Models: `/v1/models`
- Languages: `/v1/languages`
- Speech to text: `/v1/speech-to-text`
- Voice changer: `/v1/voice-changer` and related history/retry/delete
- Dubbing: `/v1/dubbing` and related history/retry/delete
- Generic API tab for any documented endpoint
