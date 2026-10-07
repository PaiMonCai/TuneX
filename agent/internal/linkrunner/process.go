package linkrunner

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	startupTimeout     = 5 * time.Second
	stopTimeout        = time.Second
	updateDrainTimeout = 6 * time.Second // Imported FXP drains TCP for at most 5s.
	readyStability     = 50 * time.Millisecond
	maxLogLines        = 32
	maxLogLineBytes    = 4096
)

var listenerLog = regexp.MustCompile(`^(?:[0-9]{4}/[0-9]{2}/[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)? )?(entry|exit) (tcp|udp) listening on :([0-9]+) tunnel=([0-9]+)(?: rule=([0-9]+))?$`)
var managedLog = regexp.MustCompile(`^(?:[0-9]{4}/[0-9]{2}/[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)? )?managed (applied|rejected) sha256=([0-9a-f]{64})(?: code=(invalid|immutable|bind))?$`)

type child struct {
	cmd                                              *exec.Cmd
	path                                             string
	trafficProducer                                  string
	rotationPath                                     string
	trafficStartedAt                                 time.Time
	done                                             chan struct{}
	ready                                            chan struct{}
	leaseChanged                                     chan struct{}
	mu                                               sync.Mutex
	deadline                                         time.Time
	expected                                         map[listener]int
	remaining                                        int
	line                                             []byte
	discardLine                                      bool
	logs                                             []string
	exited, expired                                  bool
	exitCode                                         int
	managed, readyClosed, tampered                   bool
	currentDigest, pendingDigest, ackDigest, ackKind string
	ackSequence                                      uint64
	ackChanged                                       chan struct{}
	targetCounts                                     map[string]map[int64]int
	targetFacts                                      map[int64]targetFact
}

// Write deliberately drops arbitrary FXP output. Even malformed/oversized lines
// cannot copy keys, tokens, targets or config fragments into Agent diagnostics.
// Only a matched, expected listener event is retained, as reconstructed numbers.
func (p *child) Write(data []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, b := range data {
		if b == '\n' {
			if !p.discardLine {
				p.readLineLocked(strings.TrimSuffix(string(p.line), "\r"))
			}
			p.line = p.line[:0]
			p.discardLine = false
		} else if !p.discardLine {
			if len(p.line) == maxLogLineBytes {
				p.line = p.line[:0]
				p.discardLine = true
			} else {
				p.line = append(p.line, b)
			}
		}
	}
	return len(data), nil
}

func (p *child) readLineLocked(line string) {
	if p.managed && p.readTargetLineLocked(line) {
		return
	}
	if p.managed {
		if match := managedLog.FindStringSubmatch(line); match != nil {
			digest := match[2]
			if digest != p.currentDigest && digest != p.pendingDigest {
				p.tampered = true
				p.logLocked("unauthorized config change; stopping process")
				go p.stop()
				return
			}
			p.ackDigest, p.ackKind = digest, match[1]
			p.ackSequence++
			p.logLocked("managed " + match[1] + " sha256=" + digest)
			select {
			case p.ackChanged <- struct{}{}:
			default:
			}
			p.markReadyLocked()
			return
		}
	}
	match := listenerLog.FindStringSubmatch(line)
	if match == nil {
		return
	}
	port, err := strconv.Atoi(match[3])
	if err != nil {
		return
	}
	tunnel, err := strconv.ParseInt(match[4], 10, 64)
	if err != nil {
		return
	}
	var rule int64
	if match[5] != "" {
		rule, err = strconv.ParseInt(match[5], 10, 64)
		if err != nil {
			return
		}
	}
	lane := listener{match[1], match[2], port, tunnel, rule}
	if p.expected[lane] <= 0 {
		return
	}
	p.expected[lane]--
	p.remaining--
	p.logLocked(fmt.Sprintf("%s %s listener bound port=%d tunnel=%d rule=%d", lane.Role, lane.Protocol, lane.Port, lane.Tunnel, lane.Rule))
	p.markReadyLocked()
}

func (p *child) markReadyLocked() {
	if !p.readyClosed && p.remaining == 0 && (!p.managed || p.ackKind == "applied" && p.ackDigest == p.currentDigest) {
		p.readyClosed = true
		close(p.ready)
	}
}

func (p *child) logLocked(line string) {
	if len(p.logs) == maxLogLines {
		copy(p.logs, p.logs[1:])
		p.logs = p.logs[:maxLogLines-1]
	}
	p.logs = append(p.logs, line)
}

