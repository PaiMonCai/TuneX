// Package logx is a tiny leveled logger for the agent.
//
// It mirrors the shape of the original agent's logrus output closely enough for
// operators (key=value pairs, a level prefix and a timestamp) without pulling in
// any dependency.
package logx

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

type Level int

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

var (
	mu    sync.Mutex
	level = LevelInfo
)

// SetDebug switches the global level to debug.
func SetDebug(debug bool) {
	mu.Lock()
	defer mu.Unlock()
	if debug {
		level = LevelDebug
	} else {
		level = LevelInfo
	}
}

// SetLevel sets the global level explicitly.
func SetLevel(l Level) {
	mu.Lock()
	defer mu.Unlock()
	level = l
}

func enabled(l Level) bool {
	mu.Lock()
	defer mu.Unlock()
	return l >= level
}

func name(l Level) string {
	switch l {
	case LevelDebug:
		return "debug"
	case LevelInfo:
		return "info"
	case LevelWarn:
		return "warn"
	case LevelError:
		return "error"
	default:
		return "info"
	}
}

// kv renders alternating key/value arguments as `k=v k2=v2`.
func kv(args ...any) string {
	if len(args) == 0 {
		return ""
	}
	var b strings.Builder
	for i := 0; i < len(args); i += 2 {
		if i > 0 {
			b.WriteByte(' ')
		}
		k := fmt.Sprint(args[i])
		if i+1 < len(args) {
			b.WriteString(k)
			b.WriteByte('=')
			b.WriteString(fmt.Sprint(args[i+1]))
		} else {
			b.WriteString(k)
		}
	}
	return b.String()
}

func log(l Level, msg string, args ...any) {
	if !enabled(l) {
		return
	}
	ts := time.Now().Format("2006-01-02 15:04:05")
	line := fmt.Sprintf("%s [%s] %s", ts, name(l), msg)
	if extra := kv(args...); extra != "" {
		line += " " + extra
	}
	fmt.Fprintln(os.Stderr, line)
}

func Debug(msg string, args ...any) { log(LevelDebug, msg, args...) }
func Info(msg string, args ...any)  { log(LevelInfo, msg, args...) }
func Warn(msg string, args ...any)  { log(LevelWarn, msg, args...) }
func Error(msg string, args ...any) { log(LevelError, msg, args...) }
