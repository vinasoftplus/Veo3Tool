Act as a Creative Director, Lead 3D Animator, and Data Architect for a heartwarming 3D animated feature "[SERIES_NAME]".

Your task is to generate a bulletproof video production plan in a **DUAL FORMAT** (Part 1: Production Header, Part 2: JSON Array).

### MISSION & BATCH LOGIC:
* **TOTAL DURATION TARGET:** [INSERT TARGET DURATION]
* **CURRENT DELIVERY:** Generate ONLY exactly [INSERT SCENE COUNT] SCENES per prompt.
* **PROGRESS TRACKING:** [INSERT BATCH / CONTINUATION RULE]
* **TOTAL BATCHES:** [INSERT BATCH PLAN]

### GLOBAL CONSTRAINTS & BRAND SAFETY PROTOCOL:
1. **LANGUAGE:** Strictly **ENGLISH ONLY**.
2. **JSON STRUCTURE:** Use the EXACT JSON schema provided below. Do NOT add, remove, or rename any keys.
3. **SAFETY POLICY:** [INSERT SAFETY RULES]
4. **NO TRADEMARKS:** [INSERT IP / BRAND RESTRICTIONS]
5. **EMOTIONAL CORE (CRITICAL):** [INSERT CORE EMOTIONAL RULE]
6. **NO HUMANS:** Absolutely no humans, no human-like people, no human faces, no human hands, no human bodies, no human silhouettes, and no human photos or human figures anywhere in any scene or prompt.
7. **NO TEXT ON SCREEN:** Do not generate visible text, captions, signage, labels, logos, subtitles, letters, or written elements inside the image content.
8. **NO DIALOGUE / NO VOICEOVER:** Do not include spoken dialogue, narration, or character speech. All storytelling must be visual only.

### CAMERA, MOTION & TIMING:
* **GOLDEN RULE:** [INSERT CINEMATIC MOTION RULE]
* **HIGH TENSION / ACTION:** [INSERT DURATION + MOVEMENT + CAMERA RULE]
* **TENDER / EMOTIONAL:** [INSERT DURATION + MOVEMENT + CAMERA RULE]
* **WONDER / ESTABLISHING:** [INSERT DURATION + MOVEMENT + CAMERA RULE]
* **CINEMATOGRAPHY:** [INSERT SHOT VARIETY RULES]

### ASSET BIBLE & 3D STYLE GUIDE:
* **VISUAL STYLE:** [INSERT VISUAL STYLE]
* **SHADERS & TEXTURES:** [INSERT SHADER / TEXTURE RULES]
* **LIGHTING & RENDERING:** [INSERT LIGHTING RULES]
* **ANIMATION STYLE:** [INSERT ANIMATION RULES]

### NARRATIVE STYLE:
* **CORE THEME:** [INSERT CORE THEME]
* **EMOTIONAL ARC TEMPLATE:**
  1. [STEP 1]
  2. [STEP 2]
  3. [STEP 3]
  4. [STEP 4]
  5. [STEP 5]
  6. [STEP 6]
* **DUAL-EMOTION STORYTELLING:** [INSERT TONE RULES]
* **THE NARRATOR:** None. No narrator, no voiceover, no spoken lines.

### CHARACTER VISUAL DATABASE:
**CASTING RULE:** [INSERT CASTING LIMIT / ON-SCREEN RULE]

(Use these EXACT descriptions strictly in the `prompt` fields. Use ONLY Code Names in `prompt` fields.)

1. **Code: [CHARACTER_CODE_1] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"
2. **Code: [CHARACTER_CODE_2] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"
3. **Code: [CHARACTER_CODE_3] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"
4. **Code: [CHARACTER_CODE_4] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"
5. **Code: [CHARACTER_CODE_5] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"
6. **Code: [CHARACTER_CODE_6] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"
7. **Code: [CHARACTER_CODE_7] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"
8. **Code: [CHARACTER_CODE_8] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"

### WORLD & LOCATION BIBLE:
Define locations once, then reuse exactly.

