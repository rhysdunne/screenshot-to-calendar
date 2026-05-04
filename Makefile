SCRIPTABLE_DIR := $(HOME)/Library/Mobile Documents/iCloud~dk~simonbs~Scriptable/Documents
N8N_BASE_URL := http://localhost:5678

-include .env
export

.PHONY: deploy up down logs pull push

deploy:
	cp scriptable/screenshot-to-calendar.js "$(SCRIPTABLE_DIR)/screenshot-to-calendar.js"
	@echo "Copied to Scriptable iCloud folder — sync to iPhone may take a few seconds."

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

pull:
	@test -n "$(N8N_API_KEY)" || (echo "N8N_API_KEY not set in .env"; exit 1)
	@test -n "$(N8N_WORKFLOW_ID)" || (echo "N8N_WORKFLOW_ID not set in .env"; exit 1)
	curl -s $(N8N_BASE_URL)/api/v1/workflows/$(N8N_WORKFLOW_ID) \
	  -H "X-N8N-API-KEY: $(N8N_API_KEY)" | \
	  jq '{name, nodes, connections, settings, staticData}' > n8n/workflow.json
	jq -r '.nodes[] | select(.name == "Prepare Vision Request") | .parameters.jsCode' \
	  n8n/workflow.json > n8n/nodes/prepare-vision-request.js
	python3 n8n/scripts/pull-prompt.py > n8n/prompts/extract-event.md
	@echo "Workflow saved to n8n/workflow.json"
	@echo "Prompt extracted to n8n/prompts/extract-event.md"

push:
	@test -n "$(N8N_API_KEY)" || (echo "N8N_API_KEY not set in .env"; exit 1)
	@test -n "$(N8N_WORKFLOW_ID)" || (echo "N8N_WORKFLOW_ID not set in .env"; exit 1)
	@tmpjs=$$(mktemp) && \
	  python3 n8n/scripts/push-prompt.py > $$tmpjs && \
	  jq --rawfile nodecode $$tmpjs \
	    '{name, nodes: [.nodes[] | if .name == "Prepare Vision Request" then .parameters.jsCode = ($$nodecode | rtrimstr("\n")) else . end], connections, settings: (.settings | del(.availableInMCP, .timeSavedMode)), staticData}' \
	    n8n/workflow.json | \
	  curl -s -X PUT $(N8N_BASE_URL)/api/v1/workflows/$(N8N_WORKFLOW_ID) \
	    -H "X-N8N-API-KEY: $(N8N_API_KEY)" \
	    -H "Content-Type: application/json" \
	    -d @- | jq . && \
	  rm $$tmpjs
	@echo "Workflow deployed to n8n"
