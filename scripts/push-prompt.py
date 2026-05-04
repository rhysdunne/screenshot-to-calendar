#!/usr/bin/env python3
"""Injects prompts/extract-event.md into nodes/prepare-vision-request.js
(replacing {{PROMPT}}) and writes the result to stdout."""
import sys

prompt = open('prompts/extract-event.md').read()
js = open('nodes/prepare-vision-request.js').read()

if '{{PROMPT}}' not in js:
    sys.stderr.write('Error: {{PROMPT}} placeholder not found in nodes/prepare-vision-request.js\n')
    sys.exit(1)

sys.stdout.write(js.replace('{{PROMPT}}', prompt))