func startChild(binaryPath, runtimeDir string, cfg Config, deadline time.Time, expected []listener, options ...childTraffic) (*child, error) {
	if !time.Now().Before(deadline) {
		return nil, ErrLeaseExpired
	}
	sum := sha256.Sum256([]byte(cfg.ID))
	f, err := os.CreateTemp(runtimeDir, fmt.Sprintf("fxp-%x-*.json", sum[:8]))
	if err != nil {
		return nil, ErrStartFailed
	}
	path := f.Name()
	remove := true
	defer func() {
		_ = f.Close()
		if remove {
			_ = os.Remove(path)
		}
	}()
	if f.Chmod(0o600) != nil {
		return nil, ErrStartFailed
	}
	if _, err := f.Write(cfg.RunnerConfig); err != nil {
		return nil, ErrStartFailed
	}
	if f.Sync() != nil || f.Close() != nil {
		return nil, ErrStartFailed
	}
	p := &child{path: path, done: make(chan struct{}), ready: make(chan struct{}), leaseChanged: make(chan struct{}, 1), deadline: deadline, expected: make(map[listener]int)}
	p.managed = managedConfig(cfg.RunnerConfig)
	p.currentDigest = cfg.ConfigDigest
	p.ackChanged = make(chan struct{}, 1)
	for _, lane := range expected {
		p.expected[lane]++
		p.remaining++
	}
	var traffic childTraffic
	if len(options) > 0 {
		traffic = options[0]
	}
	args := []string{"-config", filepath.Clean(path)}
	p.setTargetConfig(cfg)
	if traffic.producer != "" {
		args = append(args, "-managed-traffic", traffic.path, "-managed-traffic-producer", traffic.producer)
		p.trafficProducer = traffic.producer
		p.trafficStartedAt = time.Now().UTC()
		if traffic.rotationPath != "" {
			p.rotationPath = traffic.rotationPath
			args = append(args, "-managed-traffic-rotation-v1", traffic.rotationPath)
		}
	}
	if traffic.targetsEnabled {
		args = append(args, "-managed-targets-v1")
	}
	p.cmd = exec.Command(binaryPath, args...)
	p.cmd.Stdout = p
	p.cmd.Stderr = p
	p.cmd.WaitDelay = stopTimeout
	// FXP needs no Agent auth secret. Cache encryption is wholly independent.
	for _, env := range os.Environ() {
		name, _, _ := strings.Cut(env, "=")
		if !strings.EqualFold(name, "AUTH_SECRET") && !(traffic.enabled && strings.EqualFold(name, "NODE_CREDENTIAL")) {
			p.cmd.Env = append(p.cmd.Env, env)
		}
	}
	attach, release, err := containProcess(p.cmd)
	if err != nil {
		return nil, ErrStartFailed
	}
	if err := p.cmd.Start(); err != nil {
		release()
		return nil, ErrStartFailed
	}
	if err := attach(); err != nil {
		_ = p.cmd.Process.Kill()
		_ = p.cmd.Wait()
		release()
		return nil, ErrStartFailed
	}
	remove = false
	go func() {
		_ = p.cmd.Wait()
		release()
		_ = os.Remove(p.path)
		if p.rotationPath != "" {
			_ = os.Remove(p.rotationPath)
		}
		p.mu.Lock()
		p.exited = true
		p.exitCode = p.cmd.ProcessState.ExitCode()
		p.line = nil // No partial child output survives exit.
		p.mu.Unlock()
		close(p.done)
	}()
	go p.watchLease()
	timer := time.NewTimer(startupTimeout)
	defer timer.Stop()
	select {
	case <-p.ready:
		stable := time.NewTimer(readyStability)
		defer stable.Stop()
		select {
		case <-stable.C:
		case <-p.done:
			return p, p.failure()
		}
		p.mu.Lock()
		expired := p.expired || !time.Now().Before(p.deadline)
		exited := p.exited
		p.mu.Unlock()
		if expired {
			_ = p.stop()
			return p, ErrLeaseExpired
		}
		if exited {
			return p, ErrProcessExited
		}
		// Managed FXP watches this private stable file until exit. Legacy runs
		// read only at startup, so their plaintext file can be removed now.
		if !p.managed {
			_ = os.Remove(p.path)
		}
		if !p.live() {
			return p, p.failure()
		}
		return p, nil
	case <-p.done:
		return p, p.failure()
	case <-timer.C:
		_ = p.stop()
		return p, ErrReadyTimeout
	}
}

func (p *child) failure() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.tampered {
		return ErrConfigTampered
	}
	if p.expired || !time.Now().Before(p.deadline) {
		return ErrLeaseExpired
	}
	return ErrProcessExited
}

func (p *child) renew(deadline time.Time) bool {
	p.mu.Lock()
	if p.expired || p.exited || p.tampered || !time.Now().Before(p.deadline) {
		p.mu.Unlock()
		return false
	}
	p.deadline = deadline
	p.mu.Unlock()
	select {
	case p.leaseChanged <- struct{}{}:
	default:
	}
	return true
}

func (p *child) watchLease() {
	for {
		p.mu.Lock()
		deadline := p.deadline
		p.mu.Unlock()
		timer := time.NewTimer(time.Until(deadline))
		select {
		case <-p.done:
			timer.Stop()
			return
		case <-p.leaseChanged:
			timer.Stop()
		case <-timer.C:
			p.mu.Lock()
			if time.Now().Before(p.deadline) {
				p.mu.Unlock()
				continue
			}
			p.expired = true
			p.logLocked("lease expired; stopping process")
			p.mu.Unlock()
			_ = p.stop()
			return
		}
	}
}

func (p *child) stop() error {
	return p.stopWithGrace(stopTimeout)
}

func (p *child) stopWithGrace(grace time.Duration) error {
	// Concurrent lease expiry can shorten an update drain. Do not hold a lock
	// across grace timers: that would accidentally extend an expired lease.
	select {
	case <-p.done:
		return nil
	default:
	}
	_ = signalStop(p.cmd.Process)
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-p.done:
		return nil
	case <-timer.C:
	}
	if err := p.cmd.Process.Kill(); err != nil && err != os.ErrProcessDone {
		return ErrProcessExited
	}
	killTimer := time.NewTimer(stopTimeout)
	defer killTimer.Stop()
	select {
	case <-p.done:
		return nil
	case <-killTimer.C:
		return ErrProcessExited
	}
}

func (p *child) live() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return !p.exited && !p.expired && !p.tampered && time.Now().Before(p.deadline)
}
