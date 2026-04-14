"""
Fix multi-layer mis-encoded UTF-8 in index.html.
Works on decoded unicode string, char by char, finding sequences of
latin-1/cp1252 encodable chars that form valid UTF-8 when treated as bytes.
Applies recursively until stable.
"""
import sys, io, subprocess

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

CP1252_MAP = {
    '\u20ac': 0x80, '\u201a': 0x82, '\u0192': 0x83, '\u201e': 0x84,
    '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87, '\u02c6': 0x88,
    '\u2030': 0x89, '\u0160': 0x8a, '\u2039': 0x8b, '\u0152': 0x8c,
    '\u017d': 0x8e, '\u2018': 0x91, '\u2019': 0x92, '\u201c': 0x93,
    '\u201d': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
    '\u02dc': 0x98, '\u2122': 0x99, '\u0161': 0x9a, '\u203a': 0x9b,
    '\u0153': 0x9c, '\u017e': 0x9e, '\u0178': 0x9f,
}

def char_to_byte(c):
    code = ord(c)
    if c in CP1252_MAP:
        return CP1252_MAP[c]
    if code <= 0xFF:
        return code
    return None

def fix_pass(text):
    """One pass: find maximal sequences of high-byte latin1/cp1252 chars,
    try to decode them as UTF-8, replace if successful."""
    result = []
    i = 0
    chars = list(text)
    n = len(chars)
    changed = False

    while i < n:
        b = char_to_byte(chars[i])
        if b is not None and b >= 0x80:
            # Collect sequence of encodable-as-single-byte chars
            j = i
            while j < n and char_to_byte(chars[j]) is not None:
                j += 1
            segment = chars[i:j]

            # Build byte array
            bs = bytearray(char_to_byte(c) for c in segment)

            # Try to decode as UTF-8
            try:
                decoded = bs.decode('utf-8')
                if decoded != ''.join(segment):
                    result.append(decoded)
                    changed = True
                else:
                    result.extend(segment)
            except UnicodeDecodeError:
                # Not valid UTF-8 as a whole — try to decode valid prefix/suffix
                # Fall back: keep as-is
                result.extend(segment)
            i = j
        else:
            result.append(chars[i])
            i += 1

    return ''.join(result), changed

# Load original from git
result = subprocess.run(['git', 'show', 'HEAD:templates/index.html'], capture_output=True)
if result.returncode != 0:
    print('ERROR:', result.stderr.decode())
    sys.exit(1)

raw = result.stdout
if raw[:3] == b'\xef\xbb\xbf':
    raw = raw[3:]

text = raw.decode('utf-8')
print(f'Input: {len(text)} chars, Ã count: {text.count(chr(0xC3))}')

for i in range(10):
    fixed, changed = fix_pass(text)
    print(f'Pass {i+1}: {len(fixed)} chars, Ã count: {fixed.count(chr(0xC3))}, changed: {changed}')
    text = fixed
    if not changed:
        break

# Verify
checks = [
    'Kết quả', 'Kích hoạt', 'Nhập license key', 'Video đồng nhất',
    'phụ đề', 'Tạo ảnh', 'Lấy/Chèn'
]
print('\nVerification:')
for p in checks:
    print(f'  {p}: {p in text}')

with open('templates/index.html', 'w', encoding='utf-8') as f:
    f.write(text)
print('\nWritten OK')
