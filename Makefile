# Roughdraft dev tasks.
#
# This Makefile is the explicit, reviewable surface of commands the agent runs.
# Allow `Bash(make:*)` once and every target here runs without a prompt, while
# you keep full control by editing the targets below.
#
# NODE_OPTIONS note: the local Node (22.7.0) needs --experimental-require-module
# for jsdom-based vitest runs; the test targets set it for you.

NODE_TEST_OPTIONS := NODE_OPTIONS=--experimental-require-module
WORKTREE_ROOT := $(shell git rev-parse --show-toplevel)
RD := roughdraft-dev-$(notdir $(WORKTREE_ROOT))

.DEFAULT_GOAL := help

.PHONY: help
help: ## List available targets
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# --- Install / build ---------------------------------------------------------

.PHONY: install
install: ## Install workspace dependencies
	pnpm install

.PHONY: build
build: ## Build rfm, app, and server
	pnpm build

.PHONY: build-global
build-global: build ## Build and restart the global roughdraft server
			-roughdraft stop
			roughdraft start

# --- Quality gates -----------------------------------------------------------

.PHONY: check
check: ## Full check: lint, selectors, unit tests, build
	$(NODE_TEST_OPTIONS) pnpm check

.PHONY: lint
lint: ## Lint with biome
	pnpm lint

.PHONY: fmt
fmt: ## Auto-format and apply safe lint fixes
	pnpm lint:fix

.PHONY: typecheck
typecheck: ## Type-check the app package
	$(NODE_TEST_OPTIONS) pnpm --filter @roughdraft/app exec tsc --noEmit

# --- Tests -------------------------------------------------------------------

.PHONY: test
test: ## Run all unit tests (rfm + app + server)
	$(NODE_TEST_OPTIONS) pnpm test

.PHONY: test-app
test-app: ## Run app unit tests (pass T="name" to filter)
	$(NODE_TEST_OPTIONS) pnpm --filter @roughdraft/app exec vitest run $(if $(T),-t "$(T)",)

.PHONY: test-server
test-server: ## Run server unit tests (pass T="name" to filter)
	$(NODE_TEST_OPTIONS) pnpm --filter @roughdraft/server exec vitest run $(if $(T),-t "$(T)",)

.PHONY: smoke
smoke: ## Run @smoke Playwright tests (pass G="grep" to narrow)
	pnpm exec playwright test --config packages/app/playwright.config.ts --grep "$(if $(G),$(G),@smoke)"

.PHONY: e2e
e2e: ## Run the full Playwright e2e suite
	pnpm test:e2e

# --- Roughdraft dev CLI ------------------------------------------------------

.PHONY: rd-start
rd-start: ## Start the worktree dev server
	"$(RD)" start

.PHONY: rd-stop
rd-stop: ## Stop the worktree dev server
	"$(RD)" stop

.PHONY: rd-status
rd-status: ## Show dev server status
	"$(RD)" status

.PHONY: rd-open
rd-open: ## Open a file or directory in Roughdraft (PATH=/abs/path)
	@test -n "$(PATH_)" || { echo "Usage: make rd-open PATH_=/abs/path"; exit 2; }
	"$(RD)" open "$(PATH_)"

# --- Git (read-only) ---------------------------------------------------------

.PHONY: status
status: ## Show working tree status (short)
	git status --short

.PHONY: diff
diff: ## Show diff (F=path to scope, default unstaged tree)
	git diff $(F)

# --- API smoke ---------------------------------------------------------------

.PHONY: api-files
api-files: ## Fetch a file via the running dev server (P=relative/path)
	@test -n "$(P)" || { echo "Usage: make api-files P=relative/path"; exit 2; }
	curl -s "http://localhost:7373/api/files?projectPath=$(WORKTREE_ROOT)&path=$(P)"
