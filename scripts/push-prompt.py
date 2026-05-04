#!/usr/bin/env python3
"""Injects n8n/prompts/extract-event.md into n8n/nodes/prepare-vision-request.js
(replacing {{PROMPT}}) and writes the result to stdout."""
import sys

prompt = open('n8n/prompts/extract-event.md').read()
js = open('n8n/nodes/prepare-vision-request.js').read()

if '{{PROMPT}}' not in js:
    sys.stderr.write('Error: {{PROMPT}} placeholder not found in n8n/nodes/prepare-vision-request.js\n')
    sys.exit(1)

sys.stdout.write(js.replace('{{PROMPT}}', prompt))
