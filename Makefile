.PHONY: build test vet fmt run run-ui

build:
	CGO_ENABLED=0 go build -o bin/cue-note-server ./cmd/server
	CGO_ENABLED=0 go build -o bin/cue-note-ui ./cmd/webui

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -l -w .

run: build
	./bin/cue-note-server

run-ui: build
	./bin/cue-note-ui
