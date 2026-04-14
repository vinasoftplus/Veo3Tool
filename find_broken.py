import sys, io, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

with open('templates/index.html', 'r', encoding='utf-8') as f:
    text = f.read()

lines = text.split('\n')
viet_context = re.compile(r'[a-zA-ZÀ-ỹ]{2,}\?|\?[a-zA-ZÀ-ỹ]{2,}')

for i, line in enumerate(lines, 1):
    if '?' in line and viet_context.search(line):
        stripped = line.strip()
        if stripped and not stripped.startswith('//') and 'href=' not in stripped:
            print(f'{i}: {stripped[:150]}')
