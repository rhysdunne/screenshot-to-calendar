#!/usr/bin/env python3
"""Extracts the promptTemplate content from nodes/prepare-vision-request.js
to stdout, then replaces it with the {{PROMPT}} placeholder in the JS file."""
import re, sys

path = 'nodes/prepare-vision-request.js'
code = open(path).read()

m = re.search(r'const promptTemplate = `(.*?)`;', code, re.DOTALL)
if not m:
    sys.stderr.write(f'Error: promptTemplate not found in {path}\n')
    sys.exit(1)

sys.stdout.write(m.group(1))

placeholder = code[:m.start(1)] + '{{PROMPT}}' + code[m.end(1):]
open(path, 'w').write(placeholder)
