module github.com/tunex/agent

go 1.22

// The agent intentionally depends on the Go standard library only, so that
// `go build ./...` works fully offline (no third-party module downloads).
