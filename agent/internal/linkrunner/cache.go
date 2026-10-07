package linkrunner

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

const maxCacheBytes = 32 << 20
const maxRecords = 4096 // Tombstones count; never evict a generation fence.

type record struct {
	ID            string  `json:"id"`
	LinkID        int64   `json:"link_id"`
	WorkspaceID   int64   `json:"workspace_id"`
	NodeID        int64   `json:"node_id"`
	Role          string  `json:"role"`
	Highest       int64   `json:"highest"`
	Removed       bool    `json:"removed"`
	Fingerprint   string  `json:"fingerprint"`
	DesiredDigest string  `json:"desired_digest"`
	DesiredLease  string  `json:"desired_lease"`
	Config        *Config `json:"config,omitempty"` // Only the committed, restoreable config.
	State         string  `json:"state"`
	LastError     string  `json:"last_error,omitempty"`
	UpdateMode    string  `json:"update_mode,omitempty"`
}

// Both tombstones and secrets are authenticated together. No plaintext metadata
// can be edited to turn a deletion into an activation or change its generation.
type cacheEnvelope struct {
	Version int    `json:"version"`
	AgentID string `json:"agent_id"`
	Nonce   []byte `json:"nonce"`
	Sealed  []byte `json:"sealed"`
}

type privateCache struct {
	dir, agentID string
	aead         cipher.AEAD
	nodeDBID     int64
}

type cacheContents struct {
	NodeDBID int64             `json:"node_db_id,omitempty"`
	Records  map[string]record `json:"records"`
}

func openCache(dir, agentID string) (*privateCache, map[string]record, error) {
	if err := privateDirectory(dir); err != nil {
		return nil, nil, err
	}
	keyPath := filepath.Join(dir, "machine.key")
	key, err := readPrivateFile(keyPath, 32)
	if errors.Is(err, os.ErrNotExist) {
		// Never generate a replacement key for an existing encrypted fence.
		if _, statErr := os.Lstat(filepath.Join(dir, "state.enc.json")); !errors.Is(statErr, os.ErrNotExist) {
			return nil, nil, ErrCache
		}
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, nil, ErrCache
		}
		f, createErr := os.OpenFile(keyPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if createErr != nil {
			return nil, nil, ErrCache
		}
		_, writeErr := f.Write(key)
		syncErr := f.Sync()
		closeErr := f.Close()
		if writeErr != nil || syncErr != nil || closeErr != nil {
			return nil, nil, ErrCache
		}
	} else if err != nil {
		return nil, nil, ErrCache
	}
	if len(key) != 32 {
		return nil, nil, ErrCache
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, ErrCache
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, ErrCache
	}
	c := &privateCache{dir: dir, agentID: agentID, aead: aead}
	records, err := c.load()
	return c, records, err
}

func privateDirectory(dir string) error {
	// Reject symlinks in existing ancestors as well as in the final directory.
	for p := dir; ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
			return ErrCache
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return ErrCache
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	if os.MkdirAll(dir, 0o700) != nil || os.Chmod(dir, 0o700) != nil {
		return ErrCache
	}
	return nil
}

func readPrivateFile(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit || info.Size() <= 0 {
		return nil, ErrCache
	}
	if os.Chmod(path, 0o600) != nil {
		return nil, ErrCache
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, ErrCache
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, ErrCache
	}
	return data, nil
}

func (c *privateCache) aad() []byte { return []byte("tunex-linkrunner-cache-v1\x00" + c.agentID) }

func (c *privateCache) load() (map[string]record, error) {
	data, err := readPrivateFile(filepath.Join(c.dir, "state.enc.json"), maxCacheBytes)
	if errors.Is(err, os.ErrNotExist) {
		return make(map[string]record), nil
	}
	if err != nil {
		return nil, ErrCache
	}
	var env cacheEnvelope
	if json.Unmarshal(data, &env) != nil || env.Version != 1 {
		return nil, ErrCache
	}
	if env.AgentID != c.agentID {
		return nil, ErrAgentMismatch
	}
	if len(env.Nonce) != c.aead.NonceSize() {
		return nil, ErrCache
	}
	plain, err := c.aead.Open(nil, env.Nonce, env.Sealed, c.aad())
	if err != nil {
		return nil, ErrCache
	}
	var contents cacheContents
	if json.Unmarshal(plain, &contents) != nil || contents.Records == nil || len(contents.Records) > maxRecords || contents.NodeDBID < 0 {
		return nil, ErrCache
	}
	records := contents.Records
	c.nodeDBID = contents.NodeDBID
	for id, r := range records {
		if id == "" || r.ID != id || r.Highest <= 0 || (r.Removed && r.Config != nil) {
			return nil, ErrCache
		}
		if r.Config != nil {
			cfg := cloneConfig(*r.Config)
			if _, _, err := validateConfig(&cfg); err != nil || cfg.ID != id || cfg.Generation > r.Highest || cfg.LinkID != r.LinkID || cfg.WorkspaceID != r.WorkspaceID || cfg.NodeID != r.NodeID || cfg.Role != r.Role || (c.nodeDBID != 0 && cfg.NodeID != c.nodeDBID) {
				return nil, ErrCache
			}
			r.Config = &cfg
			records[id] = r
		}
	}
	return records, nil
}

func (c *privateCache) save(records map[string]record) error {
	plain, err := json.Marshal(cacheContents{NodeDBID: c.nodeDBID, Records: records})
	if err != nil || len(plain) > maxCacheBytes/2 {
		return ErrCache
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return ErrCache
	}
	env := cacheEnvelope{Version: 1, AgentID: c.agentID, Nonce: nonce, Sealed: c.aead.Seal(nil, nonce, plain, c.aad())}
	data, err := json.Marshal(env)
	if err != nil || len(data) > maxCacheBytes {
		return ErrCache
	}
	return atomicPrivateWrite(filepath.Join(c.dir, "state.enc.json"), data)
}

func atomicPrivateWrite(path string, data []byte) error {
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return ErrCache
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return ErrCache
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".linkrunner-*.tmp")
	if err != nil {
		return ErrCache
	}
	name := f.Name()
	defer os.Remove(name)
	defer f.Close()
	if f.Chmod(0o600) != nil {
		return ErrCache
	}
	if _, err := f.Write(data); err != nil {
		return ErrCache
	}
	if f.Sync() != nil || f.Close() != nil {
		return ErrCache
	}
	if replaceFile(name, path) != nil {
		return ErrCache
	}
	return nil
}