* **[LOCATION_CODE_1]:** "[INSERT LOCKED LOCATION DESCRIPTION]"
* **[LOCATION_CODE_2]:** "[INSERT LOCKED LOCATION DESCRIPTION]"
* **[LOCATION_CODE_3]:** "[INSERT LOCKED LOCATION DESCRIPTION]"
* **[LOCATION_CODE_4]:** "[INSERT LOCKED LOCATION DESCRIPTION]"
* **[LOCATION_CODE_5]:** "[INSERT LOCKED LOCATION DESCRIPTION]"
* **[LOCATION_CODE_6]:** "[INSERT LOCKED LOCATION DESCRIPTION]"

### LOGIC RULES & NARRATIVE STRUCTURE:
1. **CASTING:** [INSERT CASTING RULE]
2. **SEGMENTS PER BATCH:** [INSERT SEGMENT COUNT]
3. **TOTAL SCENES:** [INSERT TOTAL SCENE COUNT]
4. **FULL STORY STRUCTURE:**
   * **Scenes [RANGE 1]:** [INSERT STORY FUNCTION]
   * **Scenes [RANGE 2]:** [INSERT STORY FUNCTION]
   * **Scenes [RANGE 3]:** [INSERT STORY FUNCTION]
   * **Scenes [RANGE 4]:** [INSERT STORY FUNCTION]
   * **Scenes [RANGE 5]:** [INSERT STORY FUNCTION]
5. **CONTINUITY:** [INSERT CONTINUITY RULE]
6. **ANTI-REPETITION:** [INSERT ANTI-REPETITION RULE]
7. **PLATFORM SAFETY:** [INSERT PLATFORM / CONTENT RESTRICTIONS]

### OUTPUT FORMAT (STRICT ORDER):

**PART 1: PROJECT FOUNDATION HEADER**
* **SERIES TITLE:** [INSERT EPISODE TITLE]
* **BATCH PROGRESS:** [INSERT CURRENT BATCH STATUS]
* **CAST:** [INSERT CODE NAMES + ROLES]
* **EMOTIONAL CORE:** [INSERT 1-SENTENCE ARC SUMMARY]
* **LOCATIONS LOCKED:** [INSERT LOCKED LOCATIONS USED]

**PART 2: SCRIPT DATA (JSON ARRAY)**
Output a single JSON Array `[...]` containing exactly [INSERT COUNT] segment objects. Use this schema strictly:

```json
[
  {
    "description": "[INSERT SCENE DESCRIPTION]",
    "characters": {
      "main": "[Code Name] - [Database Description]",
      "others": [
        "[Code Name 1]",
        "[Code Name 2]"
      ]
    },
    "style": "[INSERT STYLE STRING]",
    "sfx": "[INSERT NON-VERBAL SFX / AMBIENCE / MUSIC ONLY]",
    "background": "[INSERT LOCKED LOCATION DESCRIPTION]",
    "prompt": "Priority: Strictly follow the official character references and preserve exact character design consistency. Absolutely no humans, no human-like people, no human faces, no human hands, no human bodies, no human silhouettes, and no human photos or human figures anywhere in the frame. No visible text, no captions, no labels, no signage, no logos, no subtitles, no letters, and no written elements inside the image. [INSERT FULL IMAGE PROMPT]",
    "scene_index": [INSERT INTEGER],
    "duration_seconds": "[INSERT INTEGER OR RULE-BASED VALUE]",
    "shot": {
      "camera": "[INSERT CAMERA TYPE]",
      "lens": "[INSERT LENS]",
      "movement": "[INSERT MOVEMENT]",
      "composition": "[INSERT COMPOSITION]"
    },
    "action": "[INSERT ACTION SUMMARY]",
    "negative": "[INSERT NEGATIVE PROMPT, including humans, human-like figures, text, letters, subtitles, logos, signage, watermarks, and dialogue indicators]",
    "attachments": {
      "characters": [
        "[Code Name 1]",
        "[Code Name 2]"
      ],
      "items": [
        "[INSERT PROP 1]",
        "[INSERT PROP 2]"
      ],
      "backgrounds": [
        "[INSERT BACKGROUND ASSET NAME]"
      ]
    }
  }
]
```

Do not output any narration script, dialogue, subtitle text, or voiceover text.
